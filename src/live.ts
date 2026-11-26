// What scripts/live/deploy.ts and scripts/live/smoke.ts do, as functions that take a signer.
//
// The scripts themselves only pass the guard, connect, and call these. Keeping the logic here lets the tests
// run exactly this code on a local EVM (with a mock token, and on a fork of QIE mainnet), so the first time it
// meets a real network it has already run end to end. Nothing in this file reads the environment's private key.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Contract, ContractFactory, TypedDataEncoder, Wallet, getAddress, id, hexlify, randomBytes } from "ethers";
import type { ContractTransactionReceipt, Provider, Signer } from "ethers";
import { dyn } from "./dyn";
import type { Dyn } from "./dyn";
import { EVENTS } from "./events";
import type { EvidenceRow, Network } from "./evidence";
import { GuardError, MAX_GAS_PRICE_WEI, QUSDC_ADDRESS } from "./guard";
import type { Plan, SpendMeter } from "./guard";
import { formatQusdc } from "./units";

/** The most gas any one transaction in a live script may be given. */
export const DEPLOY_GAS_LIMIT = 4_000_000n;
export const TX_GAS_LIMIT = 1_000_000n;
/** approve, deposit, settle, authorize, settle by the agent, revoke, withdraw, refund. */
export const SMOKE_TX_COUNT = 8n;

export type Env = Record<string, string | undefined>;

export type LiveContext = {
  signer: Signer;
  provider: Provider;
  meter: SpendMeter;
  network: Network;
  log: (line: string) => void;
};

type ArtifactJson = { abi: unknown[]; bytecode: string; deployedBytecode: string };

/** `folder` is the sub-folder of contracts/ the file is in, like "test" for the test contracts. */
export function loadArtifact(name: string, folder = ""): ArtifactJson {
  const file = join(__dirname, "..", "artifacts", "contracts", ...(folder ? [folder] : []), `${name}.sol`, `${name}.json`);
  return JSON.parse(readFileSync(file, "utf8")) as ArtifactJson;
}

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

const PAYMENT_TYPES = {
  Payment: [
    { name: "payer", type: "address" },
    { name: "payee", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "toolId", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
};

// ------------------------------------------------------------------------------------------- plans

export function deployPlan(): Plan {
  return {
    qusdc: 0n,
    qieWei: DEPLOY_GAS_LIMIT * MAX_GAS_PRICE_WEI,
    summary: "deploy one PaymentRouter (which creates its AgentVault); no QUSDC moves",
  };
}

export type SmokeAmounts = {
  /** Put into the prepaid balance, and the most QUSDC the run ever takes out of the wallet. */
  deposit: bigint;
  /** The payer-signed call. */
  call: bigint;
  /** The agent-signed call. */
  agentCall: bigint;
  /** The agent's budget and per-call cap. */
  agentBudget: bigint;
  agentCap: bigint;
};

export const DEFAULT_SMOKE_AMOUNTS: SmokeAmounts = {
  deposit: 300_000n, // 0.300000 QUSDC
  call: 100_000n, // 0.100000
  agentCall: 50_000n, // 0.050000
  agentBudget: 100_000n, // 0.100000
  agentCap: 50_000n, // 0.050000
};

export function checkSmokeAmounts(a: SmokeAmounts): void {
  const ok =
    a.call > 0n &&
    a.agentCall > 0n &&
    a.agentCall <= a.agentCap &&
    a.agentCap <= a.agentBudget &&
    a.call + a.agentCall <= a.deposit;
  if (!ok) throw new GuardError("smoke amounts are inconsistent: need agentCall <= agentCap <= agentBudget and call + agentCall <= deposit");
}

export function smokePlan(a: SmokeAmounts = DEFAULT_SMOKE_AMOUNTS): Plan {
  checkSmokeAmounts(a);
  return {
    qusdc: a.deposit,
    qieWei: SMOKE_TX_COUNT * TX_GAS_LIMIT * MAX_GAS_PRICE_WEI,
    summary: `approve and deposit ${formatQusdc(a.deposit)} QUSDC, settle two calls, authorise and revoke one agent, then withdraw and refund`,
  };
}

// ------------------------------------------------------------------------------------ parameters

export type DeployParams = { token: string; owner: string; feeRecipient: string; feeBps: number };

function address(env: Env, name: string, fallback?: string): string {
  const raw = env[name]?.trim() || fallback;
  if (!raw) throw new GuardError(`${name} must be set to an address`);
  try {
    return getAddress(raw);
  } catch {
    throw new GuardError(`${name} is not a valid address`);
  }
}

/** The fee when SLUICE_FEE_BPS is not set: 1%. The contract refuses more than 200 basis points (2%). */
export const DEFAULT_FEE_BPS = 100;
export const MAX_FEE_BPS = 200;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * The owner and the fee recipient have no defaults: they must be chosen on purpose, and neither may be the zero address (an owner there
 * could never change the fee; a fee recipient there would credit fees nobody can withdraw). The fee defaults to 1%. The token is QUSDC
 * on mainnet and nothing else.
 */
export function readDeployParams(env: Env, network: Network): DeployParams {
  const token = address(env, "SLUICE_TOKEN", network === "mainnet" ? QUSDC_ADDRESS : undefined);
  // On mainnet the token is QUSDC and nothing else: a typo here would lock real funds in the wrong asset.
  if (network === "mainnet" && token !== getAddress(QUSDC_ADDRESS)) {
    throw new GuardError("on mainnet SLUICE_TOKEN must be left empty or be the QUSDC address");
  }
  const owner = address(env, "SLUICE_OWNER");
  const feeRecipient = address(env, "SLUICE_FEE_RECIPIENT");
  if (owner === ZERO_ADDRESS) throw new GuardError("SLUICE_OWNER is the zero address: nobody could ever change the fee. Name the multisig that should own the router");
  if (feeRecipient === ZERO_ADDRESS) throw new GuardError("SLUICE_FEE_RECIPIENT is the zero address: fees would be credited to an address nobody controls");
  const rawFee = env.SLUICE_FEE_BPS?.trim();
  if (rawFee && (!/^\d{1,3}$/.test(rawFee) || Number(rawFee) > MAX_FEE_BPS)) {
    throw new GuardError(`SLUICE_FEE_BPS must be a whole number from 0 to ${MAX_FEE_BPS} (it is in basis points: 100 is 1%)`);
  }
  return { token, owner, feeRecipient, feeBps: rawFee ? Number(rawFee) : DEFAULT_FEE_BPS };
}

/**
 * Keeps the roles apart. The deployer key is a hot key that is used once, the relayer key is a hot key that pays gas, and the router's owner
 * and fee recipient are for an account that holds control, ideally a multisig. A deployment that makes either of the first two the owner or
 * the fee recipient is refused, whatever the network, and says which. On mainnet the relayer's address must be given too, so that this check
 * cannot be skipped by leaving it out; elsewhere it is checked when it is given.
 */
export function checkDeployRoles(params: DeployParams, who: { deployer: string; relayer?: string }, network: Network): void {
  const deployer = getAddress(who.deployer);
  if (network === "mainnet" && !who.relayer) {
    throw new GuardError("on mainnet, give the relayer's address (SLUICE_RELAYER, or --relayer) so the deploy can check it is not the owner or the fee recipient");
  }
  const relayer = who.relayer ? getAddress(who.relayer) : undefined;
  if (relayer && relayer === deployer) throw new GuardError("the deployer key and the relayer are the same address: the relayer is a hot key that holds only gas money and needs a key of its own");
  const owner = getAddress(params.owner);
  const feeRecipient = getAddress(params.feeRecipient);
  if (owner === deployer) throw new GuardError("SLUICE_OWNER is the deployer key's own address: the deployer is a hot key, and the owner should be an account that holds control, such as a multisig");
  if (feeRecipient === deployer) throw new GuardError("SLUICE_FEE_RECIPIENT is the deployer key's own address: choose the account that should receive the fees");
  if (relayer && owner === relayer) throw new GuardError("SLUICE_OWNER is the relayer's address: the facilitator refuses to run as the router's owner, and a hot key must not hold control");
  if (relayer && feeRecipient === relayer) throw new GuardError("SLUICE_FEE_RECIPIENT is the relayer's address: the facilitator refuses to run as the fee recipient");
}

/** The token must be a contract with six decimals. Reads only. Called before anything is sent, so a wrong address costs nothing. */
export async function checkDeployToken(provider: Provider, token: string): Promise<void> {
  const where = getAddress(token);
  if ((await provider.getCode(where)) === "0x") throw new GuardError(`there is no contract at the token address ${where} on this chain`);
  let decimals: bigint;
  try {
    decimals = (await new Contract(where, ERC20_ABI, provider).getFunction("decimals")()) as bigint;
  } catch {
    throw new GuardError(`the token at ${where} did not answer decimals(), so it is not an ERC-20 token this router can hold`);
  }
  if (Number(decimals) !== 6) throw new GuardError(`the token at ${where} has ${decimals} decimals, and Sluice needs 6`);
}

export type SmokeParams = { router: string; payee?: string };

export function readSmokeParams(env: Env): SmokeParams {
  const router = address(env, "SLUICE_ROUTER");
  const payee = env.SLUICE_PAYEE?.trim() ? address(env, "SLUICE_PAYEE") : undefined;
  return payee ? { router, payee } : { router };
}

// --------------------------------------------------------------------------------------- sending

async function gasPriceOf(provider: Provider): Promise<bigint> {
  const price = (await provider.getFeeData()).gasPrice;
  if (price === null || price === undefined || price <= 0n) throw new Error("the node did not give a gas price");
  return price;
}

/** Sends one contract call under the meter: estimate, reserve, send, confirm, record. */
async function call(
  ctx: LiveContext,
  label: string,
  contract: Dyn,
  method: string,
  args: unknown[],
): Promise<ContractTransactionReceipt> {
  const gasPrice = await gasPriceOf(ctx.provider);
  const fn = contract.getFunction(method);
  const estimate = await fn.estimateGas(...args);
  const gasLimit = (estimate * 12n) / 10n;
  if (gasLimit > TX_GAS_LIMIT) throw new GuardError(`${label}: needs more gas than the ${TX_GAS_LIMIT} allowed per call`);
  ctx.meter.beforeSend(gasLimit, gasPrice);
  const tx = await fn(...args, { gasLimit, gasPrice });
  const receipt = (await tx.wait()) as ContractTransactionReceipt | null;
  if (!receipt || receipt.status !== 1) throw new Error(`${label}: the transaction failed (${tx.hash})`);
  ctx.meter.afterSend(gasLimit, gasPrice, receipt.gasUsed, receipt.gasPrice);
  ctx.log(`${label}: ${receipt.hash} in block ${receipt.blockNumber}`);
  return receipt;
}

/** The rows for docs/EVIDENCE.md that a receipt supports: one per recorded event from `contract`. */
async function evidenceFrom(
  ctx: LiveContext,
  receipt: ContractTransactionReceipt,
  contract: Dyn,
): Promise<EvidenceRow[]> {
  const block = await ctx.provider.getBlock(receipt.blockNumber);
  if (!block) throw new Error("block not found");
  const date = new Date(block.timestamp * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const rows: EvidenceRow[] = [];
  const target = (await contract.getAddress()).toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== target) continue;
    const parsed = contract.interface.parseLog({ topics: [...log.topics], data: log.data });
    const spec = parsed ? EVENTS[parsed.name] : undefined;
    if (!parsed || !spec) continue;
    rows.push({
      network: ctx.network,
      date,
      event: parsed.name,
      hash: receipt.hash,
      block: String(receipt.blockNumber),
      contract: getAddress(log.address),
      amount: spec.amountField ? formatQusdc(BigInt(parsed.args[spec.amountField])) : "—",
      who: getAddress(String(parsed.args[spec.whoField])),
    });
  }
  return rows;
}

// -------------------------------------------------------------------------------------- deploy

export type Deployed = { router: string; vault: string; hash: string; block: number };

export async function deployRouter(ctx: LiveContext, p: DeployParams): Promise<Deployed> {
  if (p.feeBps > MAX_FEE_BPS) throw new GuardError(`fee above the ${MAX_FEE_BPS} bps cap`);
  await checkDeployToken(ctx.provider, p.token);
  const { abi, bytecode, deployedBytecode } = loadArtifact("PaymentRouter");
  const vaultAbi = loadArtifact("AgentVault").abi;
  const factory = new ContractFactory(abi as never, bytecode, ctx.signer);
  const tx = await factory.getDeployTransaction(p.token, p.owner, p.feeRecipient, p.feeBps);
  const gasPrice = await gasPriceOf(ctx.provider);
  const estimate = await ctx.signer.estimateGas(tx);
  const gasLimit = (estimate * 12n) / 10n;
  if (gasLimit > DEPLOY_GAS_LIMIT) throw new GuardError("the deployment needs more gas than allowed");
  ctx.meter.beforeSend(gasLimit, gasPrice);
  const response = await ctx.signer.sendTransaction({ ...tx, gasLimit, gasPrice });
  const receipt = await response.wait();
  if (!receipt || receipt.status !== 1 || !receipt.contractAddress) throw new Error(`the deployment failed (${response.hash})`);
  ctx.meter.afterSend(gasLimit, gasPrice, receipt.gasUsed, receipt.gasPrice);

  // Read it back: what is on chain must be what was asked for.
  const router = dyn(new Contract(receipt.contractAddress, abi as never, ctx.provider));
  const checks: Array<[string, unknown, unknown]> = [
    ["token", getAddress(await router.token()), getAddress(p.token)],
    ["owner", getAddress(await router.owner()), getAddress(p.owner)],
    ["fee recipient", getAddress(await router.feeRecipient()), getAddress(p.feeRecipient)],
    ["fee bps", Number(await router.feeBps()), p.feeBps],
    ["max fee bps", Number(await router.MAX_FEE_BPS()), MAX_FEE_BPS],
  ];
  for (const [name, got, want] of checks) {
    if (got !== want) throw new Error(`deployed router has the wrong ${name}`);
  }
  const code = await ctx.provider.getCode(receipt.contractAddress);
  if (code.length !== deployedBytecode.length) throw new Error("deployed code is not the compiled runtime code");
  const vault = await router.vault();
  const vaultContract = dyn(new Contract(vault, vaultAbi as never, ctx.provider));
  if (getAddress(await vaultContract.router()) !== getAddress(receipt.contractAddress)) {
    throw new Error("the vault does not point back at the router");
  }
  ctx.log(`router ${receipt.contractAddress}`);
  ctx.log(`vault  ${vault}`);
  return { router: receipt.contractAddress, vault, hash: receipt.hash, block: receipt.blockNumber };
}

// --------------------------------------------------------------------------------------- smoke

/** `stillOwed` is what the router owes after the run: the fee recipient's fees, and the payee's earnings if the payee is another address. */
export type SmokeResult = { rows: EvidenceRow[]; stillOwed: bigint };

/**
 * One full round trip with small amounts: approve, deposit, a payer-signed settle, an agent session with its
 * own signed settle, revoke, withdraw and refund. Returns the evidence rows its transactions support.
 */
export async function runSmoke(
  ctx: LiveContext,
  p: SmokeParams,
  amounts: SmokeAmounts = DEFAULT_SMOKE_AMOUNTS,
): Promise<SmokeResult> {
  checkSmokeAmounts(amounts);
  const routerAbi = loadArtifact("PaymentRouter").abi as never;
  const vaultAbi = loadArtifact("AgentVault").abi as never;
  const payer = await ctx.signer.getAddress();
  const payee = p.payee ?? payer;
  const router = dyn(new Contract(p.router, routerAbi, ctx.signer));
  const chainId = (await ctx.provider.getNetwork()).chainId;
  const domain = { name: "SluiceRouter", version: "1", chainId, verifyingContract: p.router };
  // Wrong address, wrong chain or not a Sluice router: the domain separator would differ.
  if ((await router.domainSeparator()) !== TypedDataEncoder.hashDomain(domain)) {
    throw new GuardError("SLUICE_ROUTER is not a Sluice router on this chain");
  }
  const token = dyn(new Contract(await router.token(), ERC20_ABI, ctx.signer));
  if (Number(await token.decimals()) !== 6) throw new GuardError("the router's token does not have 6 decimals");
  if ((await token.balanceOf(payer)) < amounts.deposit) throw new GuardError("the signer holds less QUSDC than the deposit");
  const vault = dyn(new Contract(await router.vault(), vaultAbi, ctx.signer));

  const rows: EvidenceRow[] = [];
  const nowSeconds = async () => BigInt((await ctx.provider.getBlock("latest"))!.timestamp);
  const toolId = id("sluice-smoke");

  // 1. Approve exactly the deposit, then deposit it.
  ctx.meter.beforeQusdc(amounts.deposit);
  await call(ctx, "approve", token, "approve", [p.router, amounts.deposit]);
  rows.push(...(await evidenceFrom(ctx, await call(ctx, "deposit", router, "deposit", [amounts.deposit]), router)));

  // 2. A call the payer signs.
  const first = {
    payer,
    payee,
    amount: amounts.call,
    toolId,
    nonce: hexlify(randomBytes(32)),
    deadline: (await nowSeconds()) + 3600n,
  };
  const firstSig = await ctx.signer.signTypedData(domain, PAYMENT_TYPES, first);
  rows.push(...(await evidenceFrom(ctx, await call(ctx, "settle (payer-signed)", router, "settle", [first, firstSig]), router)));

  // 3. A call an agent signs under a session: a throwaway key that never holds anything and is never printed.
  const agent = Wallet.createRandom();
  const grant = {
    agent: agent.address,
    budget: amounts.agentBudget,
    perCallCap: amounts.agentCap,
    expiry: (await nowSeconds()) + 3600n,
  };
  rows.push(...(await evidenceFrom(ctx, await call(ctx, "authorize agent", vault, "authorize", [grant, [{ payee, toolId }]]), vault)));
  const second = { ...first, amount: amounts.agentCall, nonce: hexlify(randomBytes(32)), deadline: (await nowSeconds()) + 3600n };
  const secondSig = await agent.signTypedData(domain, PAYMENT_TYPES, second);
  rows.push(...(await evidenceFrom(ctx, await call(ctx, "settle (agent-signed)", router, "settle", [second, secondSig]), router)));
  rows.push(...(await evidenceFrom(ctx, await call(ctx, "revoke agent", vault, "revoke", [agent.address]), vault)));

  // 4. Take everything back out: the builder's earnings (if the payee is this signer), then the unspent balance.
  const earned: bigint = await router.earnings(payee);
  if (payee === payer && earned > 0n) {
    rows.push(...(await evidenceFrom(ctx, await call(ctx, "withdraw", router, "withdraw", [earned, payer]), router)));
  } else {
    ctx.log(`payee ${payee} must withdraw its own ${formatQusdc(earned)} QUSDC; this signer cannot`);
  }
  const left: bigint = await router.payerBalance(payer);
  if (left > 0n) {
    rows.push(...(await evidenceFrom(ctx, await call(ctx, "refund", router, "refund", [left, payer]), router)));
  }

  const [held, owed] = (await router.solvency()) as [bigint, bigint];
  if (held < owed) throw new Error("the router holds less than it owes");
  ctx.log(`QUSDC moved out of the wallet: ${formatQusdc(ctx.meter.movedQusdc)}; QIE spent on gas (wei): ${ctx.meter.spentQie}`);
  return { rows, stillOwed: owed };
}

/** Evidence rows as the lines to paste into docs/EVIDENCE.md. */
export function evidenceLines(rows: EvidenceRow[]): string[] {
  return rows.map((r) => `| ${[r.date, r.event, r.hash, r.block, r.contract, r.amount, r.who].join(" | ")} |`);
}

// ------------------------------------------------------------------------------------------ recording

/** The recorder's claim for a smoke-run event, when there is one. A payer-signed settle was submitted by the payer, so it is not a facilitator's paid call. */
const CLAIM_FOR_EVENT: Readonly<Record<string, string>> = { Deposited: "deposit", Withdrawn: "withdraw", Refunded: "refund" };

/**
 * The commands that record what a run did, one per transaction that a claim type covers. Nothing is pasted into docs/EVIDENCE.md by hand:
 * the recorder reads each transaction back from the chain and writes the row only if the chain agrees. A transaction no claim type covers
 * is listed, so it is not forgotten, and says why it is not recorded.
 */
export function recorderCommands(rows: EvidenceRow[], router: string, network: Network): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const key = `${r.event}|${r.hash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const claim = CLAIM_FOR_EVENT[r.event];
    out.push(
      claim
        ? `pnpm evidence:record --claim ${claim} --tx ${r.hash} --network ${network} --router ${router}`
        : `# ${r.event} ${r.hash}: no claim type covers it, so it is not recorded (settlements are recorded from the facilitator's batches, see docs/MAINNET-RUNBOOK.md)`,
    );
  }
  return out;
}

/** The commands that record a deployment and, once the explorer shows its source, the verification. */
export function deployRecorderCommands(hash: string, network: Network): string[] {
  return [
    `pnpm evidence:record --claim deploy --tx ${hash} --network ${network}`,
    `pnpm evidence:record --claim verify-link --tx ${hash} --network ${network}   # after the explorer shows verified source`,
  ];
}

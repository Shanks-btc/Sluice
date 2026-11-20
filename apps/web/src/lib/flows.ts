// The five things a person can do from the app: deposit, withdraw, refund, authorise an agent key and revoke one.
//
// Each flow is first PLANNED. A plan holds everything the wallet will be asked to approve, in words (amounts, addresses, the
// network, the fee), and it is built from the same input the flow later executes, so what is shown is what is sent. Nothing reaches
// the wallet until the person confirms the plan: a FlowSession will not send from any state but "confirmed", and a test holds it to that.
//
// The app never sees a private key. The wallet signs and sends; for a wallet that holds no QIE, the signed message or the signed
// transactions go to a facilitator, which pays the gas (docs/SPEC.md, "Starting with no QIE").
import { Interface, Transaction, TypedDataEncoder, ZeroHash, getAddress, hexlify, randomBytes, verifyTypedData } from "ethers";
import { erc20Interface, routerInterface } from "@sluice/sdk/abi";
import { AUTHORIZE_TYPES, REVOKE_TYPES, vaultDomain } from "@sluice/sdk/authorize";
import type { RelayRequest, RelayResponse, OnboardRequest, OnboardResponse } from "@sluice/sdk/facilitator-client";
import { ONBOARD_APPROVE_GAS, ONBOARD_DEPOSIT_GAS } from "@sluice/sdk/onboarding";
import { routerDomain, toolIdOf } from "@sluice/sdk/protocol";
import { WalletError, classifyWalletError, describeWalletError, networkState } from "./eip1193";
import type { Eip1193Provider } from "./eip1193";
import { formatGwei, formatQie, formatUsdc, formatUtc, isAddress } from "./format";
import { networkFor } from "./networks";
import type { ChainReader } from "./reads";

// ---------------------------------------------------------------------------------------------- shared types

export type FlowKind = "deposit" | "withdraw" | "refund" | "authorize" | "revoke";
export type Route = "wallet" | "facilitator";
export type Field = { label: string; value: string };

export type Gas = { units: bigint; priceWei: bigint; costWei: bigint };

export type ToolGrant = { payee: string; toolName: string; anyTool?: boolean };

export type PlanInput =
  | { kind: "deposit"; route: Route; amount: bigint; needsApprove: boolean; gasPrice: bigint }
  | { kind: "withdraw" | "refund"; route: Route; amount: bigint; to: string }
  | { kind: "authorize"; route: Route; agent: string; budget: bigint; perCallCap: bigint; expiry: number; tools: Array<{ payee: string; toolId: string }> }
  | { kind: "revoke"; route: Route; agent: string };

export type Plan = {
  kind: FlowKind;
  route: Route;
  title: string;
  summary: string;
  /** What the wallet will be asked to approve, in words. Shown before the wallet is opened. */
  fields: Field[];
  /** What happens, in order. */
  steps: string[];
  warnings: string[];
  gas?: Gas;
  input: PlanInput;
};

export type PlanResult = { ok: true; plan: Plan } | { ok: false; reason: string };

/** A facilitator, as far as the flows need it. The SDK's FacilitatorClient satisfies this. */
export type FacilitatorPort = {
  onboard(request: OnboardRequest): Promise<OnboardResponse>;
  relay(request: RelayRequest): Promise<RelayResponse>;
};

export type FlowDeps = {
  wallet: Eip1193Provider;
  /** The connected account. */
  account: string;
  chainId: number;
  reader: ChainReader;
  facilitator?: FacilitatorPort;
  /** The facilitator's address, for the plan to name. */
  facilitatorUrl?: string | null;
  /** Unix seconds. */
  now: () => number;
  random?: () => string;
  sleep?: (ms: number) => Promise<void>;
};

export type FlowResult = { via: Route; transactions: string[]; detail?: string };

export class NotConfirmedError extends Error {
  constructor() {
    super("the plan was not confirmed, so nothing was sent");
    this.name = "NotConfirmedError";
  }
}

// ------------------------------------------------------------------------------------------ the typed messages

export const WITHDRAW_TYPES: Record<string, Array<{ name: string; type: string }>> = {
  Withdraw: [
    { name: "account", type: "address" },
    { name: "to", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "relayerFee", type: "uint256" },
    { name: "nonce", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
};

export const REFUND_TYPES: Record<string, Array<{ name: string; type: string }>> = {
  Refund: [
    { name: "payer", type: "address" },
    { name: "to", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "relayerFee", type: "uint256" },
    { name: "nonce", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
};

/** The direct calls, which the SDK's interfaces do not hold. A test compares them with the compiled contracts. */
export const DIRECT_ABI = [
  "function withdraw(uint256 amount, address to)",
  "function refund(uint256 amount, address to)",
  "function authorize(tuple(address agent, uint256 budget, uint256 perCallCap, uint256 expiry) grant, tuple(address payee, bytes32 toolId)[] tools)",
  "function revoke(address agent)",
] as const;
export const directInterface = new Interface(DIRECT_ABI as unknown as string[]);

/** How long a signed request stays valid. */
export const SIGNATURE_LIFETIME_SECONDS = 3600;

// ------------------------------------------------------------------------------------------------- helpers

const usdc = (units: bigint) => `${formatUsdc(units)} QUSDC`;

const networkLine = (chainId: number, rpcUrl?: string): string => {
  const n = networkFor(chainId, rpcUrl);
  return `${n.label}, chain ${chainId}${n.realFunds ? " (real funds)" : " (no real funds)"}`;
};

async function gasPriceOf(reader: ChainReader): Promise<bigint> {
  const fee = await reader.provider.getFeeData();
  const price = fee.gasPrice ?? 0n;
  if (price <= 0n) throw new Error("the network did not report a gas price");
  return price;
}

function gasLine(gas: Gas, upTo: boolean): string {
  return `${upTo ? "up to " : "about "}${formatQie(gas.costWei)} QIE (${gas.units.toString()} gas at ${formatGwei(gas.priceWei)} gwei)`;
}

const wrongNetwork = (deps: FlowDeps, walletChain: number | null): string | undefined =>
  networkState(walletChain, deps.chainId) === "wrong" ? "The wallet is on a different network than this page." : undefined;

// ------------------------------------------------------------------------------------------------ planning

export async function planDeposit(deps: FlowDeps, amount: bigint): Promise<PlanResult> {
  if (amount <= 0n) return { ok: false, reason: "The amount must be above zero." };
  const { reader, account } = deps;
  const [balance, allowance, qie, gasPrice] = await Promise.all([
    reader.token.getFunction("balanceOf")(account) as Promise<bigint>,
    reader.token.getFunction("allowance")(account, reader.routerAddress) as Promise<bigint>,
    reader.provider.getBalance(account),
    gasPriceOf(reader),
  ]);
  if (amount > balance) return { ok: false, reason: `Your wallet holds ${usdc(balance)}, which is less than ${usdc(amount)}.` };
  const needsApprove = allowance < amount;
  const units = (needsApprove ? ONBOARD_APPROVE_GAS : 0n) + ONBOARD_DEPOSIT_GAS;
  const gas: Gas = { units, priceWei: gasPrice, costWei: units * gasPrice };
  const network = networkLine(deps.chainId);

  if (qie >= gas.costWei) {
    return {
      ok: true,
      plan: {
        kind: "deposit",
        route: "wallet",
        title: "Deposit QUSDC",
        summary: "Your wallet will send the transactions itself and pay the network fee in QIE.",
        fields: [
          { label: "Action", value: "Deposit into the Sluice router" },
          { label: "Amount", value: usdc(amount) },
          { label: "From", value: account },
          { label: "Router", value: reader.routerAddress },
          { label: "Token", value: `${reader.tokenAddress} (QUSDC)` },
          { label: "Approval", value: needsApprove ? `Approve the router to move exactly ${usdc(amount)}` : "Already approved for this amount" },
          { label: "Network", value: network },
          { label: "Network fee", value: gasLine(gas, true) },
        ],
        steps: [...(needsApprove ? [`Approve ${usdc(amount)} for the router (transaction 1)`] : []), `Deposit ${usdc(amount)} (transaction ${needsApprove ? 2 : 1})`],
        warnings: ["A deposit stays yours: you can refund the unspent part at any time."],
        gas,
        input: { kind: "deposit", route: "wallet", amount, needsApprove, gasPrice },
      },
    };
  }

  // No QIE for gas. Option C: the wallet signs the approval and the deposit, and a facilitator sends them and tops up exactly the gas.
  if (!deps.facilitator) {
    return {
      ok: false,
      reason:
        "This wallet holds no QIE for gas, and no facilitator is set. Add a little QIE, or set a facilitator address so it can send the deposit for you.",
    };
  }
  const topUp = (ONBOARD_APPROVE_GAS + ONBOARD_DEPOSIT_GAS) * gasPrice;
  return {
    ok: true,
    plan: {
      kind: "deposit",
      route: "facilitator",
      title: "Deposit QUSDC with no QIE",
      summary:
        "Your wallet holds QUSDC and no QIE. It will sign two transactions without sending them. A facilitator checks them, sends the exact gas to your wallet, and broadcasts them.",
      fields: [
        { label: "Action", value: "Deposit into the Sluice router, sent by a facilitator" },
        { label: "Amount", value: usdc(amount) },
        { label: "From", value: account },
        { label: "Router", value: reader.routerAddress },
        { label: "Signed 1", value: `approve(router, ${usdc(amount)}), gas limit ${ONBOARD_APPROVE_GAS.toString()}` },
        { label: "Signed 2", value: `deposit(${usdc(amount)}), gas limit ${ONBOARD_DEPOSIT_GAS.toString()}` },
        { label: "Gas top-up", value: `${formatQie(topUp)} QIE, sent by the facilitator to your wallet (${(ONBOARD_APPROVE_GAS + ONBOARD_DEPOSIT_GAS).toString()} gas at ${formatGwei(gasPrice)} gwei)` },
        { label: "Facilitator", value: deps.facilitatorUrl ?? "the configured facilitator" },
        { label: "Network", value: network },
      ],
      steps: [
        "Your wallet signs the approval and the deposit (nothing is sent by the wallet)",
        "The facilitator checks every byte of both, then sends you the exact gas",
        "The facilitator broadcasts the two signed transactions",
      ],
      warnings: [
        "Few wallets can sign a transaction without sending it. If yours cannot, the app tells you and sends nothing.",
        "The facilitator can decline. A signed transaction only does what it says: approve this router for this amount, then deposit it.",
      ],
      input: { kind: "deposit", route: "facilitator", amount, needsApprove: true, gasPrice },
    },
  };
}

type ExitKind = "withdraw" | "refund";

export async function planExit(deps: FlowDeps, kind: ExitKind, amount: bigint, to: string): Promise<PlanResult> {
  if (amount <= 0n) return { ok: false, reason: "The amount must be above zero." };
  if (!isAddress(to)) return { ok: false, reason: "The recipient is not a valid address." };
  const recipient = getAddress(to);
  if (recipient === "0x0000000000000000000000000000000000000000") return { ok: false, reason: "The recipient cannot be the zero address." };
  const { reader, account } = deps;
  const book = kind === "withdraw" ? "earnings" : "payerBalance";
  const [available, qie, gasPrice] = await Promise.all([
    reader.router.getFunction(book)(account) as Promise<bigint>,
    reader.provider.getBalance(account),
    gasPriceOf(reader),
  ]);
  const noun = kind === "withdraw" ? "earnings" : "prepaid balance";
  if (amount > available) return { ok: false, reason: `Your ${noun} is ${usdc(available)}, which is less than ${usdc(amount)}.` };

  let units: bigint | undefined;
  try {
    units = await reader.provider.estimateGas({ from: account, to: reader.routerAddress, data: directInterface.encodeFunctionData(kind, [amount, recipient]) });
  } catch {
    units = undefined;
  }
  const gas: Gas | undefined = units === undefined ? undefined : { units, priceWei: gasPrice, costWei: units * gasPrice };
  const useWallet = gas !== undefined && qie >= gas.costWei;
  const label = kind === "withdraw" ? "Withdraw earnings" : "Refund prepaid balance";
  const baseFields: Field[] = [
    { label: "Action", value: kind === "withdraw" ? "Withdraw from the Sluice router" : "Refund from the Sluice router" },
    { label: "Amount", value: usdc(amount) },
    { label: "Recipient", value: recipient },
    { label: "From account", value: account },
    { label: "Router", value: reader.routerAddress },
    { label: "Network", value: networkLine(deps.chainId) },
  ];
  const warnings = recipient !== getAddress(account) ? ["The recipient is a different address from your wallet."] : [];

  if (useWallet) {
    return {
      ok: true,
      plan: {
        kind,
        route: "wallet",
        title: label,
        summary: "Your wallet will send the transaction and pay the network fee in QIE.",
        fields: [...baseFields, { label: "Network fee", value: gasLine(gas!, false) }],
        steps: [`${label}: ${usdc(amount)} to ${recipient}`],
        warnings,
        gas,
        input: { kind, route: "wallet", amount, to: recipient },
      },
    };
  }
  if (!deps.facilitator) {
    return { ok: false, reason: "This wallet holds too little QIE for the network fee, and no facilitator is set to send the request for you." };
  }
  return {
    ok: true,
    plan: {
      kind,
      route: "facilitator",
      title: `${label} with no QIE`,
      summary: "Your wallet will sign a request, and a facilitator will send it and pay the network fee. The signature fixes the amount, the recipient and a relayer fee of zero.",
      fields: [
        ...baseFields,
        { label: "Relayer fee", value: "0 QUSDC (fixed in the signature)" },
        { label: "Valid for", value: `${SIGNATURE_LIFETIME_SECONDS / 60} minutes` },
        { label: "Facilitator", value: deps.facilitatorUrl ?? "the configured facilitator" },
        { label: "You pay", value: "No QIE" },
      ],
      steps: ["Your wallet signs the request (no transaction)", "The facilitator sends it to the router"],
      warnings,
      input: { kind, route: "facilitator", amount, to: recipient },
    },
  };
}

export type AuthorizeRequest = { agent: string; budget: bigint; perCallCap: bigint; expiry: number; tools: ToolGrant[] };

export const MAX_TOOLS = 32;

export function validateAuthorize(req: AuthorizeRequest, nowSeconds: number): string | undefined {
  if (!isAddress(req.agent)) return "The agent address is not valid.";
  if (req.budget <= 0n) return "The budget must be above zero.";
  if (req.perCallCap <= 0n) return "The cap per call must be above zero.";
  if (req.perCallCap > req.budget) return "The cap per call cannot be more than the budget.";
  if (!Number.isSafeInteger(req.expiry) || req.expiry <= nowSeconds) return "The expiry must be in the future.";
  if (req.tools.length === 0) return "Allow at least one tool.";
  if (req.tools.length > MAX_TOOLS) return `An agent can have at most ${MAX_TOOLS} tools.`;
  for (const t of req.tools) {
    if (!isAddress(t.payee)) return "Every tool needs a payee address.";
    if (!t.anyTool && t.toolName.trim() === "") return "Every tool needs a name, or choose any tool from that payee.";
  }
  return undefined;
}

export async function planAuthorize(deps: FlowDeps, req: AuthorizeRequest): Promise<PlanResult> {
  const problem = validateAuthorize(req, deps.now());
  if (problem) return { ok: false, reason: problem };
  const { reader, account } = deps;
  const agent = getAddress(req.agent);
  if (agent === getAddress(account)) return { ok: false, reason: "Use a separate session key for the agent, not your own wallet." };
  const tools = req.tools.map((t) => ({ payee: getAddress(t.payee), toolId: t.anyTool ? ZeroHash : toolIdOf(t.toolName.trim()) }));
  const [qie, gasPrice] = await Promise.all([reader.provider.getBalance(account), gasPriceOf(reader)]);
  let units: bigint | undefined;
  try {
    units = await reader.provider.estimateGas({
      from: account,
      to: reader.vaultAddress,
      data: directInterface.encodeFunctionData("authorize", [{ agent, budget: req.budget, perCallCap: req.perCallCap, expiry: BigInt(req.expiry) }, tools]),
    });
  } catch {
    units = undefined;
  }
  const gas: Gas | undefined = units === undefined ? undefined : { units, priceWei: gasPrice, costWei: units * gasPrice };
  const toolLines = req.tools.map((t, i) => ({
    label: `Tool ${i + 1}`,
    value: `${t.anyTool ? "any tool" : t.toolName.trim()} from ${getAddress(t.payee)}`,
  }));
  const fields: Field[] = [
    { label: "Action", value: "Authorise an agent key on the Sluice vault" },
    { label: "Agent key", value: agent },
    { label: "Budget", value: usdc(req.budget) },
    { label: "Cap per call", value: usdc(req.perCallCap) },
    { label: "Expires", value: formatUtc(req.expiry) },
    ...toolLines,
    { label: "Vault", value: reader.vaultAddress },
    { label: "Network", value: networkLine(deps.chainId) },
  ];
  const warnings = ["The agent can spend up to the budget, within the cap per call, on these tools only, until it expires or you revoke it."];
  const input: PlanInput = { kind: "authorize", route: "wallet", agent, budget: req.budget, perCallCap: req.perCallCap, expiry: req.expiry, tools };

  if (gas !== undefined && qie >= gas.costWei) {
    return {
      ok: true,
      plan: {
        kind: "authorize",
        route: "wallet",
        title: "Authorise an agent key",
        summary: "Your wallet will send the transaction and pay the network fee in QIE.",
        fields: [...fields, { label: "Network fee", value: gasLine(gas, false) }],
        steps: ["Authorise the agent key on the vault"],
        warnings,
        gas,
        input,
      },
    };
  }
  if (!deps.facilitator) return { ok: false, reason: "This wallet holds too little QIE for the network fee, and no facilitator is set to send the request for you." };
  return {
    ok: true,
    plan: {
      kind: "authorize",
      route: "facilitator",
      title: "Authorise an agent key with no QIE",
      summary: "Your wallet will sign the authorisation, and a facilitator will send it and pay the network fee.",
      fields: [...fields, { label: "Valid for", value: `${SIGNATURE_LIFETIME_SECONDS / 60} minutes` }, { label: "Facilitator", value: deps.facilitatorUrl ?? "the configured facilitator" }, { label: "You pay", value: "No QIE" }],
      steps: ["Your wallet signs the authorisation (no transaction)", "The facilitator sends it to the vault"],
      warnings,
      input: { ...input, route: "facilitator" },
    },
  };
}

export async function planRevoke(deps: FlowDeps, agentText: string): Promise<PlanResult> {
  if (!isAddress(agentText)) return { ok: false, reason: "The agent address is not valid." };
  const agent = getAddress(agentText);
  const { reader, account } = deps;
  const session = (await reader.vault.getFunction("sessionOf")(account, agent)) as { id: bigint };
  if (session.id === 0n) return { ok: false, reason: "That agent has no active session on this account." };
  const [qie, gasPrice] = await Promise.all([reader.provider.getBalance(account), gasPriceOf(reader)]);
  let units: bigint | undefined;
  try {
    units = await reader.provider.estimateGas({ from: account, to: reader.vaultAddress, data: directInterface.encodeFunctionData("revoke", [agent]) });
  } catch {
    units = undefined;
  }
  const gas: Gas | undefined = units === undefined ? undefined : { units, priceWei: gasPrice, costWei: units * gasPrice };
  const fields: Field[] = [
    { label: "Action", value: "Revoke an agent key on the Sluice vault" },
    { label: "Agent key", value: agent },
    { label: "Vault", value: reader.vaultAddress },
    { label: "Network", value: networkLine(deps.chainId) },
  ];
  const warnings = ["The agent's next payment fails in the block this lands in. Payments already settled stay settled."];
  if (gas !== undefined && qie >= gas.costWei) {
    return { ok: true, plan: { kind: "revoke", route: "wallet", title: "Revoke an agent key", summary: "Your wallet will send the transaction and pay the network fee in QIE.", fields: [...fields, { label: "Network fee", value: gasLine(gas, false) }], steps: ["Revoke the agent key"], warnings, gas, input: { kind: "revoke", route: "wallet", agent } } };
  }
  if (!deps.facilitator) return { ok: false, reason: "This wallet holds too little QIE for the network fee, and no facilitator is set to send the request for you." };
  return {
    ok: true,
    plan: { kind: "revoke", route: "facilitator", title: "Revoke an agent key with no QIE", summary: "Your wallet will sign the revocation, and a facilitator will send it and pay the network fee.", fields: [...fields, { label: "Valid for", value: `${SIGNATURE_LIFETIME_SECONDS / 60} minutes` }, { label: "You pay", value: "No QIE" }], steps: ["Your wallet signs the revocation (no transaction)", "The facilitator sends it to the vault"], warnings, input: { kind: "revoke", route: "facilitator", agent } },
  };
}

// ---------------------------------------------------------------------------------------------- execution

const hex = (n: bigint | number): string => `0x${BigInt(n).toString(16)}`;

type TypedPayload = {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
};

const DOMAIN_TYPE = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];

/** Asks the wallet to sign typed data, and checks the signature is the account's before it goes anywhere. */
async function signTyped(deps: FlowDeps, typed: TypedPayload): Promise<string> {
  const json = JSON.stringify({ types: { EIP712Domain: DOMAIN_TYPE, ...typed.types }, primaryType: typed.primaryType, domain: typed.domain, message: typed.message });
  let signature: unknown;
  try {
    signature = await deps.wallet.request({ method: "eth_signTypedData_v4", params: [deps.account, json] });
  } catch (err) {
    throw new WalletError(classifyWalletError(err), describeWalletError(err));
  }
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new WalletError("failed", "the wallet returned a signature the app cannot read");
  let signer: string;
  try {
    signer = verifyTypedData(typed.domain as never, typed.types, typed.message, signature);
  } catch {
    throw new WalletError("failed", "the wallet returned a signature that does not match what was shown");
  }
  if (getAddress(signer) !== getAddress(deps.account)) throw new WalletError("failed", "the wallet signed with a different account than the one connected");
  return signature;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function sendAndWait(deps: FlowDeps, tx: { to: string; data: string }): Promise<string> {
  let hash: unknown;
  try {
    hash = await deps.wallet.request({ method: "eth_sendTransaction", params: [{ from: deps.account, to: tx.to, data: tx.data, value: "0x0" }] });
  } catch (err) {
    throw new WalletError(classifyWalletError(err), describeWalletError(err));
  }
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new WalletError("failed", "the wallet did not return a transaction hash");
  const sleep = deps.sleep ?? wait;
  for (let i = 0; i < 240; i++) {
    const receipt = await deps.reader.provider.getTransactionReceipt(hash);
    if (receipt) {
      if (receipt.status !== 1) throw new WalletError("failed", "the transaction was sent and failed on the network");
      return hash;
    }
    await sleep(500);
  }
  throw new WalletError("failed", "the transaction was sent but is not confirmed yet; check the explorer");
}

async function relay(deps: FlowDeps, request: RelayRequest): Promise<string> {
  const res = await deps.facilitator!.relay(request);
  if (!res.ok || !res.transaction) throw new WalletError("failed", `the facilitator refused the request: ${res.detail ?? res.error ?? "no reason given"}`);
  return res.transaction;
}

const randomNonce = (deps: FlowDeps): string => (deps.random ? deps.random() : hexlify(randomBytes(32)));

async function executeDepositViaFacilitator(deps: FlowDeps, input: Extract<PlanInput, { kind: "deposit" }>): Promise<string[]> {
  const { reader, account, wallet } = deps;
  const nonce = await reader.provider.getTransactionCount(account, "pending");
  const common = { chainId: deps.chainId, gasPrice: input.gasPrice, value: 0n, type: 0 } as const;
  const approve = { ...common, nonce, gasLimit: ONBOARD_APPROVE_GAS, to: reader.tokenAddress, data: erc20Interface.encodeFunctionData("approve", [reader.routerAddress, input.amount]) };
  const deposit = { ...common, nonce: nonce + 1, gasLimit: ONBOARD_DEPOSIT_GAS, to: reader.routerAddress, data: routerInterface.encodeFunctionData("deposit", [input.amount]) };
  const signed: string[] = [];
  for (const tx of [approve, deposit]) {
    let raw: unknown;
    try {
      raw = await wallet.request({
        method: "eth_signTransaction",
        params: [{ from: account, to: tx.to, data: tx.data, value: "0x0", nonce: hex(tx.nonce), gas: hex(tx.gasLimit), gasPrice: hex(tx.gasPrice), chainId: hex(tx.chainId), type: "0x0" }],
      });
    } catch (err) {
      const code = classifyWalletError(err);
      if (code === "unsupported_method") {
        throw new WalletError("unsupported_method", "Your wallet cannot sign a transaction without sending it, so a deposit with no QIE cannot start here. Add a little QIE, or sign the two transactions with the SDK on your own machine. Nothing was sent.");
      }
      throw new WalletError(code, describeWalletError(err));
    }
    if (typeof raw !== "string" || !/^0x[0-9a-fA-F]+$/.test(raw)) throw new WalletError("failed", "the wallet returned a signed transaction the app cannot read");
    // The wallet's answer is checked against the plan before it goes to anyone: a wallet must not be able to swap the call.
    let parsed: Transaction;
    try {
      parsed = Transaction.from(raw);
    } catch {
      throw new WalletError("failed", "the wallet returned a signed transaction the app cannot read");
    }
    const same =
      parsed.type === 0 &&
      parsed.chainId === BigInt(tx.chainId) &&
      parsed.nonce === tx.nonce &&
      parsed.gasLimit === tx.gasLimit &&
      parsed.gasPrice === tx.gasPrice &&
      parsed.value === 0n &&
      parsed.to !== null &&
      getAddress(parsed.to) === getAddress(tx.to) &&
      parsed.data === tx.data &&
      parsed.from !== null &&
      getAddress(parsed.from) === getAddress(account);
    if (!same) throw new WalletError("failed", "the wallet signed something different from what was shown, so nothing was sent");
    signed.push(raw);
  }
  const res = await deps.facilitator!.onboard({ payer: account, approveTx: signed[0]!, depositTx: signed[1]! });
  if (!res.ok) throw new WalletError("failed", `the facilitator refused the deposit: ${res.detail ?? res.error ?? "no reason given"}`);
  return [res.topUpTx, res.approveTx, res.depositTx].filter((h): h is string => typeof h === "string");
}

/** Runs a plan. Only a FlowSession calls this, and only after the person has confirmed. */
async function runPlan(deps: FlowDeps, plan: Plan): Promise<FlowResult> {
  const input = plan.input;
  const { reader, account } = deps;
  const walletChain = await deps.wallet.request({ method: "eth_chainId" }).catch(() => null);
  const current = typeof walletChain === "string" ? Number.parseInt(walletChain, 16) : null;
  if (wrongNetwork(deps, current)) throw new WalletError("wrong_network", describeWalletError(new WalletError("wrong_network", "")));

  switch (input.kind) {
    case "deposit": {
      if (input.route === "facilitator") return { via: "facilitator", transactions: await executeDepositViaFacilitator(deps, input) };
      const hashes: string[] = [];
      if (input.needsApprove) hashes.push(await sendAndWait(deps, { to: reader.tokenAddress, data: erc20Interface.encodeFunctionData("approve", [reader.routerAddress, input.amount]) }));
      hashes.push(await sendAndWait(deps, { to: reader.routerAddress, data: routerInterface.encodeFunctionData("deposit", [input.amount]) }));
      return { via: "wallet", transactions: hashes };
    }
    case "withdraw":
    case "refund": {
      if (input.route === "wallet") {
        return { via: "wallet", transactions: [await sendAndWait(deps, { to: reader.routerAddress, data: directInterface.encodeFunctionData(input.kind, [input.amount, input.to]) })] };
      }
      const nonce = randomNonce(deps);
      const deadline = deps.now() + SIGNATURE_LIFETIME_SECONDS;
      const domain = routerDomain(reader.routerAddress, deps.chainId) as unknown as Record<string, unknown>;
      const isWithdraw = input.kind === "withdraw";
      const message = isWithdraw
        ? { account, to: input.to, amount: input.amount.toString(), relayerFee: "0", nonce, deadline: String(deadline) }
        : { payer: account, to: input.to, amount: input.amount.toString(), relayerFee: "0", nonce, deadline: String(deadline) };
      const types = isWithdraw ? WITHDRAW_TYPES : REFUND_TYPES;
      const signature = await signTyped(deps, { domain, types, primaryType: isWithdraw ? "Withdraw" : "Refund", message });
      const tx = await relay(deps, { kind: input.kind, account, to: input.to, amount: input.amount.toString(), nonce, deadline: String(deadline), signature });
      return { via: "facilitator", transactions: [tx] };
    }
    case "authorize": {
      if (input.route === "wallet") {
        const grant = { agent: input.agent, budget: input.budget, perCallCap: input.perCallCap, expiry: BigInt(input.expiry) };
        return { via: "wallet", transactions: [await sendAndWait(deps, { to: reader.vaultAddress, data: directInterface.encodeFunctionData("authorize", [grant, input.tools]) })] };
      }
      const nonce = (await reader.vault.getFunction("nonces")(account)) as bigint;
      const deadline = deps.now() + SIGNATURE_LIFETIME_SECONDS;
      const domain = vaultDomain(reader.vaultAddress, deps.chainId) as unknown as Record<string, unknown>;
      const message = {
        payer: account,
        agent: input.agent,
        budget: input.budget.toString(),
        perCallCap: input.perCallCap.toString(),
        expiry: String(input.expiry),
        tools: input.tools,
        nonce: nonce.toString(),
        deadline: String(deadline),
      };
      const signature = await signTyped(deps, { domain, types: AUTHORIZE_TYPES, primaryType: "Authorize", message });
      const tx = await relay(deps, {
        kind: "authorize",
        payer: account,
        grant: { agent: input.agent, budget: input.budget.toString(), perCallCap: input.perCallCap.toString(), expiry: String(input.expiry) },
        tools: input.tools,
        deadline: String(deadline),
        signature,
      });
      return { via: "facilitator", transactions: [tx] };
    }
    case "revoke": {
      if (input.route === "wallet") {
        return { via: "wallet", transactions: [await sendAndWait(deps, { to: reader.vaultAddress, data: directInterface.encodeFunctionData("revoke", [input.agent]) })] };
      }
      const nonce = (await reader.vault.getFunction("nonces")(account)) as bigint;
      const deadline = deps.now() + SIGNATURE_LIFETIME_SECONDS;
      const domain = vaultDomain(reader.vaultAddress, deps.chainId) as unknown as Record<string, unknown>;
      const message = { payer: account, agent: input.agent, nonce: nonce.toString(), deadline: String(deadline) };
      const signature = await signTyped(deps, { domain, types: REVOKE_TYPES, primaryType: "Revoke", message });
      const tx = await relay(deps, { kind: "revoke", payer: account, agent: input.agent, deadline: String(deadline), signature });
      return { via: "facilitator", transactions: [tx] };
    }
  }
}

// ----------------------------------------------------------------------------------------------- the session

export type SessionState = "planned" | "confirmed" | "sending" | "done" | "cancelled" | "failed";

/**
 * One planned flow and its state. The state moves planned -> confirmed -> sending -> done (or failed), and "cancelled" from planned or
 * confirmed. `send` refuses from every state but "confirmed", so a wallet request cannot be made without a confirm.
 */
export class FlowSession {
  private current: SessionState = "planned";
  private outcome?: FlowResult;
  private failure?: unknown;

  constructor(
    readonly plan: Plan,
    private readonly deps: FlowDeps,
  ) {}

  get state(): SessionState {
    return this.current;
  }
  get result(): FlowResult | undefined {
    return this.outcome;
  }
  get error(): unknown {
    return this.failure;
  }

  confirm(): void {
    if (this.current !== "planned") throw new Error(`cannot confirm a plan that is ${this.current}`);
    this.current = "confirmed";
  }

  cancel(): void {
    if (this.current === "planned" || this.current === "confirmed") this.current = "cancelled";
  }

  async send(): Promise<FlowResult> {
    if (this.current !== "confirmed") throw new NotConfirmedError();
    this.current = "sending";
    try {
      this.outcome = await runPlan(this.deps, this.plan);
      this.current = "done";
      return this.outcome;
    } catch (err) {
      this.failure = err;
      this.current = "failed";
      throw err;
    }
  }
}

export { TypedDataEncoder };

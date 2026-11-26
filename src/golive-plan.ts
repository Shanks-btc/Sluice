// The go-live plan: the five addresses of the mainnet go-live checked against each other and against the chain, then the exact, ordered
// PowerShell commands of the whole real sequence with those addresses filled in. Nothing here sends anything, signs anything or runs
// anything: it reads (seven read-only methods, listed below), and it prints text. It holds no key. A key file is only ever read by the
// command line program, to learn an address from it, and no function here returns, prints or throws a key.
//
// The five roles, and why each must be its own address:
//   deployer       a key that signs the deploy and the smoke run
//   relayer        a hot key on the facilitator's host that pays gas
//   owner          the router's owner: it can change the fee (up to 2%) and the fee recipient, and nothing else
//   fee recipient  where the fee is credited
//   payer          a wallet that starts with no QIE: the zero-QIE start is what the run proves
import { Interface, Wallet, getAddress, toQuantity } from "ethers";
import type { Rpc } from "./evidence";
import { DEFAULT_DAILY_BUDGET_WEI, FUNDING_READ_ONLY_METHODS, ceilQie, planFunding } from "./funding";
import { MEASURED_GAS, SMOKE_GAS_TOTAL, costWei } from "./gas-figures";
import { CEILING_QIE_WEI, CEILING_QUSDC, QUSDC_ADDRESS, formatQie } from "./guard";
import { DEFAULT_FEE_BPS, DEFAULT_SMOKE_AMOUNTS, DEPLOY_GAS_LIMIT, MAX_FEE_BPS, TX_GAS_LIMIT, deployPlan, smokePlan } from "./live";
import { formatQusdc } from "./units";

/** Every method the plan may call. It is the funding calculator's, with eth_getCode added to tell a contract from an account. */
export const GOLIVE_READ_ONLY_METHODS: ReadonlySet<string> = new Set([...FUNDING_READ_ONLY_METHODS, "eth_getCode"]);

export const MAINNET_CHAIN_ID = 1990;
/** What the payer deposits in the zero-QIE start when --payer-qusdc is not given: 0.3 QUSDC, the size of the smoke run's deposit. */
export const DEFAULT_PAYER_QUSDC = 300_000n;
/** The smallest value the spending caps accept. A step that moves no QUSDC, or spends none of the signer's own QIE, is capped at this. */
export const SMALLEST_CAP = "0.000001";
/** The factor on today's gas price that a single transaction may cost, as in the funding calculator. */
export const TX_MARGIN = 3n;

export const ROLES = ["deployer", "relayer", "owner", "feeRecipient", "payer"] as const;
export type Role = (typeof ROLES)[number];
export type Roles = Record<Role, string>;

/** The command line option that names each role, so that a message says what to change. */
export const FLAG: Record<Role, string> = {
  deployer: "--deployer",
  relayer: "--relayer",
  owner: "--owner",
  feeRecipient: "--fee-recipient",
  payer: "--payer",
};

// ------------------------------------------------------------------------------------------------------------- the addresses

/** One address as it was typed: the checksum capitals must be right, because a mistyped character is only caught by them. */
export function checkAddress(flag: string, raw: string | undefined): { address?: string; problem?: string } {
  const text = raw?.trim();
  if (!text) return { problem: `${flag} is missing` };
  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) return { problem: `${flag} is not an address: it must be 0x and 40 hexadecimal characters` };
  let checksummed: string;
  try {
    checksummed = getAddress(text);
  } catch {
    return { problem: `${flag} has a wrong checksum: at least one of its characters is mistyped` };
  }
  if (checksummed !== text) {
    return { problem: `${flag} is not written with its checksum capitals, so a mistyped character would go unnoticed: copy it again from the wallet, which shows it with capitals` };
  }
  if (/^0x0{40}$/.test(text)) return { problem: `${flag} is the zero address` };
  return { address: checksummed };
}

/** The five addresses as typed, checked one by one and against each other. Every problem is listed, not only the nearest. */
export function checkRoles(raw: Partial<Record<Role, string>>): { roles?: Roles; problems: string[] } {
  const problems: string[] = [];
  const found: Partial<Roles> = {};
  for (const role of ROLES) {
    const one = checkAddress(FLAG[role], raw[role]);
    if (one.problem) problems.push(one.problem);
    else found[role] = one.address as string;
  }
  for (let i = 0; i < ROLES.length; i++) {
    for (let j = i + 1; j < ROLES.length; j++) {
      const a = ROLES[i] as Role;
      const b = ROLES[j] as Role;
      if (found[a] && found[b] && found[a] === found[b]) problems.push(`${FLAG[a]} and ${FLAG[b]} are the same address: each role needs an address of its own`);
    }
  }
  return problems.length > 0 ? { problems } : { roles: found as Roles, problems };
}

export class KeyFileError extends Error {}

/**
 * The address a key file's key belongs to. The text is the file's contents. The key is never returned, and no message holds any of it: a
 * file that is not a key is described by its shape alone.
 */
export function addressOfKeyFileText(text: string, name: string): string {
  const key = text.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new KeyFileError(`${name} does not hold a key: it should be one line, 0x and 64 hexadecimal characters`);
  try {
    return new Wallet(key).address;
  } catch {
    throw new KeyFileError(`${name} does not hold a usable key`);
  }
}

// ------------------------------------------------------------------------------------------------------------------ reading

export type Holding = { qieWei: bigint; qusdc: bigint; isContract: boolean };
export type Facts = { chainId: number; block: number; timestamp: number; gasPrice: bigint; holdings: Record<Role, Holding> };

const erc20 = new Interface(["function balanceOf(address) view returns (uint256)"]);

/** Reads the chain's id, the gas price and, for each of the five addresses, the QIE, the QUSDC and whether there is code, all at one block. */
export async function readFacts(rpc: Rpc, roles: Roles): Promise<Facts> {
  const chainId = Number(BigInt(String(await rpc("eth_chainId", []))));
  const head = (await rpc("eth_getBlockByNumber", ["latest", false])) as { number: string; timestamp: string } | null;
  if (!head) throw new Error("the latest block could not be read");
  const block = Number(BigInt(head.number));
  const at = toQuantity(block);
  const gasPrice = BigInt(String(await rpc("eth_gasPrice", [])));
  const holdings = {} as Record<Role, Holding>;
  for (const role of ROLES) {
    const who = roles[role];
    const qieWei = BigInt(String(await rpc("eth_getBalance", [who, at])));
    const raw = await rpc("eth_call", [{ to: QUSDC_ADDRESS, data: erc20.encodeFunctionData("balanceOf", [who]) }, at]);
    if (typeof raw !== "string" || raw === "0x") throw new Error("QUSDC's balance could not be read");
    const code = await rpc("eth_getCode", [who, at]);
    if (typeof code !== "string") throw new Error("an address's code could not be read");
    holdings[role] = { qieWei, qusdc: erc20.decodeFunctionResult("balanceOf", raw)[0] as bigint, isContract: code !== "0x" };
  }
  return { chainId, block, timestamp: Number(BigInt(head.timestamp)), gasPrice, holdings };
}

// ----------------------------------------------------------------------------------------------------------------- checking

export type Finding = { level: "PASS" | "WARN" | "FAIL"; text: string };

const WHO: Record<Role, string> = {
  deployer: "the deployer",
  relayer: "the relayer",
  owner: "the owner",
  feeRecipient: "the fee recipient",
  payer: "the payer",
};

/**
 * What the chain says about the five addresses. A FAIL means no plan is printed: the chain is not mainnet, or an address that must be a
 * plain account holds a contract. A WARN is printed with the plan and says what to do before the step that needs it.
 */
export function evaluate(roles: Roles, facts: Facts, payerQusdc: bigint = DEFAULT_PAYER_QUSDC): Finding[] {
  const out: Finding[] = [];
  if (facts.chainId !== MAINNET_CHAIN_ID) {
    out.push({ level: "FAIL", text: `the RPC is on chain ${facts.chainId}, but this plan is for mainnet (chain ${MAINNET_CHAIN_ID})` });
    return out;
  }
  out.push({ level: "PASS", text: `the RPC is on chain ${MAINNET_CHAIN_ID}` });
  for (const role of ROLES) {
    const h = facts.holdings[role];
    if (h.isContract) {
      out.push({
        level: "FAIL",
        text:
          role === "deployer" || role === "relayer"
            ? `${WHO[role]} ${roles[role]} holds a contract on this chain, but it must be an account whose key signs`
            : `${WHO[role]} ${roles[role]} holds a contract on this chain: this go-live uses a plain account for the owner, the fee recipient and the payer`,
      });
    }
  }
  if (out.some((f) => f.level === "FAIL")) return out;
  out.push({ level: "PASS", text: "all five addresses are different, none is the zero address, and none holds a contract" });

  const plan = planFunding({ gasPrice: facts.gasPrice, runQusdc: payerQusdc, margin: TX_MARGIN, dailyBudgetWei: DEFAULT_DAILY_BUDGET_WEI });
  const d = facts.holdings.deployer;
  const r = facts.holdings.relayer;
  const p = facts.holdings.payer;
  if (p.qieWei > 0n) {
    out.push({ level: "WARN", text: `the payer holds ${formatQie(p.qieWei)} QIE. The zero-QIE start is what this run proves, and with QIE in the wallet it proves nothing: move the QIE out, or use another account` });
  } else {
    out.push({ level: "PASS", text: "the payer holds no QIE, so the start with no QIE is a true test" });
  }
  if (p.qusdc < payerQusdc) {
    out.push({ level: "WARN", text: `the payer holds ${formatQusdc(p.qusdc)} QUSDC, below the ${formatQusdc(payerQusdc)} QUSDC the start deposits: fund it before the payer's step` });
  }
  if (d.qieWei < plan.deployerQieWei) {
    out.push({ level: "WARN", text: `the deployer holds ${formatQie(d.qieWei)} QIE, below the ${ceilQie(plan.deployerQieWei)} QIE the deploy and the smoke run need at ${TX_MARGIN}x today's gas price: the pre-flight check will say NO-GO` });
  }
  if (d.qusdc < plan.deployerQusdc) {
    out.push({ level: "WARN", text: `the deployer holds ${formatQusdc(d.qusdc)} QUSDC, below the ${formatQusdc(plan.deployerQusdc)} QUSDC the smoke run deposits: the pre-flight check will say NO-GO` });
  }
  if (r.qieWei < plan.relayerFloorWei) {
    out.push({ level: "WARN", text: `the relayer holds ${formatQie(r.qieWei)} QIE, below the ${ceilQie(plan.relayerFloorWei)} QIE floor of the pre-flight check: it will say NO-GO` });
  } else if (r.qieWei < plan.relayerHoldWei) {
    out.push({
      level: "WARN",
      text: `the relayer holds ${formatQie(r.qieWei)} QIE, below the ${formatQie(plan.relayerHoldWei)} QIE to hold (a day's budget). The facilitator's /health will say lowBalance true and show a low_balance alert until it is topped up; the run itself needs about ${ceilQie(plan.relayerRunQieWei)} QIE, so this does not stop the run`,
    });
  }
  if (r.qusdc > 0n) out.push({ level: "WARN", text: `the relayer holds ${formatQusdc(r.qusdc)} QUSDC, which it should never do` });
  return out;
}

// -------------------------------------------------------------------------------------------------------------------- steps

export type PlanStep = {
  n: number;
  phase: string;
  title: string;
  /** One line: what it costs, in QIE or QUSDC, or that it costs nothing. */
  spends: string;
  /** One line: whether it can be undone, and how. */
  reversible: string;
  /** The spending caps in the environment for this step, or what to say instead. */
  caps: string;
  /** PowerShell lines to copy, one command each. Empty for a step done by hand. */
  commands: string[];
  /** One line: what a good result looks like, and when to stop. */
  expect: string;
};

type StepInput = Omit<PlanStep, "n">;

const gwei = (wei: bigint): string => {
  const whole = wei / 10n ** 9n;
  const frac = (wei % 10n ** 9n).toString().padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
};
const withCommas = (n: bigint): string => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** The most one transaction may cost: its gas limit at today's price times the margin, rounded up, and never above the run's own cap. */
export function perTxCap(gasLimit: bigint, gasPrice: bigint, capWei: bigint): string {
  const wanted = gasLimit * gasPrice * TX_MARGIN;
  return ceilQie(wanted > capWei ? capWei : wanted);
}

/**
 * The whole real sequence, with the five addresses filled in. The caps are the smallest the scripts accept: a script refuses to start
 * unless its own worst case (its gas limits at 50 gwei, the price it stops at) fits the QIE cap, so the QIE cap is exactly that worst
 * case, and the cap on one transaction (SLUICE_MAX_TX_QIE) is what holds the spend to the budget at today's gas price.
 */
export function buildSteps(roles: Roles, ctx: { gasPrice: bigint; payerQusdc: bigint }): PlanStep[] {
  const { deployer, relayer, owner, feeRecipient } = roles;
  const deployCapQie = formatQie(deployPlan().qieWei);
  const smokeCapQie = formatQie(smokePlan().qieWei);
  const deployTx = perTxCap(DEPLOY_GAS_LIMIT, ctx.gasPrice, deployPlan().qieWei);
  const smokeTx = perTxCap(TX_GAS_LIMIT, ctx.gasPrice, smokePlan().qieWei);
  const deployCaps = `SLUICE_MAX_QUSDC=${SMALLEST_CAP} (the deploy moves none), SLUICE_MAX_QIE=${deployCapQie} (the script's worst case at its 50 gwei stop), SLUICE_MAX_TX_QIE=${deployTx}`;
  const smokeCaps = `SLUICE_MAX_QUSDC=${formatQusdc(DEFAULT_SMOKE_AMOUNTS.deposit)}, SLUICE_MAX_QIE=${smokeCapQie} (the script's worst case at its 50 gwei stop), SLUICE_MAX_TX_QIE=${smokeTx}`;
  const payerAmount = formatQusdc(ctx.payerQusdc);
  const deployCost = ceilQie(costWei(MEASURED_GAS.deployRouter, ctx.gasPrice));
  const smokeCost = ceilQie(costWei(SMOKE_GAS_TOTAL, ctx.gasPrice));
  const none = "not needed: this step sends nothing";

  const steps: StepInput[] = [
    // ------------------------------------------------------------------------------------------------ before anything is sent
    {
      phase: "Before anything is sent",
      title: "Choose the network and read the deployer key into this session",
      spends: "nothing: the key goes into this session's environment from its file and is printed nowhere",
      reversible: "yes: the clean-up step at the end clears it, and so does closing the window",
      caps: none,
      commands: [`$env:SLUICE_NETWORK = "mainnet"; $env:SLUICE_KEY = (Get-Content .\\deployer-mainnet.key -Raw).Trim()`],
      expect: "no output; stop if PowerShell says the file is not found, because the deployer's key must be where docs/MAINNET-RUNBOOK.md step 2 put it",
    },
    {
      phase: "Before anything is sent",
      title: "Read QUSDC's facts again",
      spends: "nothing: read-only calls",
      reversible: "nothing to undo",
      caps: none,
      commands: ["pnpm live:facts"],
      expect: "`These match what docs/RISKS.md says.` and exit code 0; stop if it prints a difference",
    },
    {
      phase: "Before anything is sent",
      title: "Run the pre-flight check",
      spends: "nothing: read-only calls, and one read of the explorer's address",
      reversible: "nothing to undo",
      caps: none,
      commands: [`pnpm live:preflight --deployer ${deployer} --relayer ${relayer}`],
      expect: "lines that start PASS and a last line `GO on mainnet`; a WARN is worth reading; stop on `NO-GO`",
    },
    // ----------------------------------------------------------------------------------------------------------------- deploy
    {
      phase: "Deploy",
      title: "Set the deploy settings and the caps",
      spends: "nothing: this only sets this session's environment",
      reversible: "yes: the clean-up step clears every one of these",
      caps: deployCaps,
      commands: [
        `$env:SLUICE_APPROVE = "deploy"; $env:SLUICE_OWNER = "${owner}"; $env:SLUICE_FEE_RECIPIENT = "${feeRecipient}"; $env:SLUICE_FEE_BPS = "${DEFAULT_FEE_BPS}"; $env:SLUICE_RELAYER = "${relayer}"`,
        `$env:SLUICE_MAX_QUSDC = "${SMALLEST_CAP}"; $env:SLUICE_MAX_QIE = "${deployCapQie}"; $env:SLUICE_MAX_TX_QIE = "${deployTx}"`,
      ],
      expect: `no output; the fee is in basis points (${DEFAULT_FEE_BPS} is 1%, and the contract refuses more than ${MAX_FEE_BPS}); the token is QUSDC, and the script refuses any other on mainnet`,
    },
    {
      phase: "Deploy",
      title: "Dry-run the deploy",
      spends: "nothing: it asks the node to estimate and sends no transaction",
      reversible: "nothing to undo",
      caps: deployCaps,
      commands: ["pnpm exec ts-node scripts/live/deploy.ts --dry-run"],
      expect: `network mainnet (chain 1990), the deployer, the relayer, QUSDC (has code and 6 decimals), the owner ${owner}, the fee recipient ${feeRecipient}, fee ${DEFAULT_FEE_BPS} bps, then \`the plan fits\`; stop if any of them differs`,
    },
    {
      phase: "Deploy",
      title: "Deploy the router (it creates the vault)",
      spends: `about ${deployCost} QIE of gas (${withCommas(MEASURED_GAS.deployRouter)} gas at ${gwei(ctx.gasPrice)} gwei, as measured on a fork); no QUSDC`,
      reversible: `no: a deployed router stays on the chain; a redeploy costs the same again (about ${withCommas(MEASURED_GAS.deployRouter)} gas) and makes a second router, and the owner can only change the fee (at most ${MAX_FEE_BPS} bps) and the fee recipient`,
      caps: deployCaps,
      commands: ["pnpm exec ts-node scripts/live/deploy.ts"],
      expect: "`router 0x...`, `vault 0x...` and `wrote deployment.json`; if it fails or times out, look at the deployer on https://mainnet.qie.digital/ before sending anything again",
    },
    {
      phase: "Deploy",
      title: "Record the deployment",
      spends: "nothing on chain: the recorder reads the transaction back and writes one row to docs/EVIDENCE.md",
      reversible: "a row is a line in a file; nothing on chain changes",
      caps: none,
      commands: [
        "$d = Get-Content .\\deployment.json -Raw | ConvertFrom-Json",
        "pnpm evidence:record --claim deploy --tx $d.hash --network mainnet",
      ],
      expect: "`recorded 1 row for the deploy claim on mainnet`; if it refuses, it says why and wrote nothing (the command above it sets $d for the later steps, so run it again in a new window)",
    },
    {
      phase: "Deploy",
      title: "Write the settings files for the facilitator, the tool server and the web app",
      spends: "nothing: three git-ignored files, and none holds a key",
      reversible: "yes: delete the files; the command refuses to overwrite one a person has filled in",
      caps: none,
      commands: ["pnpm live:wire --network mainnet"],
      expect: "`wrote .env.mainnet.facilitator, .env.mainnet.tool-server, .env.mainnet.web` and a table of what is public, what is a secret you make and what you still fill in",
    },
    {
      phase: "Deploy",
      title: "Run the pre-flight check again, with the deployment record",
      spends: "nothing: read-only calls",
      reversible: "nothing to undo",
      caps: none,
      commands: ["$env:SLUICE_ROUTER = $d.router", `pnpm live:preflight --deployer ${deployer} --relayer ${relayer} --deployment deployment.json`],
      expect: "`GO on mainnet` and `Deployed code: the router's and the vault's code hash match the deployment record`; stop on NO-GO, and do not use a router whose code does not match",
    },
    // ---------------------------------------------------------------------------------------------------------- verify the source
    {
      phase: "Verify the source",
      title: "Prepare the files for verification",
      spends: "nothing: it writes files to artifacts\\verification and asks the explorer a question",
      reversible: "yes: delete the files",
      caps: none,
      commands: ["pnpm live:verify --prepare-only"],
      expect: "the compiler, optimizer and EVM settings, and three files per contract (the vault's are for building it again; this command does not submit them)",
    },
    {
      phase: "Verify the source",
      title: "Submit the router's source to the explorer",
      spends: "no QIE and no QUSDC: it posts the router's source to https://mainnet.qie.digital/",
      reversible: "no: published source cannot be taken back",
      caps: "not needed: it sends no transaction, only SLUICE_APPROVE=verify",
      commands: [`$env:SLUICE_APPROVE = "verify"; pnpm live:verify`],
      expect: "`explorer: PaymentRouter now shows verified source`, and a line saying this command submits nothing for the vault, which the router's constructor creates (see The vault in docs/MAINNET-RUNBOOK.md); exit code 2 or a 502 means the explorer did not answer: see docs/MAINNET-RUNBOOK.md, When the explorer returns 502",
    },
    {
      phase: "Verify the source",
      title: "Check what the explorer shows for the router, and record it",
      spends: "nothing on chain: one row in docs/EVIDENCE.md",
      reversible: "a row is a line in a file; nothing on chain changes",
      caps: none,
      commands: ["pnpm live:verify --check-only", "pnpm evidence:record --claim verify-link --tx $d.hash --network mainnet"],
      expect: "the router shown as verified, then `recorded 1 row`; if the explorer does not show it yet, record nothing; the row says nothing about the vault",
    },
    {
      phase: "Verify the source",
      title: "Compare the vault's code with the compiled AgentVault",
      spends: "nothing: four read-only RPC methods, and no key",
      reversible: "nothing to undo",
      caps: none,
      commands: ["pnpm live:vaultcheck"],
      expect: "`vaultcheck: ... 0 failed`, with the vault's code hash equal to the compiled AgentVault's and to the one in deployment.json, and the settings to build it again (solc 0.8.24, optimizer 200 runs, shanghai); a FAIL names what differs, so stop",
    },
    // --------------------------------------------------------------------------------------------------------------- the smoke run
    {
      phase: "The smoke run",
      title: "Set the smoke run's caps and dry-run it",
      spends: "nothing: it sends no transaction",
      reversible: "nothing to undo",
      caps: smokeCaps,
      commands: [
        `$env:SLUICE_APPROVE = "smoke"; $env:SLUICE_MAX_QUSDC = "${formatQusdc(DEFAULT_SMOKE_AMOUNTS.deposit)}"; $env:SLUICE_MAX_QIE = "${smokeCapQie}"; $env:SLUICE_MAX_TX_QIE = "${smokeTx}"`,
        "pnpm exec ts-node scripts/live/smoke.ts --dry-run",
      ],
      expect: "eight steps, each with its destination and decoded call, and `the plan fits`",
    },
    {
      phase: "The smoke run",
      title: "Run the smoke run",
      spends: `${formatQusdc(DEFAULT_SMOKE_AMOUNTS.deposit)} QUSDC moves in and all but the 1% fee on 0.15 QUSDC (0.0015 QUSDC) is taken back; about ${smokeCost} QIE of gas (${withCommas(SMOKE_GAS_TOTAL)} gas at ${gwei(ctx.gasPrice)} gwei)`,
      reversible: "the script withdraws and refunds what it deposited; the transactions themselves are final, and the fee is not returned",
      caps: smokeCaps,
      commands: ["pnpm exec ts-node scripts/live/smoke.ts"],
      expect: "eight lines with a transaction hash each, then `pnpm evidence:record` lines for the deposit, the withdrawal and the refund; stop if any step fails, because later steps depend on earlier ones",
    },
    {
      phase: "The smoke run",
      title: "Record the deposit and the withdrawal",
      spends: "nothing on chain: two rows in docs/EVIDENCE.md",
      reversible: "a row is a line in a file; nothing on chain changes",
      caps: none,
      commands: [
        "pnpm evidence:record --claim deposit --tx 0xTheDepositHash --network mainnet --router $env:SLUICE_ROUTER",
        "pnpm evidence:record --claim withdraw --tx 0xTheWithdrawHash --network mainnet --router $env:SLUICE_ROUTER",
      ],
      expect: "`recorded 1 row` each; replace 0xTheDepositHash and 0xTheWithdrawHash with the hashes the smoke run printed, which it also printed as ready-made lines",
    },
    // ----------------------------------------------------------------------------------------------- host, then the payer's start
    {
      phase: "Host, then the payer's start with no QIE",
      title: "Host the facilitator and the tool server",
      spends: "the host's own cost; the relayer's key goes into the host's secret store (the contents of relayer-mainnet.key), and the relayer needs QIE",
      reversible: "yes: turn the kill switch on, stop the service, and the router is untouched",
      caps: "not needed here: set SLUICE_APPROVE=facilitator and SLUICE_RELAYER_KEY on the host",
      commands: [],
      expect: "do this by hand with docs/DEPLOY-FACILITATOR.md and docs/DEPLOY-TOOL-SERVER.md, from the files `live:wire` wrote; do the kill switch drill before the next step",
    },
    {
      phase: "Host, then the payer's start with no QIE",
      title: "Check the facilitator and the tool server are healthy",
      spends: "nothing: two read-only requests",
      reversible: "nothing to undo",
      caps: none,
      commands: [
        `$env:SLUICE_FACILITATOR_URL = "https://facilitator.example"`,
        `Invoke-RestMethod "$env:SLUICE_FACILITATOR_URL/health" | ConvertTo-Json -Depth 5`,
        `Invoke-RestMethod https://tools.example/health | ConvertTo-Json -Depth 5`,
      ],
      expect: `replace the two example addresses with your hosts; the facilitator shows ok true, chainId 1990, the router from deployment.json, relayer ${relayer}, killSwitch false and relayerBalanceWei above 0; lowBalance true is expected while the relayer holds less than 0.5 QIE`,
    },
    {
      phase: "Host, then the payer's start with no QIE",
      title: `The payer starts with no QIE: ${payerAmount} QUSDC in, through the facilitator`,
      spends: `${payerAmount} QUSDC moves from the payer into the router and stays there as the payer's balance; no QIE from the payer, because the facilitator tops it up and sends the two transactions`,
      reversible: "the payer can take the balance back by signature (`pnpm client:owner refund --amount ...`), with no QIE; the transactions are final",
      caps: `SLUICE_MAX_QUSDC=${payerAmount}, SLUICE_MAX_QIE=${SMALLEST_CAP} and SLUICE_MAX_TX_QIE=${SMALLEST_CAP} (the payer sends nothing itself, so its own QIE cap is the smallest there is)`,
      commands: [
        `$env:SLUICE_APPROVE = "owner-setup"; $env:SLUICE_KEY = (Get-Content .\\payer-mainnet.key -Raw).Trim(); $env:SLUICE_MAX_QUSDC = "${payerAmount}"; $env:SLUICE_MAX_QIE = "${SMALLEST_CAP}"; $env:SLUICE_MAX_TX_QIE = "${SMALLEST_CAP}"`,
        `pnpm client:owner start --amount ${payerAmount}`,
      ],
      expect: `it needs SLUICE_ROUTER (step 9) and SLUICE_FACILITATOR_URL (step 17); it prints \`owner ${roles.payer} on mainnet\`, and if that is not the payer, stop (the wallet is the one the key file holds); then the facilitator's top-up, the approval and the deposit, each with a hash, and \`done: ${payerAmount} QUSDC is in the router\`; a payer in a browser wallet can do the same in the web app's start flow, with no key file`,
    },
    {
      phase: "Host, then the payer's start with no QIE",
      title: "Record the start with no QIE",
      spends: "nothing on chain: one row in docs/EVIDENCE.md",
      reversible: "a row is a line in a file; nothing on chain changes",
      caps: none,
      commands: ["pnpm evidence:record --claim relayed-start --tx 0xTheDepositHash --topup 0xTheTopUpHash --network mainnet --router $env:SLUICE_ROUTER"],
      expect: "`recorded 1 row`; use the deposit's hash and the facilitator's top-up hash that the start printed; the recorder refuses a claim the chain does not show",
    },
    // ------------------------------------------------------------------------------------------------------------- check, clean up
    {
      phase: "Check and clean up",
      title: "Check every recorded row against the chain, and count",
      spends: "nothing: read-only calls",
      reversible: "nothing to undo",
      caps: none,
      commands: ["pnpm evidence:check", "$env:SLUICE_FROM_BLOCK = $d.block", "pnpm evidence:summary"],
      expect: "every row PASS, and counts per claim type; nothing is called live until docs/EVIDENCE.md has a verified mainnet row for it",
    },
    {
      phase: "Check and clean up",
      title: "Clear the secrets and the caps from this session",
      spends: "nothing",
      reversible: "nothing to undo",
      caps: none,
      commands: ["Remove-Item Env:SLUICE_KEY; Remove-Item Env:SLUICE_APPROVE; Remove-Item Env:SLUICE_MAX_QUSDC; Remove-Item Env:SLUICE_MAX_QIE; Remove-Item Env:SLUICE_MAX_TX_QIE"],
      expect: "no output; delete relayer-mainnet.key once it is in the host's secret store, and keep every other key file where it is, backed up offline",
    },
  ];
  return steps.map((s, i) => ({ n: i + 1, ...s }));
}

// ---------------------------------------------------------------------------------------------------------------- printing

const isoTime = (seconds: number): string => `${new Date(seconds * 1000).toISOString().replace(".000Z", "Z")} UTC`;

/** The roles, what the chain says about them, and the steps. The text holds no key and nothing that has been run. */
export function formatPlan(roles: Roles, facts: Facts, findings: Finding[], payerQusdc: bigint = DEFAULT_PAYER_QUSDC): string[] {
  const lines: string[] = [];
  lines.push(`Go-live plan for mainnet (chain ${facts.chainId}), read from QIE at block ${facts.block}, ${isoTime(facts.timestamp)}. Gas price ${gwei(facts.gasPrice)} gwei.`);
  lines.push("Read-only: nothing was sent, signed or run. The commands below are for you to run yourself, in order, in PowerShell, from the repository root.");
  lines.push("");
  lines.push("The five roles, each its own address:");
  const hold = (role: Role): string => {
    const h = facts.holdings[role];
    return `holds ${formatQie(h.qieWei)} QIE and ${formatQusdc(h.qusdc)} QUSDC`;
  };
  for (const role of ROLES) lines.push(`  ${WHO[role].padEnd(18)} ${roles[role]}  ${hold(role)}`);
  lines.push("");
  lines.push("What the chain says:");
  for (const f of findings) lines.push(`  ${f.level.padEnd(5)} ${f.text}`);
  if (findings.some((f) => f.level === "FAIL")) {
    lines.push("");
    lines.push("NO PLAN: fix what failed above and run this again. Nothing was sent.");
    return lines;
  }
  const steps = buildSteps(roles, { gasPrice: facts.gasPrice, payerQusdc });
  lines.push("");
  lines.push(`The sequence: ${steps.length} steps. A step that says stop means nothing later is safe until you know why.`);
  let phase = "";
  for (const s of steps) {
    if (s.phase !== phase) {
      phase = s.phase;
      lines.push("");
      lines.push(`== ${phase} ==`);
    }
    lines.push("");
    lines.push(`Step ${s.n} of ${steps.length}: ${s.title}`);
    lines.push(`  spends:     ${s.spends}`);
    lines.push(`  reversible: ${s.reversible}`);
    lines.push(`  caps:       ${s.caps}`);
    if (s.commands.length > 0) {
      lines.push("  run:");
      for (const c of s.commands) lines.push(`    ${c}`);
    } else {
      lines.push("  run:        by hand (no command)");
    }
    lines.push(`  expect:     ${s.expect}`);
  }
  lines.push("");
  lines.push("After this: continue with docs/MAINNET-RUNBOOK.md steps 22 to 25 (authorise an agent, three paid calls, the settlement records, the builder's withdrawal). They need an agent key and a builder address that were not given here.");
  lines.push(`Record the facts of the deployment as docs/MAINNET-GO-LIVE.md says (the router and vault addresses, the transaction hashes, the block numbers and the explorer links).`);
  lines.push(`Caps: the scripts' own ceilings are ${formatQusdc(CEILING_QUSDC)} QUSDC and ${formatQie(CEILING_QIE_WEI)} QIE, and no cap above is higher.`);
  return lines;
}

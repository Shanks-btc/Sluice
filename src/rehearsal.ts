// The testnet rehearsal's logic: what it refuses, what it needs in QIE, where it got to, and what it does next. There is no chain, no key and
// no child process in this file. scripts/rehearsal/testnet.ts supplies those, so everything here can be tested with a pretend chain.
//
// What it never does: send on any chain but QIE's testnet (chain 1983), call a faucet, use a key it was not given, or print a key.
import { formatQie } from "./guard";
import { MEASURED_GAS, SMOKE_GAS_TOTAL, costWei } from "./gas-figures";

const QIE = 10n ** 18n;

export const REHEARSAL_CHAIN_ID = 1983;
export const MAINNET_CHAIN_ID = 1990;
/** No single transaction may cost more than this: its gas limit times its gas price. */
export const PER_TX_CAP_WEI = QIE / 20n; // 0.05 QIE
/** The facilitator's daily QIE budget for the run, and what the pre-flight check compares the relayer's balance with. */
export const RELAYER_DAILY_BUDGET_WEI = QIE / 50n; // 0.02 QIE
/** The most QIE one top-up from the facilitator may carry (its default cap is 0.001; the hard ceiling is 0.0015). */
export const TOP_UP_MAX_WEI = QIE / 1000n; // 0.001 QIE
/** The amounts asked of the faucet are rounded up to this. */
export const FUNDING_STEP_WEI = QIE / 200n; // 0.005 QIE
/** The gas price docs/GAS.md measured at. A price below it is not used to size the funding. */
export const PRICE_FLOOR_WEI = 1_125_000_000n;

/** The two throwaway keys' addresses, as the founder gave them. The orchestrator checks the key files against these before it uses either. */
export const EXPECTED_ADDRESSES = {
  deployer: "0xA628018769dacfcdB84dc58A68D2CaA982C77877",
  relayer: "0x5f49b193BAe4D8Ec010a191DC41b8d5fAC16D772",
} as const;

/**
 * The testnet's explorer and faucet, as QIE's documentation gives them (docs.qie.digital, the page "Access Mainnet or Testnet", read on
 * 2026-11-20). Whether the explorer's source-verification endpoint works is not confirmed. The faucet is for a person to use: nothing here calls it.
 */
export const TESTNET_EXPLORER = "https://testnet.qie.digital";
export const TESTNET_FAUCET_PAGE = "https://www.qie.digital/faucet";

export class RehearsalRefused extends Error {}
export class StateError extends Error {}

// ------------------------------------------------------------------------------------------------------------------------ what it refuses

/** Stops the run unless the node says it is on QIE's testnet. Chain 1990 gets its own words, because it is the one that must never be touched. */
export function assertTestnetChain(reported: bigint | number | string, who = "the node"): void {
  let chain: bigint;
  try {
    chain = BigInt(reported);
  } catch {
    throw new RehearsalRefused(`refusing to send: ${who} gave no chain id`);
  }
  if (chain === BigInt(MAINNET_CHAIN_ID)) {
    throw new RehearsalRefused(`refusing to send: ${who} reports chain ${MAINNET_CHAIN_ID}, which is QIE mainnet. This rehearsal sends on the testnet (chain ${REHEARSAL_CHAIN_ID}) and nowhere else`);
  }
  if (chain !== BigInt(REHEARSAL_CHAIN_ID)) {
    throw new RehearsalRefused(`refusing to send: ${who} reports chain ${chain}, not the testnet's ${REHEARSAL_CHAIN_ID}`);
  }
}

/** The command line and the environment, before anything is read or opened. The network is not a choice here. */
export function refuseUnsafeSettings(env: Record<string, string | undefined>, argv: string[]): { status: boolean } {
  const network = env.SLUICE_NETWORK?.trim();
  if (network && network !== "testnet") {
    throw new RehearsalRefused(`refusing to run: SLUICE_NETWORK is "${network.slice(0, 20)}", and this rehearsal runs on the testnet only. Unset it, or set it to testnet`);
  }
  const rpc = env.SLUICE_RPC_URL?.trim();
  if (rpc && /mainnet/i.test(rpc)) {
    throw new RehearsalRefused("refusing to run: SLUICE_RPC_URL names a mainnet endpoint. This rehearsal sends on the testnet (chain 1983) and nowhere else");
  }
  let status = false;
  for (const arg of argv) {
    if (arg === "--status") status = true;
    else if (/^--network/.test(arg)) throw new RehearsalRefused("refusing to run: the network is not a choice here, it is always the testnet (chain 1983)");
    else throw new RehearsalRefused(`refusing to run: unknown option ${arg.slice(0, 40)}. The only option is --status`);
  }
  return { status };
}

/** A transaction whose worst case is above the cap is not sent. The worst case is the gas limit at the gas price. */
export function assertUnderTxCap(gasLimit: bigint, gasPrice: bigint, what: string): void {
  const worst = gasLimit * gasPrice;
  if (worst > PER_TX_CAP_WEI) {
    throw new RehearsalRefused(`refusing to send ${what}: it could cost ${formatQie(worst)} QIE, above the cap of ${formatQie(PER_TX_CAP_WEI)} QIE for one transaction`);
  }
}

// -------------------------------------------------------------------------------------------------------------------------- what it needs

/** Gas figures from docs/GAS.md that gas-figures.ts does not hold. A test holds them to that document. */
export const GAS_DOC = {
  authorizeBySignature: 134_066n,
  batch10Worst: 695_167n,
} as const;

export type FundingPart = { what: string; gas: bigint };
export type FundingNeed = { role: "deployer" | "relayer"; address: string; minWei: bigint; priceWei: bigint; parts: FundingPart[]; extraWei: bigint };

/** What the deployer's address sends: the test token (the limits its script allows), the router and the smoke run (docs/GAS.md), a mint and a withdraw. */
export const DEPLOYER_PARTS: readonly FundingPart[] = [
  { what: "deploy the test token (the script's limit)", gas: 1_500_000n },
  { what: "mint the deployer's test tokens (the script's limit)", gas: 100_000n },
  { what: "deploy the router (docs/GAS.md)", gas: MEASURED_GAS.deployRouter },
  { what: "the smoke run's eight transactions (docs/GAS.md)", gas: SMOKE_GAS_TOTAL },
  { what: "mint test tokens to the throwaway owner (a bound)", gas: 100_000n },
  { what: "the builder's withdraw (docs/GAS.md)", gas: MEASURED_GAS.withdraw },
];

/** What the relayer's address sends through the facilitator: one session, one top-up, and room for four batches of ten intents. */
export const RELAYER_PARTS: readonly FundingPart[] = [
  { what: "authorise the agent's session by signature (docs/GAS.md)", gas: GAS_DOC.authorizeBySignature },
  { what: "the top-up transfer (docs/GAS.md)", gas: MEASURED_GAS.topUpTransfer },
  { what: "four batches of ten intents, for the settlement and the restart drill (docs/GAS.md)", gas: 4n * GAS_DOC.batch10Worst },
];

export const roundUp = (wei: bigint, step: bigint = FUNDING_STEP_WEI): bigint => ((wei + step - 1n) / step) * step;

/** A gas price in gwei, with as many decimals as it needs and no more: 1.125, or 0.000000007. */
export function formatGwei(wei: bigint): string {
  const whole = wei / 1_000_000_000n;
  const frac = (wei % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

const sumGas = (parts: readonly FundingPart[]): bigint => parts.reduce((s, p) => s + p.gas, 0n);

/**
 * The QIE each address must hold before anything is sent, at the gas price read from the chain (never below the price docs/GAS.md used),
 * with half again on top for the price moving. The relayer's figure is also at least what the pre-flight check asks of a relayer: five of
 * the largest batches measured, which the check calls a failure to be below.
 */
export function fundingNeeds(gasPriceWei: bigint, addresses: { deployer: string; relayer: string }): { deployer: FundingNeed; relayer: FundingNeed } {
  const price = gasPriceWei > PRICE_FLOOR_WEI ? gasPriceWei : PRICE_FLOOR_WEI;
  const deployerWei = roundUp(costWei(sumGas(DEPLOYER_PARTS), price, 50n));
  const preflightFloor = (costWei(MEASURED_GAS.batch50Worst * 5n, price) * 120n) / 100n;
  const relayerOwn = costWei(sumGas(RELAYER_PARTS), price, 50n) + TOP_UP_MAX_WEI;
  const relayerWei = roundUp([preflightFloor, RELAYER_DAILY_BUDGET_WEI, relayerOwn].reduce((a, b) => (b > a ? b : a)));
  return {
    deployer: { role: "deployer", address: addresses.deployer, minWei: deployerWei, priceWei: price, parts: [...DEPLOYER_PARTS], extraWei: 0n },
    relayer: { role: "relayer", address: addresses.relayer, minWei: relayerWei, priceWei: price, parts: [...RELAYER_PARTS], extraWei: TOP_UP_MAX_WEI },
  };
}

export type Shortfall = { role: "deployer" | "relayer"; address: string; have: bigint; need: bigint };

export function shortfalls(needs: { deployer: FundingNeed; relayer: FundingNeed }, balances: { deployer: bigint; relayer: bigint }): Shortfall[] {
  const out: Shortfall[] = [];
  for (const role of ["deployer", "relayer"] as const) {
    if (balances[role] < needs[role].minWei) out.push({ role, address: needs[role].address, have: balances[role], need: needs[role].minWei });
  }
  return out;
}

/** What to print when an address holds too little. It names the address and the amount, says where to get it, and says that no faucet was called. */
export function faucetStopLines(short: Shortfall[], priceWei: bigint, readPriceWei?: bigint): string[] {
  const lines = ["STOP: the rehearsal needs testnet QIE before it can send anything."];
  for (const s of short) {
    lines.push(`  ${s.role} ${s.address} holds ${formatQie(s.have)} QIE and needs at least ${formatQie(s.need)} QIE (${formatQie(s.need - s.have)} more).`);
  }
  lines.push(`  The sizes are from the gas docs/GAS.md measured, at ${formatGwei(priceWei)} gwei with half again on top, and no single transaction may cost more than ${formatQie(PER_TX_CAP_WEI)} QIE.`);
  if (readPriceWei !== undefined && readPriceWei < priceWei) {
    lines.push(`  The testnet's own gas price reads ${formatGwei(readPriceWei)} gwei just now, so the real cost may be far below this; the run asks for the larger figure in case the price rises.`);
  }
  lines.push(`  QIE's documentation gives the faucet as ${TESTNET_FAUCET_PAGE}. This run did not open it.`);
  lines.push("  Get it from QIE's testnet faucet, then run pnpm rehearsal:testnet again.");
  lines.push("  This run called no faucet and sent nothing. The run keeps its place in rehearsal-state.json and carries on from here.");
  return lines;
}

// --------------------------------------------------------------------------------------------------------------------------------- state

export type StepId =
  | "keys" | "endpoint" | "funding"
  | "token" | "preflight-pre" | "deploy-dry" | "deploy" | "record-deploy" | "preflight-post"
  | "smoke-dry" | "smoke" | "record-smoke"
  | "facilitator" | "tool-server"
  | "funded-flow" | "settlement" | "record-flow"
  | "restart-drill" | "killswitch-drill"
  | "withdraw" | "record-withdraw"
  | "evidence" | "verify-source";

export type StepDef = { id: StepId; /** The step's number in the brief it follows, 1 to 9. */ group: number; title: string; needs: readonly StepId[] };

/** In the order they run. The builder's withdraw (step 9) runs before the evidence check (step 7), so the check sees every row. */
export const STEPS: readonly StepDef[] = [
  { id: "keys", group: 1, title: "read the two key files and check their addresses", needs: [] },
  { id: "endpoint", group: 1, title: "choose a healthy testnet endpoint and confirm chain 1983", needs: ["keys"] },
  { id: "funding", group: 1, title: "check both balances against what the run needs", needs: ["keys", "endpoint"] },
  { id: "token", group: 2, title: "deploy the test token with no value", needs: ["funding"] },
  { id: "preflight-pre", group: 2, title: "pre-flight check before the router", needs: ["token"] },
  { id: "deploy-dry", group: 2, title: "router deploy, dry run", needs: ["preflight-pre"] },
  { id: "deploy", group: 2, title: "router deploy", needs: ["deploy-dry"] },
  { id: "record-deploy", group: 2, title: "record the deploy claim (testnet)", needs: ["deploy"] },
  { id: "preflight-post", group: 2, title: "pre-flight check against the deployment", needs: ["deploy"] },
  { id: "smoke-dry", group: 3, title: "smoke run, dry run", needs: ["preflight-post"] },
  { id: "smoke", group: 3, title: "smoke run", needs: ["smoke-dry"] },
  { id: "record-smoke", group: 3, title: "record the smoke run's claims (testnet)", needs: ["smoke"] },
  { id: "facilitator", group: 4, title: "start the facilitator on this machine", needs: ["deploy", "funding"] },
  { id: "tool-server", group: 4, title: "start the example tool server on this machine", needs: ["facilitator"] },
  { id: "funded-flow", group: 5, title: "funded flow: relayed start, agent session, paid calls", needs: ["tool-server", "token"] },
  { id: "settlement", group: 5, title: "wait for the facilitator to settle the calls", needs: ["funded-flow"] },
  { id: "record-flow", group: 5, title: "record the paid-call, relayed-start and deposit claims (testnet)", needs: ["settlement"] },
  { id: "restart-drill", group: 6, title: "drill: kill the facilitator with an intent queued, restart it", needs: ["funded-flow"] },
  { id: "killswitch-drill", group: 6, title: "drill: kill switch on, then off", needs: ["funded-flow"] },
  { id: "withdraw", group: 9, title: "the builder withdraws the settled balance", needs: ["settlement"] },
  { id: "record-withdraw", group: 9, title: "record the withdraw claim (testnet)", needs: ["withdraw"] },
  { id: "evidence", group: 7, title: "evidence:check and evidence:summary", needs: [] },
  { id: "verify-source", group: 8, title: "source verification, or the manual route", needs: ["deploy"] },
];

export type StepStatus = "done" | "failed" | "stopped" | "blocked";
export type StepRecord = { status: StepStatus; at: string; attempts: number; note?: string; error?: string };

export type TxRecord = {
  step: StepId;
  label: string;
  hash: string;
  block?: number;
  gasUsed?: string;
  gasPriceWei?: string;
  costWei?: string;
};

/** Addresses, hashes and numbers. Never a key. */
export type RehearsalData = {
  deployer?: string;
  relayer?: string;
  owner?: string;
  agent?: string;
  endpoint?: string;
  gasPriceWei?: string;
  startBalances?: { deployer: string; relayer: string };
  token?: string;
  router?: string;
  vault?: string;
  deployHash?: string;
  deployBlock?: number;
  facilitatorPort?: number;
  toolsPort?: number;
  [key: string]: unknown;
};

export type RehearsalState = {
  version: 1;
  network: "testnet";
  chainId: 1983;
  createdAt: string;
  updatedAt: string;
  steps: Partial<Record<StepId, StepRecord>>;
  data: RehearsalData;
  txs: TxRecord[];
  /** What the drills showed, as lines of text. They are logged, and are not evidence rows. */
  drills: Record<string, string[]>;
};

const STEP_IDS = new Set<string>(STEPS.map((s) => s.id));
const STATUSES = new Set(["done", "failed", "stopped", "blocked"]);
const HASH = /^0x[0-9a-fA-F]{64}$/;

export function newState(now: string): RehearsalState {
  return { version: 1, network: "testnet", chainId: 1983, createdAt: now, updatedAt: now, steps: {}, data: {}, txs: [], drills: {} };
}

/** Reads a state file's text. A file that is damaged, or is for another network, is refused and never replaced: a half-done deployment would be lost. */
export function parseState(text: string): RehearsalState {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new StateError("rehearsal-state.json is not readable JSON, so the run does not know where it got to. Fix or delete it, knowing that deleting it forgets what was deployed");
  }
  const s = raw as Partial<RehearsalState> | null;
  if (!s || typeof s !== "object" || s.version !== 1) throw new StateError("rehearsal-state.json has an unknown version");
  if (s.network !== "testnet" || s.chainId !== 1983) throw new StateError("rehearsal-state.json is not for the testnet (chain 1983), so it is not used");
  if (typeof s.steps !== "object" || s.steps === null || typeof s.data !== "object" || s.data === null || !Array.isArray(s.txs) || typeof s.drills !== "object" || s.drills === null) {
    throw new StateError("rehearsal-state.json is missing parts it needs");
  }
  for (const [id, rec] of Object.entries(s.steps)) {
    const r = rec as StepRecord;
    if (!STEP_IDS.has(id) || !r || !STATUSES.has(r.status) || typeof r.at !== "string") throw new StateError(`rehearsal-state.json has a step it does not know: ${id.slice(0, 30)}`);
  }
  for (const tx of s.txs) {
    if (!tx || typeof tx.hash !== "string" || !HASH.test(tx.hash) || typeof tx.label !== "string") throw new StateError("rehearsal-state.json has a transaction record that is not a transaction hash");
  }
  return s as RehearsalState;
}

/** The state as text. It refuses to produce text that holds a secret it was told about. */
export function serializeState(state: RehearsalState, secrets: readonly string[] = []): string {
  const text = `${JSON.stringify(state, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`;
  for (const secret of secrets) {
    if (secret && text.includes(secret)) throw new StateError("refusing to write the state: it would hold a key");
  }
  return text;
}

/** Adds a transaction once: a hash already recorded is not added again, and a later record fills in what the first lacked. */
export function addTx(state: RehearsalState, tx: TxRecord): void {
  const hash = tx.hash.toLowerCase();
  const at = state.txs.findIndex((t) => t.hash.toLowerCase() === hash);
  if (at === -1) {
    state.txs.push({ ...tx, hash });
    return;
  }
  const old = state.txs[at] as TxRecord;
  const fill = Object.fromEntries(Object.entries(tx).filter(([key, value]) => value !== undefined && (old as Record<string, unknown>)[key] === undefined));
  state.txs[at] = { ...old, ...fill, hash } as TxRecord;
}

/** The transaction hashes in a script's output lines, each with a label made from the words in front of it. */
export function hashesIn(step: StepId, lines: readonly string[]): TxRecord[] {
  const out: TxRecord[] = [];
  for (const line of lines) {
    for (const m of line.matchAll(/0x[0-9a-fA-F]{64}/g)) {
      const before = line
        .slice(0, m.index)
        .replace(/0x[0-9a-fA-F]{40}/g, "")
        .replace(/[:(\-–]+\s*$/g, "")
        .replace(/[:(]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const block = /block (\d+)/.exec(line.slice((m.index ?? 0) + 66));
      out.push({ step, label: before || step, hash: m[0].toLowerCase(), ...(block ? { block: Number(block[1]) } : {}) });
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------- gas, against docs/GAS.md

/** The figure docs/GAS.md gives for a transaction, by the label the scripts print it under. */
export function measuredFor(label: string): { gas: bigint; basis: string } | undefined {
  const l = label.toLowerCase();
  const table: Array<[RegExp, bigint, string]> = [
    [/^approve\b/, MEASURED_GAS.approve, "approve"],
    [/^deposit\b/, MEASURED_GAS.depositFirst, "deposit, first for this payer"],
    [/payer-signed/, MEASURED_GAS.settleFirst, "settle, first payment to a builder"],
    [/agent-signed/, MEASURED_GAS.settleByAgentFirst, "settle signed by an agent, first spend"],
    [/^authorize agent\b/, MEASURED_GAS.authorize, "authorize an agent, one tool"],
    [/^revoke\b/, MEASURED_GAS.revoke, "revoke an agent"],
    [/^withdraw\b/, MEASURED_GAS.withdraw, "withdraw, part of earnings"],
    [/^refund\b/, MEASURED_GAS.refund, "refund, part of the balance"],
    [/router deploy|^deploy router\b|^deploy$/, MEASURED_GAS.deployRouter, "deploy the router"],
    [/^top-up\b/, MEASURED_GAS.topUpTransfer, "top-up transfer"],
  ];
  for (const [re, gas, basis] of table) if (re.test(l)) return { gas, basis };
  return undefined;
}

// --------------------------------------------------------------------------------------------------------------------------------- engine

export type StepOutcome = { kind: "done"; note?: string } | { kind: "stop"; lines: string[] };

export type EngineDeps = {
  state: RehearsalState;
  save: () => void;
  /** Runs one step. It returns an outcome, or throws; a throw fails that step and the run goes on with the steps that do not need it. */
  run: (step: StepDef) => Promise<StepOutcome>;
  log: (line: string) => void;
  now?: () => string;
  redact?: (text: string) => string;
};

export type EngineResult = { done: StepId[]; skipped: StepId[]; failed: StepId[]; blocked: StepId[]; stopped?: StepId; aborted?: StepId };

/**
 * Runs the steps in order and keeps its place in the state, so a second run carries on from where the first stopped.
 *  - A step that is done is skipped.
 *  - A step whose prerequisite is not done is blocked, and the steps that do not need it still run.
 *  - A step that fails records its exact error and the run continues.
 *  - A step that stops (it needs QIE from the faucet) ends the run, with its lines printed.
 *  - A refusal to touch the wrong chain ends the run at once: nothing after it runs.
 */
export async function runRehearsal(steps: readonly StepDef[], deps: EngineDeps): Promise<EngineResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const redact = deps.redact ?? ((t: string) => t);
  const result: EngineResult = { done: [], skipped: [], failed: [], blocked: [] };
  const record = (id: StepId, status: StepStatus, extra: { note?: string; error?: string } = {}): void => {
    const attempts = (deps.state.steps[id]?.attempts ?? 0) + (status === "blocked" ? 0 : 1);
    deps.state.steps[id] = { status, at: now(), attempts, ...extra };
    deps.state.updatedAt = now();
    deps.save();
  };
  for (const step of steps) {
    const before = deps.state.steps[step.id];
    if (before?.status === "done") {
      deps.log(`Step ${step.group}, ${step.title}: done earlier (${before.at}), not run again`);
      result.skipped.push(step.id);
      continue;
    }
    const missing = step.needs.filter((n) => deps.state.steps[n]?.status !== "done");
    if (missing.length > 0) {
      deps.log(`Step ${step.group}, ${step.title}: not run, it needs ${missing.join(", ")}`);
      record(step.id, "blocked", { note: `needs ${missing.join(", ")}` });
      result.blocked.push(step.id);
      continue;
    }
    deps.log("");
    deps.log(`Step ${step.group}: ${step.title}`);
    let outcome: StepOutcome;
    try {
      outcome = await deps.run(step);
    } catch (err) {
      const message = redact(err instanceof Error ? err.message : "the step failed");
      deps.log(`  FAILED: ${message}`);
      record(step.id, "failed", { error: message.slice(0, 2000) });
      result.failed.push(step.id);
      if (err instanceof RehearsalRefused) {
        result.aborted = step.id;
        deps.log("  The run stops here: a refusal like this one means nothing after it may run.");
        break;
      }
      continue;
    }
    if (outcome.kind === "stop") {
      for (const line of outcome.lines) deps.log(line);
      record(step.id, "stopped", { note: outcome.lines[0] ?? "stopped" });
      result.stopped = step.id;
      break;
    }
    record(step.id, "done", outcome.note ? { note: outcome.note } : {});
    deps.log(`  done${outcome.note ? `: ${outcome.note}` : ""}`);
    result.done.push(step.id);
  }
  return result;
}

/** One line per step for `pnpm rehearsal:testnet --status`. */
export function statusLines(state: RehearsalState, steps: readonly StepDef[] = STEPS): string[] {
  const lines = [`rehearsal on the testnet (chain 1983), started ${state.createdAt}, updated ${state.updatedAt}`];
  for (const step of steps) {
    const rec = state.steps[step.id];
    lines.push(`  ${String(step.group).padStart(1)} ${step.id.padEnd(17)} ${(rec?.status ?? "not run").padEnd(8)} ${rec?.error ?? rec?.note ?? ""}`.trimEnd());
  }
  if (state.data.router) lines.push(`router ${state.data.router}, token ${state.data.token ?? "?"}`);
  return lines;
}

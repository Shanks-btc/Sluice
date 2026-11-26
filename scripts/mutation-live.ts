// pnpm mutation:live
//
// The same check as `pnpm mutation:check`, for the go-live tooling: the facilitator's durable queue and its recovery after a crash, its kill
// switch and caps and limits, the evidence recorder's verification and its labelling of networks, the settings that refuse to start, and
// the mainnet path's guards (the roles kept apart, the token and the node's chain checked, mistyped options refused), the funding
// calculator, QUSDC's facts, the settings files and the fork evidence. It
// changes one condition at a time, runs the tests meant to catch that change, and reports whether they failed. It edits files in place and
// puts each one back (see src/mutation.ts), so run it on a copy. It sends nothing anywhere.
//
// Exit code 0: every change was caught. 1: a change survived or could not be applied. 2: the tests failed before any change.
import { join } from "node:path";
import { MutationError, runMutations, summarizeResults } from "../src/mutation";
import type { Mutation } from "../src/mutation";
import { hardhatRunner } from "./mutation-check";

const OPS = "test/unit/facilitator/operations.test.ts";
const DUR = "test/unit/facilitator/durability.test.ts";
const CRASH = "test/unit/facilitator/crash.test.ts";
const REC = "test/unit/recorder.test.ts";
const LIVE = "test/unit/live-tools.test.ts";
const GUARDS = "test/unit/mainnet-guards.test.ts";
const TOOLS = "test/unit/mainnet-tools.test.ts";

const F = "packages/facilitator/src";
const m = (id: string, file: string, find: string, replace: string, why: string, tests: string[]): Mutation => ({ id, file, find, replace, why, tests });

export const LIVE_MUTATIONS: Mutation[] = [
  // The kill switch, the store gate and the order of a batch's life
  m("G01", `${F}/service.ts`, "if (this.killSwitch.active()) {", "if (false) {", "ignore the kill switch", [OPS]),
  m("G02", `${F}/service.ts`, "if (!this.store.healthy()) {", "if (false) {", "carry on when the queue store cannot be written", [DUR]),
  m("G03", `${F}/service.ts`, "if (blocked) return { isValid: false, invalidReason: blocked, payer };", "if (false) return { isValid: false, invalidReason: blocked, payer };", "say a payment is valid while the facilitator cannot settle it", [OPS, DUR]),
  m("G04", `${F}/service.ts`, "this.store.putMany(current); // before the transaction exists. If this write fails, nothing is sent.", "// not written", "send a batch without writing it down as submitted first", [DUR]),
  m("G05", `${F}/service.ts`, "this.store.putMany(current); // the hash, as soon as the node has it", "// not written", "not write the transaction hash down when the node has it", [CRASH]),
  m("G06", `${F}/service.ts`, "if (counted.has(r.id)) continue;", "if (false) continue;", "count a payment twice once its batch is mined", [DUR]),
  m("G07", `${F}/service.ts`, "if (await relayerBusy()) {", "if (false) {", "send a batch again while the first is still waiting", [DUR]),
  m("G08", `${F}/service.ts`, "        if (used) {\n          // 3", "        if (false) {\n          // 3", "send a batch again when the chain shows it was mined", [DUR, CRASH]),

  // The caps on the relayer's own QIE
  m("G09", `${F}/service.ts`, "if (this.store.usage(topUpKey).amount + topUp > this.caps.topUpPerAddressDailyWei) {", "if (false) {", "top up one address past its daily cap", [OPS]),
  m("G10", `${F}/relayer.ts`, "if (sent + valueWei > this.#caps.topUpPerAddressDailyWei) {", "if (false) {", "let the relayer send one address more than its daily cap", [OPS]),
  m("G11", `${F}/caps.ts`, "if (value > ceiling) throw new CapConfigError(", "if (false) throw new CapConfigError(", "accept a cap above its hard ceiling", [OPS]),

  // The journal
  m("J01", `${F}/store.ts`, "ftruncateSync(fd, keep);", "", "leave a half-written line in the journal", [DUR]),
  m("J02", `${F}/store.ts`, 'throw new StoreError("the queue store is damaged: a line does not read", "corrupt");', "continue;", "skip a damaged line instead of refusing to start", [DUR]),
  m("J03", `${F}/store.ts`, 'this.broken = "the queue store could not be written, so nothing more is accepted or sent";', "this.broken = undefined;", "carry on after a write failed", [DUR]),
  m("J04", `${F}/store.ts`, "if (Number.isInteger(holder) && holder > 0 && holder !== pid && isAlive(holder)) {", "if (false) {", "let two processes use one journal", [DUR, OPS]),

  // Settings and limits
  m("S01", `${F}/env.ts`, 'if (network !== "local" && !statePath) {', "if (false) {", "start on mainnet or testnet with a queue held only in memory", [OPS]),
  m("S02", `${F}/env.ts`, "throw new EnvError(`refusing to start: ${name} must be 1 or 0`);", "return false;", "leave the kill switch off when its setting is mistyped", [OPS]),
  m("S03", `${F}/server.ts`, "if (!byPayer.ok) return limited(", "if (false) return limited(", "not limit requests that name one payer", [OPS]),
  m("S04", "packages/sdk/src/ratelimit.ts", "if (trustedHops <= 0) return socket;", "if (false) return socket;", "believe X-Forwarded-For with no proxy configured", [OPS]),
  m("S05", "packages/sdk/src/logger.ts", 'out[k] = SENSITIVE_NAME.test(k) ? "[redacted]" : scrubValue(v, secrets, depth + 1);', "out[k] = scrubValue(v, secrets, depth + 1);", "log a field named key or secret in the clear", [OPS]),

  // The evidence recorder and the file
  m("R01", "src/recorder.ts", 'if (receipt.status !== "0x1") throw new RecordError(', "if (false) throw new RecordError(", "record a transaction that failed", [REC]),
  m("R02", "src/recorder.ts", 'if (typeof chain !== "string" || BigInt(chain) !== BigInt(CHAIN_ID[network])) {', "if (false) {", "record a transaction from the wrong network", [REC]),
  m("R03", "src/recorder.ts", "if (separator !== expected) throw new RecordError(", "if (false) throw new RecordError(", "record events from an address that is not a Sluice router", [REC]),
  m("R04", "src/recorder.ts", "const outsider = ![e.args.payer, e.args.payee, e.args.signer].some((a) => getAddress(String(a)) === sender);", "const outsider = true;", "call a payer's own settlement a paid call settled by a third party", [REC]),
  m("R05", "src/recorder.ts", 'if (typeof balance !== "string" || BigInt(balance) !== 0n) throw new RecordError(', "if (false) throw new RecordError(", "call a start a start from zero QIE when the payer held QIE", [REC]),
  m("R06", "src/recorder.ts", "if (existing.has(key)) throw new RecordError(", "if (false) throw new RecordError(", "record the same row twice", [REC]),
  m("R07", "src/evidence.ts", "if (labelled !== network) throw new Error(", "if (false) throw new Error(", "read a fork row in the mainnet table as mainnet proof", [REC]),
  m("R08", "src/evidence.ts", "if (legacyTables.length > 0) {", "if (false) {", "accept an evidence table with no Network column", [REC]),
  m("R09", "scripts/evidence/record.ts", "if (file === evidencePath) throw new UsageError(", "if (false) throw new UsageError(", "write a fork run into docs/EVIDENCE.md", [REC]),
  m("R10", "src/readrpc.ts", "if (!allowed.has(method)) throw new Error(", "if (false) throw new Error(", "let the recorder or the pre-flight check send a method that is not read-only", [REC, LIVE]),

  // The mainnet deploy's guards: parameters, roles, the token, the node's chain, and the options that are refused
  m("P01", "src/live.ts", "if (owner === ZERO_ADDRESS) throw new GuardError(", "if (false) throw new GuardError(", "make the zero address the router's owner", [GUARDS]),
  m("P02", "src/live.ts", "if (feeRecipient === ZERO_ADDRESS) throw new GuardError(", "if (false) throw new GuardError(", "credit the fees to the zero address", [GUARDS]),
  m("P03", "src/live.ts", "Number(rawFee) > MAX_FEE_BPS)) {", "Number(rawFee) > 2000)) {", "accept a fee of 201 to 999 basis points", [GUARDS]),
  m("P04", "src/live.ts", "feeBps: rawFee ? Number(rawFee) : DEFAULT_FEE_BPS", "feeBps: rawFee ? Number(rawFee) : 0", "default the fee to nothing instead of 1%", [GUARDS]),
  m("P05", "src/live.ts", 'if (network === "mainnet" && !who.relayer) {', "if (false) {", "deploy on mainnet without the relayer's address, so the roles cannot be checked", [GUARDS]),
  m("P06", "src/live.ts", "if (owner === deployer) throw new GuardError(", "if (false) throw new GuardError(", "make the deployer key the owner", [GUARDS]),
  m("P07", "src/live.ts", "if (feeRecipient === deployer) throw new GuardError(", "if (false) throw new GuardError(", "make the deployer key the fee recipient", [GUARDS]),
  m("P08", "src/live.ts", "if (relayer && owner === relayer) throw new GuardError(", "if (false) throw new GuardError(", "make the relayer the owner", [GUARDS]),
  m("P09", "src/live.ts", "if (relayer && feeRecipient === relayer) throw new GuardError(", "if (false) throw new GuardError(", "make the relayer the fee recipient", [GUARDS]),
  m("P10", "src/live.ts", "if (relayer && relayer === deployer) throw new GuardError(", "if (false) throw new GuardError(", "use one key as the deployer and the relayer", [GUARDS]),
  m("P11", "src/live.ts", 'if ((await provider.getCode(where)) === "0x") throw new GuardError(', "if (false) throw new GuardError(", "deploy with a token address that holds no contract", [GUARDS]),
  m("P12", "src/live.ts", "if (Number(decimals) !== 6) throw new GuardError(", "if (false) throw new GuardError(", "deploy with a token that does not have six decimals", [GUARDS]),
  m("P13", "src/live.ts", "await checkDeployToken(ctx.provider, p.token);", "", "skip the token check inside the deploy function", [GUARDS]),
  m("P14", "src/live.ts", 'if (network === "mainnet" && token !== getAddress(QUSDC_ADDRESS)) {', "if (false) {", "deploy a mainnet router for another token", [GUARDS]),
  m("P15", "scripts/live/deploy.ts", "throw new GuardError(`refusing to run deploy: unknown option", "continue; void new GuardError(`refusing to run deploy: unknown option", "turn a mistyped --dry-run into a real deployment", [GUARDS]),
  m("P16", "scripts/live/deploy.ts", "await requireNodeChain(provider, approval.chainId, approval.network);", "", "deploy to a node on another chain", [GUARDS]),
  m("P17", "scripts/live/smoke.ts", 'for (const flag of argv) if (flag !== "--dry-run") throw new GuardError(', 'for (const flag of argv) if (false) throw new GuardError(', "turn a mistyped --dry-run into a real smoke run", [GUARDS]),
  m("P18", "scripts/live/deploy.ts", "checkDeployRoles(params, { deployer: deployerAddress, ...(relayer ? { relayer } : {}) }, approval.network);", "", "skip the check that keeps the roles apart", [GUARDS]),
  m("P19", "packages/sdk/src/rpc.ts", "if (reported !== BigInt(chainId)) throw new Error(", "if (false) throw new Error(", "accept a node on another chain", [GUARDS]),
  m("P20", "packages/facilitator/src/runtime.ts", "await requireNodeChain(made, env.chainId, env.network);", "", "start the facilitator against a node on another chain", [TOOLS]),
  m("P21", "examples/paid-tools/src/host.ts", "await requireNodeChain(provider, env.chainId, env.network);", "", "start the tool server against a node on another chain", [TOOLS]),
  m("P22", "src/exit.ts", "process.exitCode = code;", "", "end a command with exit code 0 whatever it found", [GUARDS]),

  // The funding calculator, QUSDC's facts, the wiring, and the fork evidence
  m("P23", "src/funding.ts", "return (reserveIn * out * 1000n) / ((reserveOut - out) * 997n) + 1n;", "return (reserveIn * out * 1000n) / ((reserveOut - out) * 997n);", "price QUSDC from the pool one unit too low", [TOOLS]),
  m("P24", "src/funding.ts", "out >= reserveOut) return undefined;", "out > reserveOut) return undefined;", "say the pool can supply all of its QUSDC", [TOOLS]),
  m("P25", "src/funding.ts", "deployerQieWei: costWei(deployerGas, p.gasPrice, (p.margin - 1n) * 100n),", "deployerQieWei: costWei(deployerGas, p.gasPrice),", "leave the margin off the deployer's QIE", [TOOLS]),
  m("P26", "src/funding.ts", "relayerHoldWei: max(relayerRunQieWei, max(relayerFloorWei, p.dailyBudgetWei)),", "relayerHoldWei: relayerRunQieWei,", "tell the relayer to hold only what the run needs, below the low-balance line", [TOOLS]),
  m("P27", "src/funding.ts", "const relayerTopUpWei = costWei(ONBOARD_APPROVE_GAS + ONBOARD_DEPOSIT_GAS, p.gasPrice, 10n);", "const relayerTopUpWei = costWei(ONBOARD_APPROVE_GAS + ONBOARD_DEPOSIT_GAS, p.gasPrice);", "leave out the tenth above the price that the owner's transactions are signed at", [TOOLS]),
  m("P28", "src/funding.ts", "const up = ((wei + unit - 1n) / unit) * unit;", "const up = (wei / unit) * unit;", "print a need rounded down", [TOOLS]),
  m("P29", "scripts/live/funding.ts", "if (runQusdc > CEILING_QUSDC) throw new UsageError(", "if (false) throw new UsageError(", "plan a funded run above the live scripts' ceiling", [TOOLS]),
  m("P30", "scripts/live/funding.ts", "if (deployer && relayer && deployer === relayer) throw new UsageError(", "if (false) throw new UsageError(", "plan with one address as the deployer and the relayer", [TOOLS]),
  m("P31", "scripts/live/funding.ts", "if (reads.chainId !== 1990) {", "if (false) {", "price a funding plan from a chain that is not mainnet", [TOOLS]),
  m("P32", "src/qusdc-facts.ts", 'if (f.strangerCanBurn === "yes") d.push(', "if (false) d.push(", "read a burn that anyone can make as a role check", [TOOLS]),
  m("P33", "src/qusdc-facts.ts", "if (f.upgradeable) d.push(", "if (false) d.push(", "miss that QUSDC has become upgradeable", [TOOLS]),
  m("P34", "src/qusdc-facts.ts", "const upgradeable = slots.some((s) => !/^0x0*$/.test(s));", "const upgradeable = false;", "never look at the upgrade slots", [TOOLS]),
  m("P35", "src/qusdc-facts.ts", "if (!f.vaultRoleHolderHasVaultRole) d.push(", "if (false) d.push(", "miss that the vault role has moved to another holder", [TOOLS]),
  m("P36", "src/wire.ts", "if (raw.network !== network) throw new WireError(", "if (false) throw new WireError(", "wire a testnet deployment into mainnet settings", [TOOLS]),
  m("P37", "src/wire.ts", 'if (network === "mainnet" && token !== getAddress(QUSDC_ADDRESS)) throw new WireError(', "if (false) throw new WireError(", "wire a mainnet router that holds another token", [TOOLS]),
  m("P38", "src/wire.ts", "if (HEX64.test(e.value)) throw new WireError(", "if (false) throw new WireError(", "write a key-shaped value into a settings file", [TOOLS]),
  m("P39", "scripts/live/wire.ts", "if (taken.length > 0 && !force) throw new UsageError(", "if (false) throw new UsageError(", "overwrite settings files a person has filled in", [TOOLS]),
  m("P40", "src/recorder.ts", 'if (labelled !== "fork") throw new RecordError(', "if (false) throw new RecordError(", "read another network's row in the Fork table", [TOOLS]),
  m("P41", "scripts/evidence-check.ts", "if (fork && !fileArg) {", "if (false) {", "check fork rows against docs/EVIDENCE.md", [GUARDS]),
  m("P42", "scripts/evidence-check.ts", "if (fork && fileArg && resolve(fileArg) === resolve(realPath)) {", "if (false) {", "read fork rows from docs/EVIDENCE.md itself", [GUARDS]),
  m("P43", "scripts/evidence-summary.ts", "if (fork && fileIndex < 0) {", "if (false) {", "count a fork run without a copy of the evidence file", [GUARDS]),
];

function main(): number {
  const root = join(__dirname, "..");
  const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const chosen = only.length ? LIVE_MUTATIONS.filter((x) => only.includes(x.id)) : LIVE_MUTATIONS;
  console.log(`${chosen.length} mutation${chosen.length === 1 ? "" : "s"} in the go-live tooling. Each runs the tests meant to catch it; this takes a while.`);
  let results;
  try {
    results = runMutations(root, chosen, hardhatRunner(root), console.log);
  } catch (err) {
    console.error(err instanceof MutationError ? err.message : "the mutation run failed");
    return 2;
  }
  const s = summarizeResults(results);
  console.log("");
  for (const r of results) console.log(`${r.status.padEnd(8)} ${r.id}  ${LIVE_MUTATIONS.find((x) => x.id === r.id)!.why}`);
  console.log(`\n${s.killed} killed, ${s.survived} survived, ${s.broken} broken, of ${results.length}`);
  return s.survived + s.broken > 0 ? 1 : 0;
}

if (require.main === module) process.exit(main());

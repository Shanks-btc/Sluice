// pnpm mutation:live
//
// The same check as `pnpm mutation:check`, for the go-live tooling: the facilitator's durable queue and its recovery after a crash, its kill
// switch and caps and limits, the evidence recorder's verification and its labelling of networks, and the settings that refuse to start. It
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

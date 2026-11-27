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

const LEDGER = "test/unit/facilitator/ledger.test.ts";
const CONC = "test/unit/facilitator/serverless-concurrency.test.ts";
const HAND = "test/unit/facilitator/serverless-handlers.test.ts";
const UNPAID = "test/unit/facilitator/unpaid.test.ts";
const PT = "test/unit/sdk/paid-tool.test.ts";
const SHARED = "test/unit/facilitator/shared-database.test.ts";
const GUARD = "packages/sdk/src/redis-guard.ts";
const TOOLS_FILE = "examples/paid-tools/src/vercel.ts";

const F = "packages/facilitator/src";
const REDIS = `${F}/redis-ledger.ts`;
const LOCAL = `${F}/ledger.ts`;
const PAID = "packages/sdk/src/paid-tool.ts";
const m = (id: string, file: string, find: string, replace: string, why: string, tests: string[]): Mutation => ({ id, file, find, replace, why, tests });

export const LIVE_MUTATIONS: Mutation[] = [
  // The kill switch, the store gate and the order of a batch's life
  m("G01", `${F}/service.ts`, "if (this.killSwitch.active()) return this.stopped();", "if (false) return this.stopped();", "ignore the kill switch", [OPS]),
  m("G02", `${F}/service.ts`, "if (!(await this.ledger.health()).ok) return this.unrecordable();", "if (false) return this.unrecordable();", "carry on when the queue store cannot be written", [DUR]),
  m("G03", `${F}/service.ts`, "if (blocked) return invalid(blocked);", "if (false) return invalid(blocked);", "say a payment is valid while the facilitator cannot settle it", [OPS, DUR]),
  m("G04", `${F}/service.ts`, "await this.ledger.update(current, lock); // before the transaction exists. If this write fails, nothing is sent.", "// not written", "send a batch without writing it down as submitted first", [DUR]),
  m("G05", `${F}/service.ts`, "await this.ledger.update(current, lock); // the hash, as soon as the node has it", "// not written", "not write the transaction hash down when the node has it", [CRASH]),
  m("G06", `${F}/service.ts`, "if (counted.has(r.id)) continue;", "if (false) continue;", "count a payment twice once its batch is mined", [DUR]),
  m("G07", `${F}/service.ts`, "if (await relayerBusy()) {", "if (false) {", "send a batch again while the first is still waiting", [DUR]),
  m("G08", `${F}/service.ts`, "        if (used) {\n          // 3", "        if (false) {\n          // 3", "send a batch again when the chain shows it was mined", [DUR, CRASH]),

  // The caps on the relayer's own QIE
  m("G09", `${F}/service.ts`, "{ key: topUpKey, amount: topUp, maxAmount: this.caps.topUpPerAddressDailyWei },", "{ key: topUpKey, amount: topUp },", "top up one address past its daily cap", [OPS]),
  m("G10", `${F}/relayer.ts`, "if (!(await this.#ledger.reserveTopUp(day, dest, valueWei, this.#caps.topUpPerAddressDailyWei))) {", "if (false) {", "let the relayer send one address more than its daily cap", [OPS]),
  m("G11", `${F}/caps.ts`, "if (value > ceiling) throw new CapConfigError(", "if (false) throw new CapConfigError(", "accept a cap above its hard ceiling", [OPS]),

  // The journal
  m("J01", `${F}/store.ts`, "ftruncateSync(fd, keep);", "", "leave a half-written line in the journal", [DUR]),
  m("J02", `${F}/store.ts`, 'throw new StoreError("the queue store is damaged: a line does not read", "corrupt");', "continue;", "skip a damaged line instead of refusing to start", [DUR]),
  m("J03", `${F}/store.ts`, 'this.broken = "the queue store could not be written, so nothing more is accepted or sent";', "this.broken = undefined;", "carry on after a write failed", [DUR]),
  m("J04", `${F}/store.ts`, "if (Number.isInteger(holder) && holder > 0 && holder !== pid && isAlive(holder)) {", "if (false) {", "let two processes use one journal", [DUR, OPS]),

  // Settings and limits
  m("S01", `${F}/env.ts`, 'if (mode === "server" && network !== "local" && !statePath) {', "if (false) {", "start on mainnet or testnet with a queue held only in memory", [OPS]),
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

  // The guards of the services as serverless functions: the lock on the relayer and the fence it gives
  m("V01", REDIS, "if redis.call('EXISTS', KEYS[1]) == 1 then return false end", "if false then return false end", "give the relayer's lock to a second holder", [LEDGER]),
  m("V02", LOCAL, "if (current && current.expires > this.now()) return undefined;", "if (false) return undefined;", "give the lock of one process to a second holder", [LEDGER]),
  m("V03", `${F}/relayer.ts`, "await lock.release().catch(() => undefined);", "", "keep the relayer's lock after the work is done", [CONC]),
  m("V04", `${F}/vercel.ts`, "export const LOCK_TTL_MS = (MAX_DURATION_SECONDS + 30) * 1000;", "export const LOCK_TTL_MS = (MAX_DURATION_SECONDS - 30) * 1000;", "let the lock die while the function that holds it may still run", [HAND]),
  m("V05", REDIS, "if redis.call('GET', KEYS[1]) ~= ARGV[1] then return { 'stale' } end", "if false then return { 'stale' } end", "accept a write from a holder that lost the lock", [LEDGER, CONC]),
  m("V06", REDIS, "local token = tostring(redis.call('INCR', KEYS[2]))", "local token = '1'", "give every holder of the lock the same fence token", [LEDGER]),
  m("V07", LOCAL, "if (!this.holds(RELAYER_LOCK, fence.token)) throw new StaleLockError();", "if (false) throw new StaleLockError();", "accept a stale writer in one process", [LEDGER]),
  m("V08", REDIS, "if final[old] and old ~= ARGV[at + 2] then return { 'final', old, ARGV[at + 2] } end", "if false then return { 'final', old, ARGV[at + 2] } end", "move a finished payment out of its final state", [LEDGER]),

  // The check made at the moment of signing
  m("V09", `${F}/relayer.ts`, 'if (!(await lock.held(LOCK_MARGIN_MS))) throw new CapError("lock_lost", "the relayer lock was lost, so nothing was signed");', "", "sign without looking whether the lock is still held", [CONC]),
  m("V10", `${F}/relayer.ts`, "lock.held(LOCK_MARGIN_MS)", "lock.held(0)", "sign with a lock that is about to die", [CONC]),
  m("V11", `${F}/relayer.ts`, 'if (this.#maySend && !(await this.#maySend())) throw new CapError(ERRORS.killSwitch, "the operator has stopped all sends");', "", "sign without asking the kill switches again", [CONC]),

  // The two kill switches
  m("V12", `${F}/service.ts`, "if (storedSwitch) return this.stopped();", "if (false) return this.stopped();", "accept payments while the stored switch is on", [CONC]),
  m("V13", `${F}/service.ts`, "return !(await this.ledger.killSwitchOn());", "return true;", "send while the stored switch is on", [CONC]),
  m("V14", `${F}/service.ts`, "      return !(await this.ledger.killSwitchOn());\n    } catch {\n      return false;", "      return !(await this.ledger.killSwitchOn());\n    } catch {\n      return true;", "send while the stored switch cannot be read", [CONC]),
  m("V15", `${F}/service.ts`, "if (this.killSwitch.active()) return false;", "if (false) return false;", "send while the environment's switch is on", [CONC]),
  m("V16", REDIS, 'return value !== null && value !== undefined && String(value) !== "0";', 'return String(value) === "1";', "read a stored switch set to anything but 1 as off", [LEDGER]),

  // The caps, in the database
  m("V17", REDIS, "if (maxCount >= 0 and count + 1 > maxCount) or (maxAmount >= 0 and amount + tonumber(ARGV[at + 1]) > maxAmount) then", "if (maxAmount >= 0 and amount + tonumber(ARGV[at + 1]) > maxAmount) then", "queue past a daily count limit", [LEDGER]),
  m("V18", REDIS, "if (maxCount >= 0 and count + 1 > maxCount) or (maxAmount >= 0 and amount + tonumber(ARGV[at + 1]) > maxAmount) then", "if (maxCount >= 0 and count + 1 > maxCount) then", "queue past a daily amount limit", [LEDGER]),
  m("V19", REDIS, "if (maxCount >= 0 and count + 1 > maxCount) or (maxAmount >= 0 and amount + tonumber(ARGV[at]) > maxAmount) then return i - 1 end", "if false then return i - 1 end", "start and relay past the daily counters", [LEDGER, CONC]),
  m("V20", REDIS, "if spent + reserved + tonumber(ARGV[1]) > tonumber(ARGV[2]) then return { 0, spent, reserved } end", "if false then return { 0, spent, reserved } end", "spend past the relayer's daily budget", [LEDGER, CONC]),
  m("V21", REDIS, "const up = (wei: bigint): bigint => (wei + GWEI - 1n) / GWEI;", "const up = (wei: bigint): bigint => wei / GWEI;", "round the relayer's spending down", [LEDGER]),
  m("V22", `${F}/service.ts`, "const block = Math.max(await this.provider.getBlockNumber(), floor);", "const block = await this.provider.getBlockNumber();", "count a settled payment's money as free again at an old block", [CONC]),

  // One payment, one run: the claim a copy of a tool server makes before it runs anything
  m("V23", PAID, "if (!claimed) {", "if (false) {", "run a tool for a payment another copy has claimed", [HAND]),
  m("V24", PAID, 'return errorResult(ERRORS.facilitatorUnavailable, "the server cannot record what a payment is used for, so it runs nothing; send the same payment again later");', "claimed = true;", "run a tool when the claim cannot be made", [HAND]),
  m("V25", "packages/sdk/src/redis-idempotency.ts", '"NX", "PX", this.claimMs', '"PX", this.claimMs', "let every copy claim the same payment", [HAND]),
  m("V26", "packages/sdk/src/redis.ts", "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end", "if true then return redis.call('DEL', KEYS[1]) end", "let a copy give up another's claim or lock", [HAND, LEDGER]),

  // Held before the tool runs, answered only once settled
  m("V27", "examples/paid-tools/src/vercel.ts", "answerOnlyWhenSettled: true,", "answerOnlyWhenSettled: false,", "answer a hosted call before its payment has settled", [UNPAID]),
  m("V28", PAID, 'if (held.success !== true || sluice?.status !== "held" || !sluice.hold) {', "if (!sluice?.hold) {", "run a tool for a hold the facilitator did not confirm", [PT]),
  m("V29", PAID, 'if (taken.success === true && taken.extensions?.sluice?.status === "settled") {', "if (taken.success === true) {", "answer for a capture that does not say the payment settled", [PT]),
  m("V30", `${F}/service.ts`, 'if (existing && (holdHash !== undefined || existing.status === "held")) return already(existing);', "if (false) return already(existing!);", "give a held payment to another asker as queued", [UNPAID]),
  m("V31", `${F}/service.ts`, "if (!record.hold || !sameHash(keccakText(asked.token), record.hold)) return refuse(ERRORS.intentReplayed);", "if (!record.hold) return refuse(ERRORS.intentReplayed);", "release a held payment for any token", [UNPAID]),
  m("V32", `${F}/service.ts`, "if (blocked) return refuse(blocked, record); // still held, so nothing is charged", "", "release a held payment while the facilitator is stopped", [UNPAID]),
  m("V33", `${F}/service.ts`, "if (BigInt(record.deadline) < BigInt(this.now())) return refuse(ERRORS.expired, record);", "", "release a held payment past its deadline", [UNPAID]),
  m("V34", `${F}/service.ts`, "const cancelled = await this.cancelUnsent(id);", "const cancelled = false;", "leave an unsent payment to be charged after its answer was withheld", [UNPAID]),
  m("V35", `${F}/service.ts`, 'if (r?.status !== "queued") return false;', "if (!r) return false;", "mark a payment that was sent as never to be sent", [UNPAID]),
  m("V36", `${F}/service.ts`, 'if (BigInt(r.deadline) < now) expired.push(this.next(r, "expired", { reason: "the deadline passed while the payment was held, and nothing was charged" }));', "", "count a dead held payment against its payer for good", [UNPAID]),
  m("V37", REDIS, "this.key(record.status), this.key(\"counts\")]", "this.key(\"queued\"), this.key(\"counts\")]", "put a held payment in the queue", [LEDGER]),
  m("V38", REDIS, "if redis.call('GET', KEYS[2]) ~= 'held' then return 0 end", "if false then return 0 end", "release a payment that is not held", [LEDGER]),
  m("V39", LOCAL, 'if (this.store.get(record.id)?.status !== "held") return false;', "if (false) return false;", "release a payment that is not held, in one process", [LEDGER]),
  m("V40", "packages/proxy/src/proxy.ts", "again < PAYMENT_RESENDS && notYet(second)", "again < 0 && notYet(second)", "give up on a pending payment, so that the agent pays again", [UNPAID]),
  m("V41", PAID, 'if (result.isError) {\n          emit({ type: "tool_failed", tool, id });\n          return result; // nothing releases', 'if (false) {\n          emit({ type: "tool_failed", tool, id });\n          return result; // nothing releases', "charge a held payment for a tool that returns an error", [PT]),

  // One database for both services: the guard on the tool server's side of it
  m("V42", GUARD, 'throw new RedisRefused("a command this server does not use");', "", "let a tool server run any command, FLUSHALL and SCAN among them", [SHARED]),
  m("V43", GUARD, "if (!key.startsWith(this.#prefix) || key.length <= this.#prefix.length) throw", "if (false) throw", "let a tool server touch the facilitator's keys", [SHARED]),
  m("V44", GUARD, "const wanted = this.#scripts.get(script);", "const wanted: number | undefined = this.#scripts.get(script) ?? keys.length;", "let a tool server run any script", [SHARED]),
  m("V45", GUARD, "if (given.length !== wanted) throw", "if (false) throw", "give a script more keys than it takes", [SHARED]),
  m("V46", GUARD, "for (const key of given) this.#own(key);", "", "let a script be given the facilitator's keys", [SHARED]),
  m("V47", GUARD, "if (lasts === undefined || lasts > TOOL_MAX_TTL_MS) throw", "if (lasts !== undefined && lasts > TOOL_MAX_TTL_MS) throw", "let a tool server keep a key for good", [SHARED]),
  m("V48", GUARD, "if (lasts === undefined || lasts > TOOL_MAX_TTL_MS) throw", "if (lasts === undefined) throw", "let a tool server keep a key longer than a day", [SHARED]),
  m("V49", GUARD, 'if (Buffer.byteLength(value as string, "utf8") > TOOL_MAX_VALUE_BYTES) throw', "if (false) throw", "let a tool server fill the shared space with one value", [SHARED]),
  m("V50", GUARD, "if (value !== TOOLS_MARKER_VALUE || options.length !== 0) throw", "if (false) throw", "write anything under the mark's key", [SHARED]),
  m("V51", GUARD, 'if (typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value))) throw', "if (false) throw", "send an argument that is not what it was checked as", [SHARED]),
  m("V52", GUARD, "return this.#inner.command(words);", "return this.#inner.command(args);", "send a command the caller can still change after it was checked", [SHARED]),
  m("V53", GUARD, "return this.#inner.eval(script, given, Array.from(args, word));", "return this.#inner.eval(script, keys, Array.from(args, word));", "send script keys the caller can still change after they were checked", [SHARED]),
  m("V54", GUARD, 'return (takes === "all" ? given : given.slice(0, 1)).every((a) => /^KEYS\\[[1-9]\\d*\\]$/.test(a));', "return true;", "accept a script that takes a key from its arguments", [SHARED]),
  m("V55", GUARD, "if (mentions === 0 || calls.length !== mentions) return false;", "if (mentions === 0) return false;", "accept a script that reaches the database under another name", [SHARED]),
  m("V56", GUARD, "if (!prefix.startsWith(TOOLS_KEY_PREFIX) || prefix.length <= TOOLS_KEY_PREFIX.length || !prefix.endsWith(\":\")) {", "if (false) {", "guard a tool server to the facilitator's prefix", [SHARED]),

  // The tool server's and the facilitator's side of sharing
  m("V57", TOOLS_FILE, "const client = new ToolServerRedis(options.client ?? new UpstashRest(redis), prefix);", "const client = options.client ?? new UpstashRest(redis);", "give the tool server the database unguarded", [SHARED]),
  m("V58", TOOLS_FILE, 'await client.command(["SET", TOOLS_MARKER_KEY, TOOLS_MARKER_VALUE]);', "", "use a database without marking it as a tool server's", [SHARED]),
  m("V59", TOOLS_FILE, "if (marked !== undefined && now() - marked < MARK_EVERY_MS) return;", "if (marked !== undefined) return;", "never mark an emptied database again", [SHARED]),
  m("V60", `${F}/vercel.ts`, "if (shared) {", "if (shared && false) {", "start on a shared database without being told to", [SHARED]),
  m("V61", `${F}/vercel.ts`, 'throw new EnvError("refusing to start: whether the database is also used by a tool server could not be read");', "shared = false;", "take a database it cannot read as not shared", [SHARED]),
  m("V62", REDIS, "else if (await this.sharedWithTools()) return", "else if (false) return", "go on using a database that a tool server started to use", [SHARED]),
  m("V63", REDIS, "this.acceptShared = options.acceptShared === true;", "this.acceptShared = options.acceptShared !== false;", "accept sharing when told nothing", [SHARED]),
  m("V64", `${F}/env.ts`, "if (sharing && sharing !== SHARED_DATABASE_ACCEPTED) {", "if (false) {", "take a mistyped acceptance in silence", [SHARED]),
  m("V65", TOOLS_FILE, "return own.ok ? everywhere.hit(client) : own;", "return everywhere.hit(client);", "ask the shared database about a caller already past the limit", [SHARED]),
  m("V66", "packages/sdk/src/redis.ts", 'export const FACILITATOR_KEY_PREFIX = "sluice:facilitator:";', 'export const FACILITATOR_KEY_PREFIX = "sluice:tools:facilitator:";', "put the facilitator's keys inside the tool servers' prefix", [SHARED]),
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

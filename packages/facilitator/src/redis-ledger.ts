// The ledger in Redis, shared by every copy of the facilitator that runs at once. What must happen all together is a Lua script: Redis
// runs one script at a time, so between its reads and its writes nothing else happens.
//
// Amounts of QIE are kept in gwei here, because a script's numbers are exact only up to 2^53 and a day's budget in wei is far above that.
// What is set aside or spent is rounded up and a budget is rounded down, so the rounding can only make the facilitator spend less.
// QUSDC amounts and top-up amounts in wei stay far below 2^53.
//
// When the database cannot be asked, every method throws StoreError, and the service accepts and sends nothing.
import { FACILITATOR_KEY_PREFIX, RELEASE_SCRIPT, TOOLS_MARKER_KEY, redisHit } from "@sluice/sdk";
import type { RedisClient } from "@sluice/sdk";
import { LedgerRuleError, RELAYER_LOCK, StaleLockError } from "./ledger";
import type { Budget, InsertResult, Ledger, Limit, Lock, Refusal, StoredAlert } from "./ledger";
import { StoreError } from "./store";
import type { IntentRecord, Status } from "./store";

const GWEI = 1_000_000_000n;
const up = (wei: bigint): bigint => (wei + GWEI - 1n) / GWEI;
const down = (wei: bigint): bigint => wei / GWEI;

/** Keys that hold one day's counters are kept this long after their last write. */
const DAY_KEYS_SECONDS = 3 * 86_400;
const STATUSES: readonly Status[] = ["held", "queued", "submitted", "settled", "skipped", "expired", "failed"];

// ------------------------------------------------------------------------------------------------------------------------- scripts

const OPEN_SCRIPT = `
local out = { redis.call('GET', KEYS[2]) or '0' }
for _, id in ipairs(redis.call('SMEMBERS', KEYS[1])) do
  local record = redis.call('GET', ARGV[1] .. id)
  if record then out[#out + 1] = record end
end
return out
`;

const LIST_SCRIPT = `
local out = {}
for _, id in ipairs(redis.call('ZRANGE', KEYS[1], 0, tonumber(ARGV[2]) - 1)) do
  local record = redis.call('GET', ARGV[1] .. id)
  if record then out[#out + 1] = record end
end
return out
`;

// KEYS: intent, status, nonce, the payer's open set, the payer's version, the set of its state (queued or held), the counts.
// ARGV: id, record, expected version, created at, ttl of counters, number of limits, then key, amount, max count, max amount of each
// (-1: none), and last the state.
const INSERT_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if existing then return { 'exists', existing } end
if redis.call('EXISTS', KEYS[3]) == 1 then return { 'nonce' } end
if (redis.call('GET', KEYS[5]) or '0') ~= ARGV[3] then return { 'conflict' } end
local n = tonumber(ARGV[6])
for i = 0, n - 1 do
  local at = 7 + i * 4
  local count = tonumber(redis.call('HGET', ARGV[at], 'c') or '0')
  local amount = tonumber(redis.call('HGET', ARGV[at], 'a') or '0')
  local maxCount = tonumber(ARGV[at + 2])
  local maxAmount = tonumber(ARGV[at + 3])
  if (maxCount >= 0 and count + 1 > maxCount) or (maxAmount >= 0 and amount + tonumber(ARGV[at + 1]) > maxAmount) then
    return { 'limit', tostring(i) }
  end
end
local state = ARGV[7 + n * 4]
redis.call('SET', KEYS[1], ARGV[2])
redis.call('SET', KEYS[2], state)
redis.call('SET', KEYS[3], ARGV[1])
redis.call('SADD', KEYS[4], ARGV[1])
redis.call('INCR', KEYS[5])
redis.call('ZADD', KEYS[6], ARGV[4], ARGV[1])
redis.call('HINCRBY', KEYS[7], state, 1)
for i = 0, n - 1 do
  local at = 7 + i * 4
  redis.call('HINCRBY', ARGV[at], 'c', 1)
  redis.call('HINCRBY', ARGV[at], 'a', ARGV[at + 1])
  redis.call('EXPIRE', ARGV[at], ARGV[5])
end
return { 'ok' }
`;

// KEYS: the lock, the queued set, the submitted set, the counts, the latest settled, each payer's highest settled block, the held set.
// ARGV: fence token, prefixes of intent, status, open set and version keys, number of records, then id, record, status, payer, created at,
// updated at, block (-1: none). Nothing is written unless the token is the lock's and every change is allowed.
const UPDATE_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return { 'stale' } end
local n = tonumber(ARGV[6])
local final = { settled = true, skipped = true, expired = true, failed = true }
for i = 0, n - 1 do
  local at = 7 + i * 7
  local old = redis.call('GET', ARGV[3] .. ARGV[at])
  if not old then return { 'missing' } end
  if final[old] and old ~= ARGV[at + 2] then return { 'final', old, ARGV[at + 2] } end
end
for i = 0, n - 1 do
  local at = 7 + i * 7
  local id = ARGV[at]
  local status = ARGV[at + 2]
  local payer = ARGV[at + 3]
  local old = redis.call('GET', ARGV[3] .. id)
  redis.call('SET', ARGV[2] .. id, ARGV[at + 1])
  redis.call('SET', ARGV[3] .. id, status)
  if old ~= status then
    if old == 'queued' then redis.call('ZREM', KEYS[2], id) end
    if old == 'submitted' then redis.call('ZREM', KEYS[3], id) end
    if old == 'held' then redis.call('ZREM', KEYS[7], id) end
    redis.call('HINCRBY', KEYS[4], old, -1)
    redis.call('HINCRBY', KEYS[4], status, 1)
  end
  if status == 'queued' then redis.call('ZADD', KEYS[2], ARGV[at + 4], id) end
  if status == 'submitted' then redis.call('ZADD', KEYS[3], ARGV[at + 4], id) end
  if status == 'held' then redis.call('ZADD', KEYS[7], ARGV[at + 4], id) end
  if status == 'queued' or status == 'submitted' or status == 'held' then
    redis.call('SADD', ARGV[4] .. payer, id)
  else
    redis.call('SREM', ARGV[4] .. payer, id)
  end
  redis.call('INCR', ARGV[5] .. payer)
  if status == 'settled' then
    local latest = tonumber(redis.call('HGET', KEYS[5], 'at') or '-1')
    if tonumber(ARGV[at + 5]) >= latest then redis.call('HSET', KEYS[5], 'id', id, 'at', ARGV[at + 5]) end
    if tonumber(ARGV[at + 6]) > tonumber(redis.call('HGET', KEYS[6], payer) or '-1') then redis.call('HSET', KEYS[6], payer, ARGV[at + 6]) end
  end
end
return { 'ok' }
`;

// KEYS: intent, status, the held set, the queued set, the counts, the payer's version. ARGV: id, record, created at.
const RELEASE_HOLD_SCRIPT = `
if redis.call('GET', KEYS[2]) ~= 'held' then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('SET', KEYS[2], 'queued')
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('ZADD', KEYS[4], ARGV[3], ARGV[1])
redis.call('HINCRBY', KEYS[5], 'held', -1)
redis.call('HINCRBY', KEYS[5], 'queued', 1)
redis.call('INCR', KEYS[6])
return 1
`;

// KEYS: one counter each. ARGV: ttl, then amount, max count, max amount of each. -1 when all were raised, otherwise the place of the one that stopped it.
const TAKE_SCRIPT = `
for i = 1, #KEYS do
  local at = 2 + (i - 1) * 3
  local count = tonumber(redis.call('HGET', KEYS[i], 'c') or '0')
  local amount = tonumber(redis.call('HGET', KEYS[i], 'a') or '0')
  local maxCount = tonumber(ARGV[at + 1])
  local maxAmount = tonumber(ARGV[at + 2])
  if (maxCount >= 0 and count + 1 > maxCount) or (maxAmount >= 0 and amount + tonumber(ARGV[at]) > maxAmount) then return i - 1 end
end
for i = 1, #KEYS do
  local at = 2 + (i - 1) * 3
  redis.call('HINCRBY', KEYS[i], 'c', 1)
  redis.call('HINCRBY', KEYS[i], 'a', ARGV[at])
  redis.call('EXPIRE', KEYS[i], ARGV[1])
end
return -1
`;

// KEYS: spent, reserved (gwei). ARGV: amount, budget, ttl.
const RESERVE_SCRIPT = `
local spent = tonumber(redis.call('GET', KEYS[1]) or '0')
local reserved = tonumber(redis.call('GET', KEYS[2]) or '0')
if spent + reserved + tonumber(ARGV[1]) > tonumber(ARGV[2]) then return { 0, spent, reserved } end
redis.call('INCRBY', KEYS[2], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('EXPIRE', KEYS[2], ARGV[3])
return { 1, spent, reserved + tonumber(ARGV[1]) }
`;

// KEYS: spent, reserved. ARGV: reservation to give back, amount spent, ttl.
const SPEND_SCRIPT = `
if redis.call('DECRBY', KEYS[2], ARGV[1]) < 0 then redis.call('SET', KEYS[2], '0') end
redis.call('INCRBY', KEYS[1], ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('EXPIRE', KEYS[2], ARGV[3])
return 1
`;

// KEYS: the lock, the fence counter. ARGV: ttl in milliseconds. The new token, or nothing while the lock is held.
const LOCK_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return false end
local token = tostring(redis.call('INCR', KEYS[2]))
redis.call('SET', KEYS[1], token, 'PX', ARGV[1])
return token
`;

// KEYS: the lock. ARGV: token, the least time left in milliseconds.
const HELD_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] and redis.call('PTTL', KEYS[1]) > tonumber(ARGV[2]) then return 1 end
return 0
`;

// KEYS: the day's set of kinds raised, the list of alerts. ARGV: kind, alert, how many to keep, ttl.
const ALERT_SCRIPT = `
if redis.call('SADD', KEYS[1], ARGV[1]) == 0 then return 0 end
redis.call('EXPIRE', KEYS[1], ARGV[4])
redis.call('LPUSH', KEYS[2], ARGV[2])
redis.call('LTRIM', KEYS[2], 0, tonumber(ARGV[3]) - 1)
return 1
`;

// KEYS: the list. ARGV: entry, how many to keep.
const KEEP_SCRIPT = `
redis.call('LPUSH', KEYS[1], ARGV[1])
redis.call('LTRIM', KEYS[1], 0, tonumber(ARGV[2]) - 1)
return 1
`;

// -------------------------------------------------------------------------------------------------------------------------- the ledger

/** Where a facilitator's keys live in the database: one set for each network and router, so a new router starts empty. */
export const redisPrefix = (network: string, router: string): string => `${FACILITATOR_KEY_PREFIX}${network}:${router.toLowerCase()}:`;

/** Why a facilitator that did not accept sharing its database will not use one a tool server uses. */
export const SHARED_DATABASE_PROBLEM = "the database is also used by a tool server, and sharing it has not been accepted (SLUICE_FACILITATOR_SHARED_DATABASE)";

export class RedisLedger implements Ledger {
  readonly kind = "redis";
  private readonly acceptShared: boolean;

  constructor(
    private readonly client: RedisClient,
    private readonly prefix: string,
    /** `acceptShared`: a database that a tool server also uses is used all the same. Off unless said. */
    options: { acceptShared?: boolean } = {},
  ) {
    this.acceptShared = options.acceptShared === true;
  }

  /** True when a tool server has marked this database as its own too. */
  async sharedWithTools(): Promise<boolean> {
    return Number(await this.command("EXISTS", TOOLS_MARKER_KEY)) !== 0;
  }

  /** The key of the stored kill switch: any value but "0" stops everything, and deleting it lets the service go again. */
  get killSwitchKey(): string {
    return this.key("kill");
  }

  private key(...parts: string[]): string {
    return `${this.prefix}${parts.join(":")}`;
  }

  private async asked<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (err instanceof StaleLockError || err instanceof LedgerRuleError) throw err;
      throw new StoreError("the queue store could not be reached", "unreachable");
    }
  }
  private command(...args: Array<string | number>): Promise<unknown> {
    return this.asked(() => this.client.command(args));
  }
  private script(script: string, keys: string[], args: Array<string | number>): Promise<unknown> {
    return this.asked(() => this.client.eval(script, keys, args));
  }
  private record(text: unknown): IntentRecord | undefined {
    if (typeof text !== "string") return undefined;
    try {
      return JSON.parse(text) as IntentRecord;
    } catch {
      throw new StoreError("the queue store is damaged: a record does not read", "corrupt");
    }
  }

  async health() {
    try {
      // Asked before anything is accepted or sent, so a database that a tool server starts to use later stops this copy too. One
      // request either way: the one that shows the database answers is the one that looks for the tool server's mark.
      if (this.acceptShared) await this.command("EXISTS", this.killSwitchKey);
      else if (await this.sharedWithTools()) return { ok: false, problem: SHARED_DATABASE_PROBLEM };
      return { ok: true };
    } catch {
      return { ok: false, problem: "the queue store could not be reached" };
    }
  }
  async killSwitchOn(): Promise<boolean> {
    const value = await this.command("GET", this.killSwitchKey);
    return value !== null && value !== undefined && String(value) !== "0";
  }

  async get(id: string) {
    return this.record(await this.command("GET", this.key("intent", id)));
  }
  async byNonce(payer: string, nonce: string) {
    const id = await this.command("GET", this.key("nonce", payer.toLowerCase(), nonce.toLowerCase()));
    return typeof id === "string" ? this.get(id) : undefined;
  }
  async openOf(payer: string) {
    const p = payer.toLowerCase();
    const [version, ...records] = (await this.script(OPEN_SCRIPT, [this.key("open", p), this.key("version", p)], [this.key("intent", "")])) as string[];
    return { version: String(version), records: records.map((r) => this.record(r) as IntentRecord) };
  }

  async insertIntent(record: IntentRecord, version: string, limits: readonly Limit[]): Promise<InsertResult> {
    const payer = record.payer.toLowerCase();
    if (record.status !== "queued" && record.status !== "held") throw new LedgerRuleError("a new intent is queued or held");
    const answer = (await this.script(
      INSERT_SCRIPT,
      [this.key("intent", record.id), this.key("status", record.id), this.key("nonce", payer, record.nonce.toLowerCase()), this.key("open", payer), this.key("version", payer), this.key(record.status), this.key("counts")],
      [record.id, JSON.stringify(record), version, record.createdAt, DAY_KEYS_SECONDS, limits.length, ...limits.flatMap((l) => [this.key("usage", l.key), l.amount.toString(), l.maxCount ?? -1, l.maxAmount === undefined ? -1 : l.maxAmount.toString()]), record.status],
    )) as string[];
    switch (answer[0]) {
      case "ok":
        return { kind: "inserted" };
      case "exists":
        return { kind: "exists", record: this.record(answer[1]) as IntentRecord };
      case "nonce":
        return { kind: "nonce" };
      case "conflict":
        return { kind: "conflict" };
      case "limit":
        return { kind: "limit", index: Number(answer[1]) };
      default:
        throw new StoreError("the queue store gave an unexpected answer", "unreachable");
    }
  }

  async update(records: IntentRecord[], fence: Lock): Promise<void> {
    if (records.length === 0) return;
    const answer = (await this.script(
      UPDATE_SCRIPT,
      [this.key("lock", RELAYER_LOCK), this.key("queued"), this.key("submitted"), this.key("counts"), this.key("latest"), this.key("settled-block"), this.key("held")],
      [fence.token, this.key("intent", ""), this.key("status", ""), this.key("open", ""), this.key("version", ""), records.length, ...records.flatMap((r) => [r.id, JSON.stringify(r), r.status, r.payer.toLowerCase(), r.createdAt, r.updatedAt, r.blockNumber ?? -1])],
    )) as string[];
    if (answer[0] === "ok") return;
    if (answer[0] === "stale") throw new StaleLockError();
    if (answer[0] === "missing") throw new LedgerRuleError("an intent that was never queued cannot be changed");
    if (answer[0] === "final") throw new LedgerRuleError(`an intent that is ${answer[1]} cannot become ${answer[2]}`);
    throw new StoreError("the queue store gave an unexpected answer", "unreachable");
  }

  private async list(set: string, limit: number): Promise<IntentRecord[]> {
    if (limit <= 0) return [];
    const found = (await this.script(LIST_SCRIPT, [this.key(set)], [this.key("intent", ""), limit])) as string[];
    return found.map((r) => this.record(r) as IntentRecord);
  }
  async releaseHold(record: IntentRecord): Promise<boolean> {
    if (record.status !== "queued") throw new LedgerRuleError("a held intent is released to the queue and nowhere else");
    const keys = [this.key("intent", record.id), this.key("status", record.id), this.key("held"), this.key("queued"), this.key("counts"), this.key("version", record.payer.toLowerCase())];
    return Number(await this.script(RELEASE_HOLD_SCRIPT, keys, [record.id, JSON.stringify(record), record.createdAt])) === 1;
  }
  held(limit: number) {
    return this.list("held", limit);
  }
  queued(limit: number) {
    return this.list("queued", limit);
  }
  async queuedCount() {
    return Number(await this.command("ZCARD", this.key("queued")));
  }
  submitted() {
    return this.list("submitted", 1_000);
  }
  async latestSettled() {
    const id = await this.command("HGET", this.key("latest"), "id");
    return typeof id === "string" ? this.get(id) : undefined;
  }
  async settledBlock(payer: string) {
    return Number((await this.command("HGET", this.key("settled-block"), payer.toLowerCase())) ?? 0);
  }
  async countByStatus() {
    const counts =Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
    const values = (await this.command("HMGET", this.key("counts"), ...STATUSES)) as Array<string | null>;
    STATUSES.forEach((s, i) => (counts[s] = Number(values[i] ?? 0)));
    return counts;
  }

  async usage(key: string) {
    const [c, a] = (await this.command("HMGET", this.key("usage", key), "c", "a")) as Array<string | null>;
    return { count: Number(c ?? 0), amount: BigInt(a ?? 0) };
  }
  async take(limits: readonly Limit[]) {
    const index = Number(
      await this.script(TAKE_SCRIPT, limits.map((l) => this.key("usage", l.key)), [DAY_KEYS_SECONDS, ...limits.flatMap((l) => [l.amount.toString(), l.maxCount ?? -1, l.maxAmount === undefined ? -1 : l.maxAmount.toString()])]),
    );
    return index === -1 ? undefined : index;
  }

  private budgetKeys(day: string): [string, string] {
    return [this.key("budget", day, "spent"), this.key("budget", day, "reserved")];
  }
  async reserveBudget(day: string, wei: bigint, budgetWei: bigint) {
    const [ok, spent, reserved] = (await this.script(RESERVE_SCRIPT, this.budgetKeys(day), [up(wei).toString(), down(budgetWei).toString(), DAY_KEYS_SECONDS])) as number[];
    return { ok: Number(ok) === 1, spentWei: BigInt(spent as number) * GWEI, reservedWei: BigInt(reserved as number) * GWEI };
  }
  async releaseBudget(day: string, wei: bigint) {
    await this.script(SPEND_SCRIPT, this.budgetKeys(day), [up(wei).toString(), 0, DAY_KEYS_SECONDS]);
  }
  async spendBudget(day: string, reservedWei: bigint, spentWei: bigint) {
    await this.script(SPEND_SCRIPT, this.budgetKeys(day), [up(reservedWei).toString(), up(spentWei).toString(), DAY_KEYS_SECONDS]);
  }
  async budget(day: string): Promise<Budget> {
    const [spent, reserved] = (await this.command("MGET", ...this.budgetKeys(day))) as Array<string | null>;
    return { spentWei: BigInt(spent ?? 0) * GWEI, reservedWei: BigInt(reserved ?? 0) * GWEI };
  }
  async reserveTopUp(day: string, address: string, wei: bigint, capWei: bigint) {
    return (await this.take([{ key: `relayer-topup:${day}:${address.toLowerCase()}`, amount: wei, maxAmount: capWei }])) === undefined;
  }
  async releaseTopUp(day: string, address: string, wei: bigint) {
    await this.command("HINCRBY", this.key("usage", `relayer-topup:${day}:${address.toLowerCase()}`), "a", (-wei).toString());
  }

  async lock(name: string, ttlMs: number): Promise<Lock | undefined> {
    const key = this.key("lock", name);
    const answer = await this.script(LOCK_SCRIPT, [key, this.key("fence")], [ttlMs]);
    if (answer === null || answer === undefined || answer === false) return undefined;
    const token = String(answer);
    return {
      token,
      held: async (minMs) => Number(await this.script(HELD_SCRIPT, [key], [token, minMs])) === 1,
      release: async () => {
        await this.script(RELEASE_SCRIPT, [key], [token]);
      },
    };
  }

  hit(key: string, max: number, windowMs: number) {
    return this.asked(() => redisHit(this.client, this.key("rate", key.toLowerCase()), max, windowMs));
  }

  async raiseAlert(day: string, alert: StoredAlert) {
    await this.script(ALERT_SCRIPT, [this.key("alerted", day), this.key("alerts")], [alert.kind, JSON.stringify(alert), 50, DAY_KEYS_SECONDS]);
  }
  async alerts() {
    const found = (await this.command("LRANGE", this.key("alerts"), 0, 49)) as string[];
    return found.map((a) => JSON.parse(a) as StoredAlert).reverse();
  }
  async recordRefusal(refusal: Refusal) {
    await this.script(KEEP_SCRIPT, [this.key("refusals")], [JSON.stringify(refusal), 500]);
  }
  close() {
    // nothing is held: a lock that this copy holds is let go by what took it, or expires
  }
}

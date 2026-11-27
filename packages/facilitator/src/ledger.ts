// The ledger: everything the facilitator has to remember and agree on, behind one interface, so that it can be a file on one machine or a
// database that many short-lived copies of the service share. It holds the queue and its journal, the counters of the daily caps, the
// relayer's budget for the day, the lock on the relayer, the stored kill switch and the callers' rate limits.
//
// Every operation that has to be all or nothing is one call here, so that an implementation can make it atomic:
//   - a new intent goes in only if it is new, its nonce is free, its payer's open intents are as they were when it was checked, and no
//     daily cap would be passed;
//   - intents change state only for the holder of the relayer lock (the fence), and a finished intent never changes state again;
//   - counters rise only if all of them stay within their limits;
//   - the day's budget is reserved before anything is signed.
//
// LocalLedger (here) wraps the file store or the memory store: one process, where JavaScript runs one step at a time, makes each call
// atomic. RedisLedger (redis-ledger.ts) does the same with Lua scripts. Both are held to one test suite.
import { RateLimiter } from "@sluice/sdk";
import type { LimitResult } from "@sluice/sdk";
import type { IntentRecord, Status, Store, Usage } from "./store";

/** A counter to raise by one (and its amount by `amount`), refused if it would pass either maximum. */
export type Limit = { key: string; amount: bigint; maxCount?: number; maxAmount?: bigint };

export type InsertResult =
  | { kind: "inserted" }
  | { kind: "exists"; record: IntentRecord }
  | { kind: "nonce" }
  /** The payer's open intents changed since they were read: read them again and decide again. */
  | { kind: "conflict" }
  /** The limit at this place in the list would be passed. Nothing was written. */
  | { kind: "limit"; index: number };

export type Budget = { spentWei: bigint; reservedWei: bigint };

export type Refusal = { at: number; what: string; reason: string; payer?: string };

export type StoredAlert = { at: number; kind: string; message: string };

/** A lock that expires. Its token is the fence: it grows with every taking, and a write names the token it holds. */
export interface Lock {
  readonly token: string;
  /** Still this holder's, with at least this long left. */
  held(minMs: number): Promise<boolean>;
  release(): Promise<void>;
}

/** A write by someone who no longer holds the lock. Nothing was written. */
export class StaleLockError extends Error {
  constructor() {
    super("the lock this write was made under is no longer held");
    this.name = "StaleLockError";
  }
}

/** A change no intent may make: one that is not there, or a finished one leaving its final state. Nothing was written. */
export class LedgerRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerRuleError";
  }
}

export const FINAL_STATUSES: ReadonlySet<Status> = new Set<Status>(["settled", "skipped", "expired", "failed"]);

/** The one lock that guards the relayer: whoever holds it is the only sender of the relayer's transactions. */
export const RELAYER_LOCK = "relayer";

/** Every method throws StoreError when the ledger cannot be read or written, and the service then accepts and sends nothing. */
export interface Ledger {
  readonly kind: "local" | "redis";
  health(): Promise<{ ok: boolean; problem?: string }>;
  /** The kill switch stored in the ledger. The environment's switch is separate, and either one stops everything. */
  killSwitchOn(): Promise<boolean>;

  get(id: string): Promise<IntentRecord | undefined>;
  byNonce(payer: string, nonce: string): Promise<IntentRecord | undefined>;
  /** A payer's held, queued and submitted intents, read together with a version that changes whenever any of them does. */
  openOf(payer: string): Promise<{ records: IntentRecord[]; version: string }>;
  /** Writes a new intent, `queued` or `held`. */
  insertIntent(record: IntentRecord, version: string, limits: readonly Limit[]): Promise<InsertResult>;
  /** Changes existing intents, all or none, for the holder of the relayer lock. */
  update(records: IntentRecord[], fence: Lock): Promise<void>;
  /** Moves one intent from held to the queue, if it is still held. Needs no lock: nothing sends a held intent. False if it was not held. */
  releaseHold(record: IntentRecord): Promise<boolean>;
  held(limit: number): Promise<IntentRecord[]>;
  queued(limit: number): Promise<IntentRecord[]>;
  queuedCount(): Promise<number>;
  submitted(): Promise<IntentRecord[]>;
  latestSettled(): Promise<IntentRecord | undefined>;
  /** The highest block in which an intent of this payer's is recorded as settled, or 0. Read after the payer's open intents. */
  settledBlock(payer: string): Promise<number>;
  countByStatus(): Promise<Record<Status, number>>;

  usage(key: string): Promise<Usage>;
  /** Raises every counter, or none. Undefined when raised; otherwise the place of the limit that would be passed. */
  take(limits: readonly Limit[]): Promise<number | undefined>;

  /** Sets aside part of a day's QIE budget, if what is spent and set aside stays within it. */
  reserveBudget(day: string, wei: bigint, budgetWei: bigint): Promise<{ ok: boolean } & Budget>;
  /** Gives back a reservation: nothing was sent. */
  releaseBudget(day: string, wei: bigint): Promise<void>;
  /** Replaces a reservation with what was really spent. */
  spendBudget(day: string, reservedWei: bigint, spentWei: bigint): Promise<void>;
  budget(day: string): Promise<Budget>;
  /** Counts a QIE top-up to one address against its day, before it is sent. False past the cap. */
  reserveTopUp(day: string, address: string, wei: bigint, capWei: bigint): Promise<boolean>;
  releaseTopUp(day: string, address: string, wei: bigint): Promise<void>;

  /** Undefined while someone else holds it. */
  lock(name: string, ttlMs: number): Promise<Lock | undefined>;
  hit(key: string, max: number, windowMs: number): Promise<LimitResult>;
  raiseAlert(day: string, alert: StoredAlert): Promise<void>;
  alerts(): Promise<StoredAlert[]>;
  recordRefusal(refusal: Refusal): Promise<void>;
  close(): void;
}

const ALERTS_KEPT = 50;
const REFUSALS_KEPT = 500;

export type LocalLedgerOptions = {
  /** Milliseconds, for the lock's expiry and the rate limits. */
  now?: () => number;
};

/** The ledger of one process, over the memory store or the file store. */
export class LocalLedger implements Ledger {
  readonly kind = "local";
  private readonly now: () => number;
  private readonly locks = new Map<string, { token: string; expires: number }>();
  private fence = 0;
  private readonly limiters = new Map<string, RateLimiter>();
  private stopped = false;
  private readonly raised: StoredAlert[] = [];
  private readonly raisedKeys = new Set<string>();
  private readonly refused: Refusal[] = [];

  constructor(
    readonly store: Store,
    options: LocalLedgerOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Turns the stored kill switch on or off. A program on this machine also has the kill file (KillSwitch). */
  setKillSwitch(on: boolean): void {
    this.stopped = on;
  }

  async health() {
    return this.store.healthy() ? { ok: true } : { ok: false, problem: this.store.problem() };
  }
  async killSwitchOn() {
    return this.stopped;
  }
  async get(id: string) {
    return this.store.get(id);
  }
  async byNonce(payer: string, nonce: string) {
    return this.store.byNonce(payer, nonce);
  }

  private versionOf(records: IntentRecord[]): string {
    return records.map((r) => `${r.id}:${r.status}`).sort().join(",");
  }
  async openOf(payer: string) {
    const records = this.store.openOf(payer);
    return { records, version: this.versionOf(records) };
  }

  /** The place of the first limit that raising all of them would pass. */
  private passed(limits: readonly Limit[]): number | undefined {
    const at = limits.findIndex((l) => {
      const u = this.store.usage(l.key);
      return (l.maxCount !== undefined && u.count + 1 > l.maxCount) || (l.maxAmount !== undefined && u.amount + l.amount > l.maxAmount);
    });
    return at === -1 ? undefined : at;
  }

  // Each method below does all its reading and writing with no await between, so nothing else in this process can run inside it.
  async insertIntent(record: IntentRecord, version: string, limits: readonly Limit[]): Promise<InsertResult> {
    const existing = this.store.get(record.id);
    if (existing) return { kind: "exists", record: existing };
    if (this.store.byNonce(record.payer, record.nonce)) return { kind: "nonce" };
    if (this.versionOf(this.store.openOf(record.payer)) !== version) return { kind: "conflict" };
    const index = this.passed(limits);
    if (index !== undefined) return { kind: "limit", index };
    this.store.putMany([record], limits.map((l) => [l.key, l.amount] as const));
    return { kind: "inserted" };
  }

  private holds(name: string, token: string, minMs = 0): boolean {
    const lock = this.locks.get(name);
    return lock !== undefined && lock.token === token && lock.expires - this.now() > minMs;
  }

  async update(records: IntentRecord[], fence: Lock): Promise<void> {
    if (!this.holds(RELAYER_LOCK, fence.token)) throw new StaleLockError();
    for (const r of records) {
      const old = this.store.get(r.id);
      if (!old) throw new LedgerRuleError("an intent that was never queued cannot be changed");
      if (FINAL_STATUSES.has(old.status) && old.status !== r.status) throw new LedgerRuleError(`an intent that is ${old.status} cannot become ${r.status}`);
    }
    this.store.putMany(records);
  }

  async releaseHold(record: IntentRecord): Promise<boolean> {
    if (record.status !== "queued") throw new LedgerRuleError("a held intent is released to the queue and nowhere else");
    if (this.store.get(record.id)?.status !== "held") return false;
    this.store.putMany([record]);
    return true;
  }
  async held(limit: number) {
    return this.store.held(limit);
  }
  async queued(limit: number) {
    return this.store.queued(limit);
  }
  async queuedCount() {
    return this.store.countByStatus().queued;
  }
  async submitted() {
    return this.store.submitted();
  }
  async latestSettled() {
    return this.store.latestSettled();
  }
  async settledBlock(payer: string) {
    return this.store.settledBlock(payer);
  }
  async countByStatus() {
    return this.store.countByStatus();
  }
  async usage(key: string) {
    return this.store.usage(key);
  }
  async take(limits: readonly Limit[]) {
    const index = this.passed(limits);
    if (index === undefined) this.store.putMany([], limits.map((l) => [l.key, l.amount] as const));
    return index;
  }

  // The store's counters only rise, so what is given back is counted in a second counter and subtracted.
  private net(key: string): bigint {
    return this.store.usage(key).amount - this.store.usage(`${key}:back`).amount;
  }
  private spentToday(day: string): bigint {
    return this.store.usage(`budget-spent:${day}`).amount;
  }
  async budget(day: string): Promise<Budget> {
    return { spentWei: this.spentToday(day), reservedWei: this.net(`budget-reserved:${day}`) };
  }
  async reserveBudget(day: string, wei: bigint, budgetWei: bigint) {
    const spentWei = this.spentToday(day);
    const reservedWei = this.net(`budget-reserved:${day}`);
    if (spentWei + reservedWei + wei > budgetWei) return { ok: false, spentWei, reservedWei };
    this.store.putMany([], [[`budget-reserved:${day}`, wei]]);
    return { ok: true, spentWei, reservedWei: reservedWei + wei };
  }
  async releaseBudget(day: string, wei: bigint) {
    this.store.putMany([], [[`budget-reserved:${day}:back`, wei]]);
  }
  async spendBudget(day: string, reservedWei: bigint, spentWei: bigint) {
    this.store.putMany([], [[`budget-reserved:${day}:back`, reservedWei], [`budget-spent:${day}`, spentWei]]);
  }
  async reserveTopUp(day: string, address: string, wei: bigint, capWei: bigint) {
    const key = `relayer-topup:${day}:${address.toLowerCase()}`;
    if (this.net(key) + wei > capWei) return false;
    this.store.putMany([], [[key, wei]]);
    return true;
  }
  async releaseTopUp(day: string, address: string, wei: bigint) {
    this.store.putMany([], [[`relayer-topup:${day}:${address.toLowerCase()}:back`, wei]]);
  }

  async lock(name: string, ttlMs: number): Promise<Lock | undefined> {
    const current = this.locks.get(name);
    if (current && current.expires > this.now()) return undefined;
    this.fence += 1;
    const token = String(this.fence);
    this.locks.set(name, { token, expires: this.now() + ttlMs });
    return {
      token,
      held: async (minMs) => this.holds(name, token, minMs),
      release: async () => {
        if (this.locks.get(name)?.token === token) this.locks.delete(name);
      },
    };
  }

  async hit(key: string, max: number, windowMs: number) {
    const id = `${max}:${windowMs}`;
    let limiter = this.limiters.get(id);
    if (!limiter) {
      limiter = new RateLimiter(max, windowMs, 10_000, this.now);
      this.limiters.set(id, limiter);
    }
    return limiter.hit(key);
  }

  async raiseAlert(day: string, alert: StoredAlert) {
    const key = `${day}:${alert.kind}`;
    if (this.raisedKeys.has(key)) return;
    this.raisedKeys.add(key);
    this.raised.push(alert);
    if (this.raised.length > ALERTS_KEPT) this.raised.shift();
  }
  async alerts() {
    return [...this.raised];
  }
  async recordRefusal(refusal: Refusal) {
    this.refused.push(refusal);
    if (this.refused.length > REFUSALS_KEPT) this.refused.shift();
  }
  /** The refusals kept in this process, newest last. */
  refusals(): Refusal[] {
    return [...this.refused];
  }
  close() {
    this.store.close();
  }
}

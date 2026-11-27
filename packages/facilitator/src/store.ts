// The facilitator's record of every intent it accepted. The chain is the final guard against a double settlement (the
// router burns a nonce once), but this record is what keeps the facilitator itself from queueing the same intent twice,
// from counting a payer's pending spend wrong, and from losing what it was in the middle of when it stopped.
//
// Two stores:
//   MemoryStore  everything in memory. A restart loses the queue. For tests and for a facilitator on a local node.
//   FileStore    the same, written through to an append-only journal that is flushed to disk before a write returns.
//
// FileStore fails closed. A journal that cannot be read refuses to open. A write that fails (the disk is full, the file
// is unwritable) makes the store unhealthy for good: every later write throws, the service accepts no new intent, and it
// sends no batch, because it could not record what happened. Only a restart, on a store that reads, gets it going again.
import { closeSync, existsSync, fsyncSync, ftruncateSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";

/** "held" is written down and counted against the payer, and is not sent until whoever holds it releases it to the queue. */
export type Status = "held" | "queued" | "submitted" | "settled" | "skipped" | "expired" | "failed";

export type IntentRecord = {
  id: string;
  payer: string;
  payee: string;
  signer: string;
  amount: string;
  toolId: string;
  nonce: string;
  deadline: string;
  signature: string;
  status: Status;
  createdAt: number;
  updatedAt: number;
  transaction?: string;
  blockNumber?: number;
  reason?: string;
  fee?: string;
  /** Set when the intent went into a batch: which batch, so a restart can find the others in it. */
  batch?: string;
  /** The chain's block number when the batch was about to be sent: a restart looks for its events from here. */
  fromBlock?: number;
  /** How many times the intent could not be submitted. Kept with it, so that a count survives the process. */
  tries?: number;
  /** For a held intent: the SHA-256 of the token that releases it. The token itself is given once and never stored. */
  hold?: string;
};

/** The states whose amounts count against a payer: not finished, whatever the queue is doing with them. */
const OPEN: ReadonlySet<Status> = new Set<Status>(["held", "queued", "submitted"]);

/** A counter to raise, by key, in the same write as the records. */
export type UsageStep = readonly [key: string, amount: bigint];

export type Usage = { count: number; amount: bigint };

export class StoreError extends Error {
  constructor(
    message: string,
    readonly code: "unreadable" | "corrupt" | "write_failed" | "locked" | "closed" | "unreachable",
  ) {
    super(message);
    this.name = "StoreError";
  }
}

export interface Store {
  get(id: string): IntentRecord | undefined;
  byNonce(payer: string, nonce: string): IntentRecord | undefined;
  put(record: IntentRecord): void;
  /** Writes several records, and raises the counters named, so that they are in the journal together (one write, one flush). */
  putMany(records: IntentRecord[], usage?: readonly UsageStep[]): void;
  queued(limit: number): IntentRecord[];
  /** Held intents, oldest first: recorded and counted, and not yet released to the queue. */
  held(limit: number): IntentRecord[];
  /** Records that went into a batch whose outcome the facilitator has not yet recorded. */
  submitted(): IntentRecord[];
  /** This payer's intents that are held, queued or submitted: the ones whose amounts may not yet be reflected on the chain. */
  openOf(payer: string): IntentRecord[];
  /** Amount of this payer's intents that are held, queued or submitted and not yet final. */
  pendingFor(payer: string): bigint;
  /** The same, for one (payer, agent) pair, which is what an agent's session budget is spent against. */
  pendingForAgent(payer: string, signer: string): bigint;
  /** The settled intent that was updated last, for /health: when the last batch landed and in which block. */
  latestSettled(): IntentRecord | undefined;
  /** The highest block in which an intent of this payer's is recorded as settled, or 0. */
  settledBlock(payer: string): number;
  /** How many intents are in each state, for the private metrics. */
  countByStatus(): Record<Status, number>;
  /** Counters by key, for the per-day caps. */
  usage(key: string): Usage;
  addUsage(key: string, amount: bigint): void;
  size(): number;
  /** False once the store cannot record what it is told. The service then accepts and sends nothing. */
  healthy(): boolean;
  /** Why it is unhealthy, in words that hold no path and no secret. */
  problem(): string | undefined;
  /** Releases the lock on the journal. Writes after this throw. */
  close(): void;
}

export class MemoryStore implements Store {
  protected readonly records = new Map<string, IntentRecord>();
  private readonly nonces = new Map<string, string>();
  protected readonly counters = new Map<string, Usage>();

  get(id: string) {
    return this.records.get(id);
  }
  byNonce(payer: string, nonce: string) {
    const id = this.nonces.get(`${payer.toLowerCase()}|${nonce.toLowerCase()}`);
    return id ? this.records.get(id) : undefined;
  }
  protected apply(record: IntentRecord) {
    this.records.set(record.id, record);
    this.nonces.set(`${record.payer.toLowerCase()}|${record.nonce.toLowerCase()}`, record.id);
  }
  put(record: IntentRecord) {
    this.apply(record);
  }
  putMany(records: IntentRecord[], usage: readonly UsageStep[] = []) {
    for (const r of records) this.apply(r);
    for (const [key, amount] of usage) this.bump(key, amount);
  }
  queued(limit: number) {
    return this.byStatus("queued").sort((a, b) => a.createdAt - b.createdAt).slice(0, limit);
  }
  submitted() {
    return this.byStatus("submitted").sort((a, b) => a.createdAt - b.createdAt);
  }
  private byStatus(status: Status): IntentRecord[] {
    const out: IntentRecord[] = [];
    for (const r of this.records.values()) if (r.status === status) out.push(r);
    return out;
  }
  held(limit: number) {
    return this.byStatus("held").sort((a, b) => a.createdAt - b.createdAt).slice(0, limit);
  }
  openOf(payer: string) {
    const out: IntentRecord[] = [];
    for (const r of this.records.values()) {
      if (r.payer.toLowerCase() === payer.toLowerCase() && OPEN.has(r.status)) out.push(r);
    }
    return out;
  }
  pendingFor(payer: string) {
    let total = 0n;
    for (const r of this.records.values()) {
      if (r.payer.toLowerCase() === payer.toLowerCase() && OPEN.has(r.status)) total += BigInt(r.amount);
    }
    return total;
  }
  pendingForAgent(payer: string, signer: string) {
    let total = 0n;
    for (const r of this.records.values()) {
      if (r.payer.toLowerCase() === payer.toLowerCase() && r.signer.toLowerCase() === signer.toLowerCase() && OPEN.has(r.status)) {
        total += BigInt(r.amount);
      }
    }
    return total;
  }
  latestSettled() {
    let latest: IntentRecord | undefined;
    for (const r of this.records.values()) {
      if (r.status === "settled" && (latest === undefined || r.updatedAt >= latest.updatedAt)) latest = r;
    }
    return latest;
  }
  settledBlock(payer: string) {
    let block = 0;
    for (const r of this.records.values()) {
      if (r.status === "settled" && r.payer.toLowerCase() === payer.toLowerCase() && (r.blockNumber ?? 0) > block) block = r.blockNumber as number;
    }
    return block;
  }
  countByStatus() {
    const counts: Record<Status, number> = { held: 0, queued: 0, submitted: 0, settled: 0, skipped: 0, expired: 0, failed: 0 };
    for (const r of this.records.values()) counts[r.status] += 1;
    return counts;
  }
  usage(key: string) {
    return this.counters.get(key) ?? { count: 0, amount: 0n };
  }
  protected bump(key: string, amount: bigint) {
    const u = this.usage(key);
    this.counters.set(key, { count: u.count + 1, amount: u.amount + amount });
  }
  addUsage(key: string, amount: bigint) {
    this.bump(key, amount);
  }
  size() {
    return this.records.size;
  }
  healthy() {
    return true;
  }
  problem(): string | undefined {
    return undefined;
  }
  close() {
    // nothing is held
  }
}

// ------------------------------------------------------------------------------------------------- the journal

/** The file operations the journal uses. A test swaps them to make the disk fail. */
export type JournalIo = {
  open(path: string, flags: string): number;
  write(fd: number, text: string): void;
  sync(fd: number): void;
  close(fd: number): void;
};

export const nodeIo: JournalIo = {
  open: (path, flags) => openSync(path, flags),
  write: (fd, text) => void writeSync(fd, text),
  sync: (fd) => fsyncSync(fd),
  close: (fd) => closeSync(fd),
};

type Line =
  | { t: "put"; r: IntentRecord }
  | { t: "usage"; k: string; c: number; a: string };

export type FileStoreOptions = { io?: JournalIo; pid?: number; isAlive?: (pid: number) => boolean };

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * An append-only journal, one JSON object per line, flushed to disk before each write returns. On open it replays the
 * journal. A last line that stops part-way (a crash mid-write) is dropped and cut off; a line that does not read anywhere
 * else means the file is damaged, and the store refuses to open instead of guessing. A lock file names the process that holds
 * the journal, so two facilitators cannot work from one queue; a lock left by a process that is gone is taken over.
 */
export class FileStore extends MemoryStore {
  private readonly io: JournalIo;
  private fd: number | undefined;
  private broken: string | undefined;
  private readonly lockPath: string;
  private lines = 0;

  constructor(
    private readonly path: string,
    options: FileStoreOptions = {},
  ) {
    super();
    this.io = options.io ?? nodeIo;
    this.lockPath = `${path}.lock`;
    this.takeLock(options.pid ?? process.pid, options.isAlive ?? alive);
    try {
      this.replay();
      if (this.lines > 2000 && this.lines > this.records.size * 4) this.compact();
      this.fd = this.io.open(path, "a");
    } catch (err) {
      this.releaseLock();
      throw err;
    }
  }

  private takeLock(pid: number, isAlive: (pid: number) => boolean): void {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(this.lockPath, "wx");
        writeSync(fd, String(pid));
        closeSync(fd);
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw new StoreError("the queue store's lock file could not be created", "locked");
        let holder = Number.NaN;
        try {
          holder = Number(readFileSync(this.lockPath, "utf8").trim());
        } catch {
          // unreadable: treated as stale below
        }
        if (Number.isInteger(holder) && holder > 0 && holder !== pid && isAlive(holder)) {
          throw new StoreError("another facilitator process is using this queue store", "locked");
        }
        try {
          unlinkSync(this.lockPath); // left by a process that is gone
        } catch {
          // another process took it first: the next attempt will see it
        }
      }
    }
    throw new StoreError("the queue store's lock could not be taken", "locked");
  }

  private releaseLock(): void {
    try {
      unlinkSync(this.lockPath);
    } catch {
      // already gone
    }
  }

  private replay(): void {
    if (!existsSync(this.path)) return;
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch {
      throw new StoreError("the queue store cannot be read", "unreadable");
    }
    const all = text.split("\n");
    // Every complete line ends in a newline, so the last piece is what follows the final newline: empty, or a write that stopped part-way.
    const complete = all.slice(0, -1);
    const tail = all[all.length - 1] as string;
    let good = 0;
    for (const raw of complete) {
      if (raw === "") {
        good += 1;
        continue;
      }
      let line: Line;
      try {
        line = JSON.parse(raw) as Line;
      } catch {
        throw new StoreError("the queue store is damaged: a line does not read", "corrupt");
      }
      this.applyLine(line);
      good += 1;
    }
    this.lines = good;
    if (tail === "") return;
    // The process stopped part-way through a write. A last line that does not parse is cut off; one that parses is kept.
    let parsed: Line | undefined;
    try {
      parsed = JSON.parse(tail) as Line;
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined) {
      this.applyLine(parsed);
      this.lines += 1;
      const fd = openSync(this.path, "a");
      try {
        writeSync(fd, "\n");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } else {
      const keep = Buffer.byteLength(complete.length ? `${complete.join("\n")}\n` : "", "utf8");
      const fd = openSync(this.path, "r+");
      try {
        ftruncateSync(fd, keep);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
  }

  private applyLine(line: Line): void {
    if (line && line.t === "put" && line.r && typeof line.r.id === "string") {
      this.apply(line.r);
    } else if (line && line.t === "usage" && typeof line.k === "string" && /^\d+$/.test(line.a) && Number.isInteger(line.c)) {
      this.counters.set(line.k, { count: line.c, amount: BigInt(line.a) });
    } else {
      throw new StoreError("the queue store is damaged: a line is not a record", "corrupt");
    }
  }

  /** Rewrites the journal as one line per record and one per counter, then swaps it in. */
  private compact(): void {
    const tmp = `${this.path}.compact`;
    const fd = this.io.open(tmp, "w");
    try {
      for (const r of this.records.values()) this.io.write(fd, `${JSON.stringify({ t: "put", r } satisfies Line)}\n`);
      for (const [k, u] of this.counters) this.io.write(fd, `${JSON.stringify({ t: "usage", k, c: u.count, a: u.amount.toString() } satisfies Line)}\n`);
      this.io.sync(fd);
    } finally {
      this.io.close(fd);
    }
    renameSync(tmp, this.path);
    this.lines = this.records.size + this.counters.size;
  }

  private append(lines: Line[]): void {
    if (this.fd === undefined) throw new StoreError("the queue store is closed", "closed");
    if (this.broken) throw new StoreError(this.broken, "write_failed");
    try {
      this.io.write(this.fd, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
      this.io.sync(this.fd);
      this.lines += lines.length;
    } catch {
      // Whatever the cause (a full disk, a removed file), what was just written may be half there. Stop writing for good.
      this.broken = "the queue store could not be written, so nothing more is accepted or sent";
      throw new StoreError(this.broken, "write_failed");
    }
  }

  override put(record: IntentRecord): void {
    this.putMany([record]);
  }

  override putMany(records: IntentRecord[], usage: readonly UsageStep[] = []): void {
    // Refused up front when the store is already broken or closed, so memory never gets ahead of a journal that cannot follow.
    if (this.broken) throw new StoreError(this.broken, "write_failed");
    if (this.fd === undefined) throw new StoreError("the queue store is closed", "closed");
    for (const r of records) this.apply(r);
    const touched = new Set<string>();
    for (const [key, amount] of usage) {
      this.bump(key, amount);
      touched.add(key);
    }
    const lines: Line[] = records.map((r) => ({ t: "put", r }));
    for (const key of touched) {
      const u = this.usage(key);
      lines.push({ t: "usage", k: key, c: u.count, a: u.amount.toString() });
    }
    // Memory is already updated, so /status shows the newest state; if this write fails the store is broken from here on.
    this.append(lines);
  }

  override addUsage(key: string, amount: bigint): void {
    this.putMany([], [[key, amount]]);
  }

  override healthy(): boolean {
    return this.broken === undefined && this.fd !== undefined;
  }

  override problem(): string | undefined {
    return this.broken ?? (this.fd === undefined ? "the queue store is closed" : undefined);
  }

  override close(): void {
    if (this.fd !== undefined) {
      try {
        this.io.sync(this.fd);
      } catch {
        // closing anyway
      }
      try {
        this.io.close(this.fd);
      } catch {
        // closing anyway
      }
      this.fd = undefined;
    }
    this.releaseLock();
  }
}

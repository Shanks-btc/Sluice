// One set of rules for the ledger, run against every implementation: the memory store and the file store of a facilitator that is one
// process, and the Redis ledger of a facilitator that runs as many copies (its Lua scripts running in the stand-in's Lua engine).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";
import { FileStore, LedgerRuleError, LocalLedger, MemoryStore, RELAYER_LOCK, RedisLedger, StaleLockError, StoreError, nodeIo, redisPrefix } from "@sluice/facilitator";
import type { IntentRecord, JournalIo, Ledger, Limit } from "@sluice/facilitator";
import { FakeRedis } from "../../helpers/fake-redis";
import { rejection } from "../../helpers/assert";

type Subject = {
  ledger: Ledger;
  /** Moves the ledger's own clock forward. */
  advance(ms: number): void;
  setKill(value: "1" | "0" | null): Promise<void>;
  /** Makes the ledger unable to record from now on. */
  break(): void;
  cleanup(): void;
};

const PREFIX = redisPrefix("local", `0x${"ab".repeat(20)}`);

const subjects: Array<[string, () => Subject]> = [
  [
    "the memory store",
    () => {
      let now = 1_000_000;
      const ledger = new LocalLedger(new MemoryStore(), { now: () => now });
      const store = ledger.store as MemoryStore;
      return {
        ledger,
        advance: (ms) => (now += ms),
        setKill: async (v) => ledger.setKillSwitch(v === "1"),
        // The memory store cannot fail by itself: this one is made to refuse writes, as a broken file store does.
        break: () => {
          store.healthy = () => false;
          store.problem = () => "broken for the test";
          store.putMany = () => {
            throw new StoreError("broken for the test", "write_failed");
          };
        },
        cleanup: () => undefined,
      };
    },
  ],
  [
    "the file store",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "sluice-ledger-"));
      let now = 1_000_000;
      let fail = false;
      const io: JournalIo = { ...nodeIo, write: (fd, text) => {
        if (fail) throw new Error("ENOSPC");
        nodeIo.write(fd, text);
      } };
      const ledger = new LocalLedger(new FileStore(join(dir, "queue.jsonl"), { io }), { now: () => now });
      return {
        ledger,
        advance: (ms) => (now += ms),
        setKill: async (v) => ledger.setKillSwitch(v === "1"),
        break: () => {
          fail = true;
          try {
            ledger.store.addUsage("break", 1n);
          } catch {
            // the store is broken from here on
          }
        },
        cleanup: () => {
          ledger.close();
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  ],
  [
    "Redis",
    () => {
      let now = 1_000_000;
      const redis = new FakeRedis(() => now);
      const ledger = new RedisLedger(redis, PREFIX);
      return {
        ledger,
        advance: (ms) => (now += ms),
        setKill: async (v) => void (await redis.command(v === null ? ["DEL", ledger.killSwitchKey] : ["SET", ledger.killSwitchKey, v])),
        break: () => (redis.down = true),
        cleanup: () => undefined,
      };
    },
  ],
];

const hex = (n: number, bytes = 32) => `0x${n.toString(16).padStart(bytes * 2, "0")}`;
const PAYER = hex(0xaa, 20);
const rec = (n: number, over: Partial<IntentRecord> = {}): IntentRecord => ({
  id: hex(n),
  payer: PAYER,
  payee: hex(0xbb, 20),
  signer: PAYER,
  amount: "10000",
  toolId: hex(1),
  nonce: hex(n + 1000),
  deadline: "9999999999",
  signature: `0x${"11".repeat(65)}`,
  status: "queued",
  createdAt: n,
  updatedAt: n,
  ...over,
});

for (const [name, make] of subjects) {
  describe(`Ledger: ${name}`, () => {
    let s: Subject;
    let ledger: Ledger;
    beforeEach(() => {
      s = make();
      ledger = s.ledger;
    });
    afterEach(() => s.cleanup());

    const insert = async (r: IntentRecord, limits: Limit[] = []) => ledger.insertIntent(r, (await ledger.openOf(r.payer)).version, limits);
    const take = async () => {
      const lock = await ledger.lock(RELAYER_LOCK, 10_000);
      expect(lock, "the lock is free").to.not.equal(undefined);
      return lock!;
    };

    it("takes a new intent once: the same one again is given back, and its nonce cannot be used by another", async () => {
      expect(await insert(rec(1))).to.deep.equal({ kind: "inserted" });
      expect(await ledger.get(hex(1))).to.deep.equal(rec(1));
      expect(await ledger.byNonce(PAYER.toUpperCase().replace("X", "x"), rec(1).nonce)).to.deep.equal(rec(1));
      expect(await insert(rec(1))).to.deep.equal({ kind: "exists", record: rec(1) });
      expect(await insert(rec(2, { nonce: rec(1).nonce }))).to.deep.equal({ kind: "nonce" });
      expect(await ledger.queuedCount()).to.equal(1);
    });

    it("refuses a new intent when the payer's open intents changed since they were read", async () => {
      const before = (await ledger.openOf(PAYER)).version;
      await insert(rec(1));
      expect(await ledger.insertIntent(rec(2), before, [])).to.deep.equal({ kind: "conflict" });
      const open = await ledger.openOf(PAYER);
      expect(open.records.map((r) => r.id)).to.deep.equal([hex(1)]);
      expect(open.version).to.not.equal(before);
      expect(await ledger.insertIntent(rec(2), open.version, [])).to.deep.equal({ kind: "inserted" });
    });

    it("counts the daily limits in the same write, and writes nothing when one would be passed", async () => {
      const limits = (amount = 10_000n): Limit[] => [
        { key: "intent:d:payer", amount, maxCount: 2, maxAmount: 30_000n },
        { key: "intent:d:*", amount, maxCount: 3, maxAmount: 1_000_000n },
      ];
      expect((await insert(rec(1), limits())).kind).to.equal("inserted");
      expect(await insert(rec(2), limits(25_000n))).to.deep.equal({ kind: "limit", index: 0 }); // the payer's amount
      expect((await insert(rec(2), limits())).kind).to.equal("inserted");
      expect(await insert(rec(3), limits())).to.deep.equal({ kind: "limit", index: 0 }); // the payer's count
      expect(await ledger.usage("intent:d:payer")).to.deep.equal({ count: 2, amount: 20_000n });
      expect(await ledger.usage("intent:d:*")).to.deep.equal({ count: 2, amount: 20_000n });
      const other = [{ key: "intent:d:other", amount: 1n, maxCount: 9 }, { key: "intent:d:*", amount: 1n, maxCount: 2 }];
      expect(await insert(rec(4, { payer: hex(0xcc, 20), nonce: hex(4) }), other)).to.deep.equal({ kind: "limit", index: 1 }); // everyone's
      expect(await ledger.usage("intent:d:other")).to.deep.equal({ count: 0, amount: 0n });
      expect(await ledger.queuedCount()).to.equal(2);
    });

    it("raises several counters together or not at all", async () => {
      const limits: Limit[] = [{ key: "a", amount: 0n, maxCount: 1 }, { key: "b", amount: 5n, maxAmount: 9n }];
      expect(await ledger.take(limits)).to.equal(undefined);
      expect(await ledger.take(limits)).to.equal(0);
      expect(await ledger.take([{ key: "c", amount: 0n, maxCount: 5 }, { key: "b", amount: 5n, maxAmount: 9n }])).to.equal(1);
      expect(await ledger.usage("a")).to.deep.equal({ count: 1, amount: 0n });
      expect(await ledger.usage("b")).to.deep.equal({ count: 1, amount: 5n });
      expect(await ledger.usage("c")).to.deep.equal({ count: 0, amount: 0n });
    });

    it("changes intents only for the holder of the relayer lock, and lists them by state, oldest first", async () => {
      await insert(rec(2));
      await insert(rec(1));
      expect((await ledger.queued(10)).map((r) => r.id)).to.deep.equal([hex(1), hex(2)]);
      expect(await ledger.queued(1)).to.have.length(1);
      const lock = await take();
      await ledger.update([rec(1, { status: "submitted", transaction: hex(7), updatedAt: 50 })], lock);
      expect((await ledger.submitted()).map((r) => r.id)).to.deep.equal([hex(1)]);
      expect((await ledger.queued(10)).map((r) => r.id)).to.deep.equal([hex(2)]);
      expect((await ledger.openOf(PAYER)).records.map((r) => r.id).sort()).to.deep.equal([hex(1), hex(2)]);
      await ledger.update([rec(1, { status: "settled", updatedAt: 70, blockNumber: 5 }), rec(2, { status: "skipped", updatedAt: 60 })], lock);
      expect(await ledger.countByStatus()).to.deep.equal({ held: 0, queued: 0, submitted: 0, settled: 1, skipped: 1, expired: 0, failed: 0 });
      expect((await ledger.openOf(PAYER)).records).to.deep.equal([]);
      expect((await ledger.latestSettled())?.id).to.equal(hex(1));
      await lock.release();
    });

    it("keeps a held intent out of the queue and counted against its payer, and releases it once, with no lock", async () => {
      expect(await insert(rec(1, { status: "held", hold: hex(5) }), [{ key: "intent:d:*", amount: 10_000n, maxCount: 1 }])).to.deep.equal({ kind: "inserted" });
      expect((await insert(rec(2, { status: "held", hold: hex(6) }), [{ key: "intent:d:*", amount: 1n, maxCount: 1 }])).kind, "a held one is counted by the day's limits").to.equal("limit");
      expect(await ledger.queued(10)).to.deep.equal([]);
      expect(await ledger.queuedCount()).to.equal(0);
      expect((await ledger.held(10)).map((r) => r.id)).to.deep.equal([hex(1)]);
      const before = await ledger.openOf(PAYER);
      expect(before.records.map((r) => r.id)).to.deep.equal([hex(1)]);
      expect(await ledger.countByStatus()).to.include({ held: 1, queued: 0 });
      const released = rec(1, { status: "queued", hold: hex(5), updatedAt: 9 });
      expect(await ledger.releaseHold(released)).to.equal(true);
      expect(await ledger.releaseHold(released), "once").to.equal(false);
      expect(await ledger.get(hex(1))).to.deep.equal(released);
      expect((await ledger.queued(10)).map((r) => r.id)).to.deep.equal([hex(1)]);
      expect(await ledger.held(10)).to.deep.equal([]);
      expect(await ledger.countByStatus()).to.include({ held: 0, queued: 1 });
      expect((await ledger.openOf(PAYER)).version).to.not.equal(before.version);
    });

    it("releases only what is held, only to the queue, and lets the lock's holder expire it", async () => {
      await insert(rec(1, { status: "held" }));
      expect(await rejection(ledger.releaseHold(rec(1, { status: "submitted" })))).to.be.instanceOf(LedgerRuleError);
      expect(await ledger.releaseHold(rec(7, { status: "queued" })), "one that is not there").to.equal(false);
      const lock = await take();
      await ledger.update([rec(1, { status: "expired", updatedAt: 50 })], lock);
      expect(await ledger.releaseHold(rec(1, { status: "queued" })), "a finished one stays finished").to.equal(false);
      expect((await ledger.get(hex(1)))?.status).to.equal("expired");
      expect(await ledger.held(10)).to.deep.equal([]);
      expect(await ledger.queued(10)).to.deep.equal([]);
      expect((await ledger.openOf(PAYER)).records).to.deep.equal([]);
      expect(await ledger.countByStatus()).to.include({ held: 0, expired: 1, queued: 0 });
      await lock.release();
    });

    it("keeps the highest block any of a payer's intents is recorded as settled in", async () => {
      const other = hex(0xcc, 20);
      await insert(rec(1));
      await insert(rec(2));
      await insert(rec(3, { payer: other }));
      expect(await ledger.settledBlock(PAYER)).to.equal(0);
      const lock = await take();
      await ledger.update([rec(1, { status: "settled", blockNumber: 90, updatedAt: 5 }), rec(3, { payer: other, status: "settled", blockNumber: 200, updatedAt: 5 })], lock);
      expect(await ledger.settledBlock(PAYER.replace("0x", "0x").toUpperCase().replace("0X", "0x"))).to.equal(90);
      // One written later, in an earlier block, does not lower it; one that was skipped does not move it.
      await ledger.update([rec(2, { status: "settled", blockNumber: 40, updatedAt: 6 })], lock);
      expect(await ledger.settledBlock(PAYER)).to.equal(90);
      expect(await ledger.settledBlock(other)).to.equal(200);
      expect(await ledger.settledBlock(hex(0xdd, 20))).to.equal(0);
      await lock.release();
    });

    it("fences out a holder whose lock expired, once another has taken it: nothing it writes lands", async () => {
      await insert(rec(1));
      const stale = await take();
      s.advance(10_001);
      expect(await stale.held(0)).to.equal(false);
      const fresh = await take();
      expect(Number(fresh.token)).to.be.greaterThan(Number(stale.token));
      expect(await rejection(ledger.update([rec(1, { status: "submitted" })], stale))).to.be.instanceOf(StaleLockError);
      expect((await ledger.get(hex(1)))?.status).to.equal("queued");
      await stale.release(); // letting go of a lock one no longer holds does nothing
      expect(await fresh.held(0)).to.equal(true);
      await ledger.update([rec(1, { status: "submitted" })], fresh);
    });

    it("lets a finished intent change no more, changes no intent that is not there, and applies a batch whole or not at all", async () => {
      await insert(rec(1));
      await insert(rec(2));
      const lock = await take();
      await ledger.update([rec(1, { status: "settled" })], lock);
      const back = await rejection(ledger.update([rec(2, { status: "submitted" }), rec(1, { status: "queued" })], lock));
      expect(back).to.be.instanceOf(LedgerRuleError);
      expect(back.message).to.contain("an intent that is settled cannot become queued");
      expect((await ledger.get(hex(2)))?.status).to.equal("queued");
      expect(await rejection(ledger.update([rec(9, { status: "settled" })], lock))).to.be.instanceOf(LedgerRuleError);
      await ledger.update([rec(1, { status: "settled", fee: "100" })], lock); // the same state with more written is allowed
      expect((await ledger.get(hex(1)))?.fee).to.equal("100");
    });

    it("sets aside the day's budget before it is spent, refuses past it, and counts each day apart", async () => {
      const gwei = 1_000_000_000n;
      const budget = 10n * gwei;
      expect(await ledger.reserveBudget("d1", 6n * gwei, budget)).to.include({ ok: true });
      expect(await ledger.reserveBudget("d1", 5n * gwei, budget)).to.include({ ok: false });
      await ledger.spendBudget("d1", 6n * gwei, 4n * gwei);
      expect(await ledger.budget("d1")).to.deep.equal({ spentWei: 4n * gwei, reservedWei: 0n });
      expect(await ledger.reserveBudget("d1", 6n * gwei, budget)).to.include({ ok: true });
      await ledger.releaseBudget("d1", 6n * gwei);
      expect(await ledger.budget("d1")).to.deep.equal({ spentWei: 4n * gwei, reservedWei: 0n });
      expect(await ledger.reserveBudget("d2", budget, budget)).to.include({ ok: true });
      // Amounts of the size of a real day's budget, which is far above 2^53 wei.
      const real = 2n * 10n ** 18n;
      expect(await ledger.reserveBudget("d3", real - gwei, real)).to.include({ ok: true });
      expect(await ledger.reserveBudget("d3", 2n * gwei, real)).to.include({ ok: false });
      expect(await ledger.reserveBudget("d3", gwei, real)).to.include({ ok: true, reservedWei: real });
    });

    it("counts a day's top-ups to one address before they are sent, and gives back one that was not", async () => {
      const cap = 3_000_000_000_000_000n;
      expect(await ledger.reserveTopUp("d1", PAYER, 2_000_000_000_000_000n, cap)).to.equal(true);
      expect(await ledger.reserveTopUp("d1", PAYER.toUpperCase().replace("X", "x"), 2_000_000_000_000_000n, cap)).to.equal(false);
      await ledger.releaseTopUp("d1", PAYER, 2_000_000_000_000_000n);
      expect(await ledger.reserveTopUp("d1", PAYER, cap, cap)).to.equal(true);
      expect(await ledger.reserveTopUp("d2", PAYER, cap, cap)).to.equal(true);
    });

    it("gives a lock to one holder at a time, and to the next once it is let go or expires", async () => {
      const a = await take();
      expect(await ledger.lock(RELAYER_LOCK, 10_000)).to.equal(undefined);
      expect(await a.held(9_000)).to.equal(true);
      expect(await a.held(20_000)).to.equal(false);
      await a.release();
      const b = await take();
      expect(await a.held(0)).to.equal(false);
      s.advance(10_001);
      await take();
      expect(await b.held(0)).to.equal(false);
    });

    it("counts a caller's requests in a window, and starts again after it", async () => {
      for (let i = 0; i < 3; i++) expect(await ledger.hit("ip:1.2.3.4", 3, 60_000)).to.deep.equal({ ok: true });
      const refused = await ledger.hit("ip:1.2.3.4", 3, 60_000);
      expect(refused.ok).to.equal(false);
      expect((refused as { retryAfterSeconds: number }).retryAfterSeconds).to.be.within(1, 60);
      expect(await ledger.hit("ip:5.6.7.8", 3, 60_000)).to.deep.equal({ ok: true });
      s.advance(60_001);
      expect(await ledger.hit("ip:1.2.3.4", 3, 60_000)).to.deep.equal({ ok: true });
    });

    it("holds a stored kill switch, off until it is set", async () => {
      expect(await ledger.killSwitchOn()).to.equal(false);
      await s.setKill("1");
      expect(await ledger.killSwitchOn()).to.equal(true);
      await s.setKill("0");
      expect(await ledger.killSwitchOn()).to.equal(false);
      await s.setKill("1");
      await s.setKill(null);
      expect(await ledger.killSwitchOn()).to.equal(false);
    });

    it("keeps each kind of alert once a day, and takes a refusal", async () => {
      await ledger.raiseAlert("d1", { at: 1, kind: "kill_switch", message: "on" });
      await ledger.raiseAlert("d1", { at: 2, kind: "kill_switch", message: "still on" });
      await ledger.raiseAlert("d1", { at: 3, kind: "low_balance", message: "low" });
      await ledger.raiseAlert("d2", { at: 4, kind: "kill_switch", message: "on again" });
      expect((await ledger.alerts()).map((a) => [a.at, a.kind])).to.deep.equal([[1, "kill_switch"], [3, "low_balance"], [4, "kill_switch"]]);
      await ledger.recordRefusal({ at: 5, what: "settle", reason: "sluice_kill_switch" });
    });

    it("says when it cannot record, and then refuses to write", async () => {
      await insert(rec(1));
      expect((await ledger.health()).ok).to.equal(true);
      const { version } = await ledger.openOf(PAYER);
      s.break();
      const health = await ledger.health();
      expect(health.ok).to.equal(false);
      expect(health.problem).to.be.a("string");
      expect(await rejection(ledger.insertIntent(rec(2), version, []))).to.be.instanceOf(StoreError);
      expect(await rejection(ledger.reserveBudget("d", 1n, 10n ** 12n))).to.be.instanceOf(StoreError);
    });
  });
}

describe("Ledger: Redis alone", () => {
  it("treats any stored value but 0 as the switch being on, and rounds QIE so that it can only spend less", async () => {
    const redis = new FakeRedis();
    const ledger = new RedisLedger(redis, PREFIX);
    for (const value of ["on", "true", "stop", "", " "]) {
      await redis.command(["SET", ledger.killSwitchKey, value]);
      expect(await ledger.killSwitchOn(), JSON.stringify(value)).to.equal(true);
    }
    const gwei = 1_000_000_000n;
    expect(await ledger.reserveBudget("d", 1n, 2n * gwei - 1n)).to.include({ ok: true, reservedWei: gwei }); // 1 wei counts as 1 gwei
    expect(await ledger.reserveBudget("d", 1n, 2n * gwei - 1n)).to.include({ ok: false }); // and a budget just under 2 gwei as 1
  });

  it("keeps each network and router apart, and names its keys under one prefix", async () => {
    const redis = new FakeRedis();
    const a = new RedisLedger(redis, redisPrefix("mainnet", `0x${"AB".repeat(20)}`));
    const b = new RedisLedger(redis, redisPrefix("testnet", `0x${"ab".repeat(20)}`));
    expect(a.killSwitchKey).to.equal(`sluice:facilitator:mainnet:0x${"ab".repeat(20)}:kill`);
    await redis.command(["SET", a.killSwitchKey, "1"]);
    expect([await a.killSwitchOn(), await b.killSwitchOn()]).to.deep.equal([true, false]);
  });
});

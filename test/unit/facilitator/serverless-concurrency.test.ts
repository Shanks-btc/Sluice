// Copies of the facilitator that share one database and one relayer key, as serverless functions do, made to run into one another on a
// local chain. The database is the Redis stand-in, whose requests, and the node's, are held back for random moments, so the copies'
// steps interleave in many orders. The claims: each payment settles once, no nonce of the relayer is used twice, and no two copies send at
// once. A control with the lock taken away shows that these tests would see it if they could.
import { expect } from "chai";
import { Transaction, Wallet, parseEther } from "ethers";
import type { JsonRpcProvider, Provider } from "ethers";
import { network } from "hardhat";
import { Facilitator, KillSwitch, RedisLedger, redisPrefix } from "@sluice/facilitator";
import type { Caps, Lock, IntentRecord, Ledger } from "@sluice/facilitator";
import { ERRORS, createLogger, signOnboarding } from "@sluice/sdk";
import type { RedisClient } from "@sluice/sdk";
import { USDC } from "../../helpers";
import { FakeRedis, slowed } from "../../helpers/fake-redis";
import { makePayment, requirementsFor, verifyBody } from "../../helpers/payments";
import { depositFor, fundWallet, setQie, startStack, throwawayWallet } from "../../helpers/stack";
import type { Stack } from "../../helpers/stack";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Time enough that a drain never stops for the clock in these tests. */
const ENOUGH = 3_600_000;

/** The same sequence of numbers every run for a given seed. */
function seeded(seed: number): () => number {
  let x = seed || 1;
  return () => {
    x = (x * 48_271) % 2_147_483_647;
    return x / 2_147_483_647;
  };
}

type Sent = { from: string; nonce: number; ok: boolean; copy: string };

/** The node as one copy sees it: every request waits a random moment, and every broadcast of the copy's is written down. */
function node(provider: JsonRpcProvider, copy: string, sent: Sent[], delay: () => Promise<void>, hooks: { before?: (method: string) => Promise<void> } = {}): Provider {
  return new Proxy(provider, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== "function") return value;
      const call = (value as (...a: unknown[]) => unknown).bind(target);
      if (prop === "broadcastTransaction") {
        return async (raw: string) => {
          await hooks.before?.("broadcastTransaction");
          await delay();
          const tx = Transaction.from(raw);
          const entry: Sent = { from: tx.from as string, nonce: tx.nonce, ok: false, copy };
          sent.push(entry);
          const out = await call(raw);
          entry.ok = true;
          return out;
        };
      }
      if (["estimateGas", "getTransactionCount", "getBlockNumber", "getTransactionReceipt", "getFeeData"].includes(String(prop))) {
        return async (...args: unknown[]) => {
          await hooks.before?.(String(prop));
          await delay();
          return call(...args);
        };
      }
      return call;
    },
  });
}

describe("Serverless facilitator: copies that run at once", function () {
  this.timeout(240_000);
  let s: Stack;
  let redis: FakeRedis;
  let sent: Sent[];
  let relayer: Wallet;
  let payers: Wallet[];
  let builder: string;
  const price = USDC("0.01");
  const logs: string[] = [];
  const prefix = () => redisPrefix("local", s.routerAddress);

  beforeEach(async () => {
    s = await startStack({ feeBps: 100 });
    redis = new FakeRedis();
    sent = [];
    logs.length = 0;
    relayer = throwawayWallet();
    await setQie(relayer.address, parseEther("1"));
    builder = throwawayWallet().address;
    payers = [throwawayWallet(), throwawayWallet(), throwawayWallet()];
    for (const p of payers) {
      await fundWallet(s, p, USDC("5"), parseEther("1"));
      await depositFor(s, p, USDC("5"));
    }
  });
  afterEach(async () => {
    await network.provider.send("evm_setAutomine", [true]);
    await s.stop();
  });

  type Copy = { delay?: () => Promise<void>; caps?: Partial<Caps>; ledger?: (client: RedisClient) => Ledger; killSwitch?: KillSwitch; before?: (method: string) => Promise<void>; lockTtlMs?: number; node?: (provider: Provider) => Provider };
  const copy = async (name: string, o: Copy = {}): Promise<Facilitator> => {
    const delay = o.delay ?? (async () => undefined);
    const client = slowed(redis, delay);
    const provider = node(s.provider, name, sent, delay, { before: o.before });
    return Facilitator.create({
      provider: o.node ? o.node(provider) : provider,
      router: s.routerAddress,
      relayerKey: relayer.privateKey,
      now: s.clock,
      ledger: o.ledger ? o.ledger(client) : new RedisLedger(client, prefix()),
      caps: o.caps,
      killSwitch: o.killSwitch,
      lockTtlMs: o.lockTtlMs,
      logger: createLogger({ write: (l) => logs.push(l), level: "debug", base: { copy: name } }),
    });
  };

  const pay = (payer: Wallet, amount = price) => makePayment(s, payer, payer.address, requirementsFor(s, builder, amount));
  /** Settled events of the router, as "payer|nonce". */
  const settledOnChain = async () => (await s.router.queryFilter(s.router.filters.Settled!())).map((e) => `${(e as unknown as { args: { payer: string; nonce: string } }).args.payer}|${(e as unknown as { args: { nonce: string } }).args.nonce}`.toLowerCase());
  const skippedOnChain = async () => (await s.router.queryFilter(s.router.filters.SettleSkipped!())).length;
  const noNonceTwice = () => {
    const mine = sent.filter((t) => t.from === relayer.address);
    expect(new Set(mine.map((t) => t.nonce)).size, `nonces broadcast: ${mine.map((t) => `${t.copy}:${t.nonce}`).join(" ")}`).to.equal(mine.length);
    expect(mine.filter((t) => !t.ok), "no broadcast was refused by the node").to.deep.equal([]);
    return mine;
  };

  for (const seed of [3, 7, 19, 41, 97]) {
    it(`settles every payment once, with no nonce used twice, when two copies drain at once (order ${seed})`, async () => {
      const random = seeded(seed);
      const delay = () => pause(Math.floor(random() * 6));
      const a = await copy("a", { delay, caps: { maxBatchSize: 3 } });
      const b = await copy("b", { delay, caps: { maxBatchSize: 3 } });
      const made = [];
      for (let i = 0; i < 9; i++) made.push(await pay(payers[i % 3]!));
      for (const [i, m] of made.entries()) expect((await (i % 2 ? b : a).settle(verifyBody(m))).success).to.equal(true);

      // Both drain, and drain again, with new payments arriving between and during the drains.
      const late = [await pay(payers[0]!), await pay(payers[1]!)];
      const arrivals = (async () => {
        for (const [i, m] of late.entries()) {
          await pause(Math.floor(random() * 40));
          const copyFor = i % 2 ? b : a;
          const answer = await copyFor.settle(verifyBody(m));
          expect(answer, answer.errorReason).to.include({ success: true });
          await copyFor.sweep(ENOUGH);
        }
      })();
      // No drain is called after these. A payment whose own drain found the relayer taken is picked up by whoever held it.
      await Promise.all([a.sweep(ENOUGH), b.sweep(ENOUGH), a.sweep(ENOUGH), arrivals]);

      const all = [...made, ...late];
      for (const m of all) expect((await a.status(m.digest))?.status, m.digest).to.equal("settled");
      const events = await settledOnChain();
      expect(events, "each payment settled once on the chain").to.have.length(all.length);
      expect(new Set(events).size).to.equal(all.length);
      expect(await skippedOnChain(), "no payment was sent twice: the router skipped none").to.equal(0);
      expect(await s.router.earnings(builder)).to.equal(BigInt(all.length) * (price - price / 100n));
      const mine = noNonceTwice();
      expect(await s.provider.getTransactionCount(relayer.address), "every transaction the relayer signed is on the chain").to.equal(mine.length);
      expect((await a.health()).queued).to.equal(0);
    });
  }

  it("control: with the lock and the fence taken away, the same two drains send the same payments twice", async () => {
    // A ledger that gives the relayer to everyone and accepts every writer, which is what the lock and the fence prevent.
    class NoLock extends RedisLedger {
      override async lock(): Promise<Lock> {
        return { token: "anyone", held: async () => true, release: async () => undefined };
      }
      override async update(records: IntentRecord[], fence: Lock): Promise<void> {
        await redis.command(["SET", `${prefix()}lock:relayer`, fence.token]);
        await super.update(records, fence).catch(() => undefined);
      }
    }
    // Both copies read the queue before either writes: each waits at the estimate until the other is there too.
    let arrived = 0;
    const together = async (method: string) => {
      if (method !== "estimateGas" || arrived >= 2) return;
      arrived += 1;
      for (let i = 0; i < 200 && arrived < 2; i++) await pause(5);
    };
    const broken = (client: RedisClient) => new NoLock(client, prefix());
    const a = await copy("a", { ledger: broken, before: together });
    const b = await copy("b", { ledger: broken, before: together });
    for (const p of payers) await a.settle(verifyBody(await pay(p)));
    await Promise.allSettled([a.flush(), b.flush()]);
    const mine = sent.filter((t) => t.from === relayer.address);
    expect(mine.length, "two batches were broadcast for one queue").to.be.greaterThan(1);
    const doubled = new Set(mine.map((t) => t.nonce)).size < mine.length || (await skippedOnChain()) > 0;
    expect(doubled, "a nonce was used twice, or the router had to skip a payment sent twice").to.equal(true);
    expect((await settledOnChain()).length, "even then the router paid each payment once").to.equal(3);
  });

  it("stops a copy whose lock expired from signing or writing once another copy has taken over", async () => {
    let now = Date.now();
    redis.now = () => now;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const atEstimate = new Promise<void>((resolve) => (reached = resolve));
    let first = true;
    const stall = async (method: string) => {
      if (method === "estimateGas" && first) {
        first = false;
        reached();
        await held; // the first copy stands still here, holding the lock
      }
    };
    const a = await copy("a", { before: stall, lockTtlMs: 30_000 });
    const b = await copy("b", { lockTtlMs: 30_000 });
    const m = await pay(payers[0]!);
    await a.settle(verifyBody(m));
    const stalled = a.flush({ waitMs: 0 });
    await atEstimate;
    expect((await b.flush({ waitMs: 0 })).held, "the relayer is taken").to.equal("relayer_busy");
    now += 31_000; // the lock expires, as it does when a function is stopped part-way
    expect(await b.flush({ waitMs: 0 })).to.include({ submitted: 1, settled: 1 });
    release();
    const report = await stalled;
    expect(report).to.include({ submitted: 0, held: "lock_lost" });
    expect(sent.filter((t) => t.from === relayer.address).map((t) => t.copy), "only the second copy ever sent").to.deep.equal(["b"]);
    expect((await a.status(m.digest))?.status).to.equal("settled");
    expect(await skippedOnChain()).to.equal(0);
    expect(logs.join("\n")).to.contain("the relayer lock was lost part-way");
  });

  // What can change between a batch being written down as sent and the moment it is signed. The copy is stopped as it reads the nonce it
  // would sign with, the change is made, and it goes on.
  const lateChanges: Array<[string, (at: { advance: (ms: number) => void; own: KillSwitch }) => unknown, string]> = [
    ["its lock has run out", ({ advance }) => advance(31_000), "lock_lost"],
    ["its lock has less than five seconds left", ({ advance }) => advance(26_000), "lock_lost"],
    ["the stored switch has been turned on", () => redis.command(["SET", `${prefix()}kill`, "1"]), ERRORS.killSwitch],
    ["the environment's switch has been turned on", ({ own }) => own.engage(), ERRORS.killSwitch],
  ];
  for (const [name, change, held] of lateChanges) {
    it(`signs nothing when, after the batch is written down, ${name}`, async () => {
      let now = Date.now();
      redis.now = () => now;
      const own = new KillSwitch();
      let changed = false;
      const a = await copy("a", {
        killSwitch: own,
        lockTtlMs: 30_000,
        before: async (method) => {
          if (method !== "getTransactionCount" || changed) return;
          changed = true;
          await change({ advance: (ms) => (now += ms), own });
        },
      });
      const m = await pay(payers[0]!);
      expect((await a.settle(verifyBody(m))).success).to.equal(true);
      const report = await a.flush({ waitMs: 0 });
      expect(changed, "the change was made at the nonce").to.equal(true);
      expect(report).to.include({ submitted: 0, held });
      expect(sent, "nothing was signed or broadcast").to.deep.equal([]);
      // Another copy, once the lock is free and the switch off, finishes it, once.
      await redis.command(["DEL", `${prefix()}kill`]);
      now += 31_000;
      const b = await copy("b", { lockTtlMs: 30_000 });
      expect(await b.flush({ waitMs: 0 })).to.include({ settled: 1 });
      expect(sent.map((t) => t.copy)).to.deep.equal(["b"]);
      expect((await b.status(m.digest))?.status).to.equal("settled");
    });
  }

  it("signs nothing when the stored switch cannot be read at the moment of signing", async () => {
    let blind = false;
    const ledger = (client: RedisClient) =>
      new (class extends RedisLedger {
        override async killSwitchOn() {
          if (blind) throw new Error("the switch cannot be read");
          return super.killSwitchOn();
        }
      })(client, prefix());
    const a = await copy("a", {
      ledger,
      before: async (method) => {
        if (method === "getTransactionCount") blind = true;
      },
    });
    const m = await pay(payers[0]!);
    expect((await a.settle(verifyBody(m))).success).to.equal(true);
    expect(await a.flush({ waitMs: 0 })).to.include({ submitted: 0, held: ERRORS.killSwitch });
    expect(sent).to.deep.equal([]);
    expect((await a.status(m.digest))?.status).to.equal("queued");
    blind = false;
    const b = await copy("b");
    expect(await b.flush({ waitMs: 0 })).to.include({ settled: 1 });
  });

  it("finishes, from the chain, a batch of a copy that stopped after broadcasting it, and sends nothing twice", async () => {
    let now = Date.now();
    redis.now = () => now;
    let broadcasts = 0;
    // The first copy's broadcast reaches the node, and then the copy is never heard from again.
    const a = await copy("a", { lockTtlMs: 30_000 });
    const vanishing = await copy("vanishing", {
      lockTtlMs: 30_000,
      before: async (method) => {
        if (method === "getTransactionReceipt" && broadcasts > 0) await new Promise(() => undefined);
        if (method === "broadcastTransaction") broadcasts += 1;
      },
    });
    await network.provider.send("evm_setAutomine", [false]);
    const m = await pay(payers[0]!);
    await vanishing.settle(verifyBody(m));
    void vanishing.flush({ waitMs: 0 });
    for (let i = 0; i < 200 && sent.filter((t) => t.ok).length === 0; i++) await pause(10);
    await pause(100);
    expect(sent).to.have.length(1);
    expect((await a.status(m.digest))?.status).to.equal("submitted");
    expect((await a.flush({ waitMs: 0 })).held, "its lock still holds").to.equal("relayer_busy");
    now += 31_000;
    expect(await a.flush({ waitMs: 0 }), "the transaction is waiting: it is not sent again").to.include({ submitted: 0, settled: 0 });
    await network.provider.send("evm_setAutomine", [true]);
    await network.provider.send("evm_mine", []);
    expect(await a.flush({ waitMs: 0 })).to.include({ submitted: 0, settled: 1 });
    expect(sent).to.have.length(1);
    expect(await settledOnChain()).to.have.length(1);
  });

  it("counts the daily caps once for all copies, and never lets them queue more than a payer holds", async () => {
    const tight = throwawayWallet();
    await fundWallet(s, tight, USDC("0.02"), parseEther("1"));
    await depositFor(s, tight, USDC("0.02")); // two calls' worth
    const random = seeded(11);
    const delay = () => pause(Math.floor(random() * 5));
    const copies = [await copy("a", { delay }), await copy("b", { delay }), await copy("c", { delay })];
    const same = await Promise.all(Array.from({ length: 6 }, () => pay(tight)));
    const answers = await Promise.all(same.map((m, i) => copies[i % 3]!.settle(verifyBody(m))));
    expect(answers.filter((r) => r.success), "exactly what the balance covers").to.have.length(2);
    expect(new Set(answers.filter((r) => !r.success).map((r) => r.errorReason))).to.deep.equal(new Set([ERRORS.insufficientFunds]));

    const capped = [await copy("d", { delay, caps: { globalDailyIntents: 5 } }), await copy("e", { delay, caps: { globalDailyIntents: 5 } })];
    const more = await Promise.all(Array.from({ length: 8 }, (_v, i) => pay(payers[i % 3]!)));
    const outcomes = await Promise.all(more.map((m, i) => capped[i % 2]!.settle(verifyBody(m))));
    expect(outcomes.filter((r) => r.success), "the global cap counts the two already queued").to.have.length(3);
    expect(new Set(outcomes.filter((r) => !r.success).map((r) => r.errorReason))).to.deep.equal(new Set([ERRORS.capGlobalDaily]));
  });

  /** A ledger whose first `times` inserts find the payer's queue changed under them, as a busy drain makes it. */
  const churning = (times: number, tries: { n: number }) => (client: RedisClient) =>
    new (class extends RedisLedger {
      override async insertIntent(...args: Parameters<RedisLedger["insertIntent"]>) {
        tries.n += 1;
        return tries.n <= times ? ({ kind: "conflict" } as const) : super.insertIntent(...args);
      }
    })(client, prefix());

  it("takes a good payment although the payer's queue changes again and again while it is checked", async () => {
    const tries = { n: 0 };
    const a = await copy("a", { ledger: churning(12, tries) });
    expect(await a.settle(verifyBody(await pay(payers[0]!)))).to.include({ success: true });
    expect(tries.n).to.equal(13);
    expect((await a.health()).queued).to.equal(1);
  });

  it("refuses, in the end and recording nothing, a payment whose payer's queue never holds still", async () => {
    const tries = { n: 0 };
    const a = await copy("a", { ledger: churning(Number.MAX_SAFE_INTEGER, tries) });
    const started = Date.now();
    expect(await a.settle(verifyBody(await pay(payers[0]!)))).to.include({ success: false, errorReason: ERRORS.unexpectedSettle });
    expect(Date.now() - started).to.be.lessThan(20_000);
    expect(tries.n).to.be.within(13, 40);
    expect((await a.health()).queued).to.equal(0);
    expect(redis.log.filter((c) => c === "HINCRBY")).to.deep.equal([]);
    expect(logs.join("\n")).to.contain("the payer's queue kept changing");
  });

  it("never counts the money of a settled payment as free again, however old the block number the node answers with", async () => {
    const tight = throwawayWallet();
    await fundWallet(s, tight, USDC("0.02"), parseEther("1"));
    await depositFor(s, tight, USDC("0.02"));
    const before = await s.provider.getBlockNumber();
    // A node (or the library's short cache of it) that still names the block from before the settlement.
    let stale = false;
    const lagging = (provider: Provider) =>
      new Proxy(provider, {
        get(target, prop) {
          if (prop === "getBlockNumber") return async () => (stale ? before : target.getBlockNumber());
          const value = Reflect.get(target, prop, target) as unknown;
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      }) as Provider;
    const a = await copy("a", { node: lagging });
    const b = await copy("b", { node: lagging });
    expect(await a.settle(verifyBody(await pay(tight, USDC("0.015"))))).to.include({ success: true });
    expect(await a.flush()).to.include({ settled: 1 });
    stale = true;
    expect(await b.settle(verifyBody(await pay(tight, USDC("0.015"))))).to.include({ success: false, errorReason: ERRORS.insufficientFunds });
    expect((await b.verify(verifyBody(await pay(tight, USDC("0.015"))))).invalidReason).to.equal(ERRORS.insufficientFunds);
    expect(await b.settle(verifyBody(await pay(tight, USDC("0.005"))))).to.include({ success: true });
  });

  it("counts the relayer's daily budget once for all copies", async () => {
    const budget = { dailyBudgetWei: 300_000_000_000_000n }; // room for about one batch's reservation
    const a = await copy("a", { caps: { ...budget, maxBatchSize: 1 } });
    const b = await copy("b", { caps: { ...budget, maxBatchSize: 1 } });
    for (let i = 0; i < 6; i++) await a.settle(verifyBody(await pay(payers[i % 3]!)));
    await Promise.all([a.sweep(ENOUGH), b.sweep(ENOUGH)]);
    await a.sweep(ENOUGH);
    const spent = (await a.health()).budget;
    expect(BigInt(spent.spentWei) + BigInt(spent.reservedWei) <= budget.dailyBudgetWei).to.equal(true);
    expect((await b.sweep(ENOUGH)).held).to.equal(ERRORS.capBudget);
    expect((await a.health()).queued).to.be.greaterThan(0);
    noNonceTwice();
  });

  it("gives one wallet one zero-QIE start, and one account its relayed requests, however many copies are asked at once", async () => {
    const a = await copy("a", { caps: { relayPerAccountPerDay: 1 } });
    const b = await copy("b", { caps: { relayPerAccountPerDay: 1 } });
    const poor = throwawayWallet();
    await fundWallet(s, poor, USDC("5"));
    const gasPrice = (await s.provider.getFeeData()).gasPrice as bigint;
    const txs = await signOnboarding(poor, { router: s.routerAddress, asset: s.tokenAddress, amount: USDC("1"), nonce: 0, gasPrice });
    const starts = await Promise.all([a.onboard({ payer: poor.address, ...txs }), b.onboard({ payer: poor.address, ...txs })]);
    expect(starts.filter((r) => r.ok), JSON.stringify(starts)).to.have.length(1);
    expect(sent.filter((t) => t.from === relayer.address), "one top-up was sent").to.have.length(1);

    const request = async (nonce: number) => {
      const message = { account: payers[0]!.address, to: payers[0]!.address, amount: 1000n, relayerFee: 0n, nonce: `0x${String(nonce).padStart(64, "0")}`, deadline: BigInt(s.clock() + 600) };
      const domain = { name: "SluiceRouter", version: "1", chainId: 1990, verifyingContract: s.routerAddress };
      const types = { Refund: [{ name: "payer", type: "address" }, { name: "to", type: "address" }, { name: "amount", type: "uint256" }, { name: "relayerFee", type: "uint256" }, { name: "nonce", type: "bytes32" }, { name: "deadline", type: "uint256" }] };
      const signature = await payers[0]!.signTypedData(domain, types, { payer: message.account, to: message.to, amount: message.amount, relayerFee: 0n, nonce: message.nonce, deadline: message.deadline });
      return { kind: "refund", account: message.account, to: message.to, amount: "1000", nonce: message.nonce, deadline: message.deadline.toString(), signature };
    };
    const [one, two] = [await request(1), await request(2)];
    const relayed = await Promise.all([a.relay(one), b.relay(two)]);
    expect(relayed.filter((r) => r.ok), JSON.stringify(relayed)).to.have.length(1);
    noNonceTwice();
  });

  it("stops every copy's sends while the stored switch or the environment's switch is on, and logs each refusal", async () => {
    const a = await copy("a");
    const b = await copy("b", { killSwitch: new KillSwitch(true) });
    const m = await pay(payers[0]!);
    expect((await a.settle(verifyBody(m))).success).to.equal(true);
    // The environment's switch stops its own copy.
    expect((await b.flush()).held).to.equal(ERRORS.killSwitch);
    // The stored switch stops every copy.
    await redis.command(["SET", `${prefix()}kill`, "1"]);
    expect((await a.flush()).held).to.equal(ERRORS.killSwitch);
    expect(await a.settle(verifyBody(await pay(payers[1]!)))).to.include({ success: false, errorReason: ERRORS.killSwitch });
    expect((await a.verify(verifyBody(await pay(payers[1]!)))).invalidReason).to.equal(ERRORS.killSwitch);
    const poor = throwawayWallet();
    expect((await a.onboard({ payer: poor.address, approveTx: "0x", depositTx: "0x" })).error).to.equal(ERRORS.killSwitch);
    expect((await a.relay({ kind: "revoke" })).error).to.equal(ERRORS.killSwitch);
    expect((await a.relayer.sendTopUp(poor.address, 1000n).catch((e: { code: string }) => e)) as { code: string }).to.include({ code: ERRORS.killSwitch });
    expect(sent).to.deep.equal([]);
    expect((await a.health()).killSwitch).to.equal(true);
    for (const what of ["batch refused", "settle refused", "verify refused", "zero-QIE start refused", "relayed request refused"]) expect(logs.join("\n"), what).to.contain(what);
    const kept = (await redis.command(["LRANGE", `${prefix()}refusals`, 0, 499])) as string[];
    expect(kept.map((k) => (JSON.parse(k) as { what: string }).what)).to.include.members(["batch", "settle", "verify", "zero-QIE start", "relayed request"]);
    await redis.command(["DEL", `${prefix()}kill`]);
    expect(await a.flush()).to.include({ submitted: 1, settled: 1 });
  });

  it("starts no batch it has no time to see through, and says what is left for the next drain", async () => {
    const a = await copy("a", { caps: { maxBatchSize: 1 } });
    for (const p of payers) await a.settle(verifyBody(await pay(p)));
    // A batch may need the receipt wait, 120 seconds, and a margin. A drain with a minute sends one and stops.
    expect(await a.sweep(60_000)).to.include({ batches: 1, settled: 1, held: "out_of_time", remaining: 2 });
    expect(await a.sweep(ENOUGH)).to.include({ batches: 2, settled: 2, remaining: 0 });
    expect(await a.sweep(ENOUGH), "again: there is nothing to do, and doing it does no harm").to.include({ batches: 0, settled: 0, remaining: 0 });
    expect(noNonceTwice()).to.have.length(3);
  });

  it("accepts and sends nothing while the database cannot be reached, and carries on when it can", async () => {
    const a = await copy("a");
    const m = await pay(payers[0]!);
    await a.settle(verifyBody(m));
    redis.down = true;
    expect(await a.settle(verifyBody(await pay(payers[1]!)))).to.include({ success: false, errorReason: ERRORS.storeUnavailable });
    expect((await a.verify(verifyBody(await pay(payers[1]!)))).invalidReason).to.equal(ERRORS.storeUnavailable);
    expect((await a.flush()).held).to.equal(ERRORS.storeUnavailable);
    expect((await a.relay({ kind: "revoke" })).error).to.equal(ERRORS.storeUnavailable);
    const health = await a.health();
    expect(health).to.include({ ok: false, killSwitch: true });
    expect(health.store.healthy).to.equal(false);
    expect(sent).to.deep.equal([]);
    redis.down = false;
    expect(await a.flush()).to.include({ submitted: 1, settled: 1 });
  });
});

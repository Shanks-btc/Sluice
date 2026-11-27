// The facilitator's queue survives what real hosting does to it: a restart, a lost connection, a full disk, a damaged file.
//
// Part one holds the journal store to its rules on its own. Part two runs a facilitator on a local chain and stops it at each
// point of a batch's life (before the transaction exists, after the node has it, before the hash is written down), then starts
// another from the same journal and checks that the intents settle once and none is lost. The real kill of a separate process is
// in crash.test.ts. Everything is local, with keys made for the run.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { expect } from "chai";
import { Wallet, parseEther } from "ethers";
import { network } from "hardhat";
import { ERRORS } from "@sluice/sdk";
import { FileStore, MemoryStore, StoreError, nodeIo } from "@sluice/facilitator";
import type { IntentRecord, JournalIo } from "@sluice/facilitator";
import { USDC } from "../../helpers";
import { rejection } from "../../helpers/assert";
import { chaosProvider, makeFacilitator, settledEvents, tempState } from "../../helpers/chaos";
import type { Chaos, Temp } from "../../helpers/chaos";
import { makePayment, requirementsFor, verifyBody } from "../../helpers/payments";
import { depositFor, fundWallet, startStack, throwawayWallet } from "../../helpers/stack";
import type { Stack } from "../../helpers/stack";

const hex = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const rec = (n: number, over: Partial<IntentRecord> = {}): IntentRecord => ({
  id: hex(n),
  payer: `0x${"11".repeat(20)}`,
  payee: `0x${"22".repeat(20)}`,
  signer: `0x${"11".repeat(20)}`,
  amount: "10000",
  toolId: hex(900),
  nonce: hex(1000 + n),
  deadline: "9999999999",
  signature: `0x${"aa".repeat(65)}`,
  status: "queued",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe("Journal store", function () {
  let t: Temp;
  beforeEach(() => {
    t = tempState();
  });
  afterEach(() => t.cleanup());

  it("writes every record and counter to disk and reads them all back after a restart", () => {
    const a = new FileStore(t.journal);
    a.put(rec(1));
    a.putMany([rec(2), rec(3, { status: "submitted", batch: "0xb1", fromBlock: 7, transaction: hex(77) })], [["intent:d:p", 30_000n], ["intent:d:*", 30_000n]]);
    a.put({ ...rec(1), status: "settled", transaction: hex(5), blockNumber: 9, fee: "100" });
    a.addUsage("intent:d:p", 10_000n);
    a.close();

    const b = new FileStore(t.journal);
    expect(b.size()).to.equal(3);
    expect(b.get(hex(1))).to.deep.include({ status: "settled", transaction: hex(5), blockNumber: 9, fee: "100" });
    expect(b.byNonce(`0x${"11".repeat(20)}`, hex(1002))?.id).to.equal(hex(2));
    expect(b.queued(10).map((r) => r.id)).to.deep.equal([hex(2)]);
    expect(b.submitted().map((r) => r.id)).to.deep.equal([hex(3)]);
    expect(b.get(hex(3))).to.deep.include({ batch: "0xb1", fromBlock: 7, transaction: hex(77) });
    expect(b.usage("intent:d:p")).to.deep.equal({ count: 2, amount: 40_000n });
    expect(b.usage("intent:d:*")).to.deep.equal({ count: 1, amount: 30_000n });
    expect(b.pendingFor(`0x${"11".repeat(20)}`)).to.equal(20_000n); // one queued and one submitted
    expect(b.healthy()).to.equal(true);
    b.close();
  });

  it("counts a submitted intent as pending spend, so a restart cannot let a payer spend the same balance twice", () => {
    const a = new FileStore(t.journal);
    a.put(rec(1, { status: "submitted", amount: "400000" }));
    a.close();
    const b = new FileStore(t.journal);
    expect(b.pendingFor(`0x${"11".repeat(20)}`)).to.equal(400_000n);
    expect(b.pendingForAgent(`0x${"11".repeat(20)}`, `0x${"11".repeat(20)}`)).to.equal(400_000n);
    b.close();
  });

  it("drops a last line that stopped part-way, keeps everything before it, and is clean afterwards", () => {
    const a = new FileStore(t.journal);
    a.put(rec(1));
    a.put(rec(2));
    a.close();
    const whole = readFileSync(t.journal, "utf8");
    appendFileSync(t.journal, '{"t":"put","r":{"id":"0xabc","payer":"0x11');
    const b = new FileStore(t.journal);
    expect(b.size()).to.equal(2);
    expect(readFileSync(t.journal, "utf8")).to.equal(whole); // cut back to the last whole line
    b.put(rec(3));
    b.close();
    const c = new FileStore(t.journal);
    expect(c.size()).to.equal(3);
    c.close();
  });

  it("keeps a last line that is complete and only lacks its newline", () => {
    const a = new FileStore(t.journal);
    a.put(rec(1));
    a.close();
    appendFileSync(t.journal, JSON.stringify({ t: "put", r: rec(2) })); // no newline
    const b = new FileStore(t.journal);
    expect(b.size()).to.equal(2);
    b.put(rec(3));
    b.close();
    const c = new FileStore(t.journal);
    expect(c.size()).to.equal(3);
    c.close();
  });

  it("refuses to open a journal with a damaged line before the end, instead of guessing, and leaves no lock behind", () => {
    const a = new FileStore(t.journal);
    a.put(rec(1));
    a.put(rec(2));
    a.close();
    const lines = readFileSync(t.journal, "utf8").split("\n");
    lines[0] = lines[0]!.slice(0, 20); // damage the first line
    writeFileSync(t.journal, lines.join("\n"));
    expect(() => new FileStore(t.journal)).to.throw(StoreError).with.property("code", "corrupt");
    expect(existsSync(`${t.journal}.lock`)).to.equal(false);
  });

  it("refuses a line that parses but is not a record or a counter", () => {
    writeFileSync(t.journal, `${JSON.stringify({ t: "put", r: rec(1) })}\n{"t":"other"}\n`);
    expect(() => new FileStore(t.journal)).to.throw(StoreError).with.property("code", "corrupt");
    writeFileSync(t.journal, `${JSON.stringify({ t: "usage", k: "x", c: 1, a: "-5" })}\n`);
    expect(() => new FileStore(t.journal)).to.throw(StoreError).with.property("code", "corrupt");
  });

  it("refuses to open a journal that cannot be read", () => {
    // A folder where the file should be: the path exists and cannot be read as a file.
    const dir = `${t.journal}-dir`;
    require("node:fs").mkdirSync(dir);
    expect(() => new FileStore(dir)).to.throw(StoreError).with.property("code", "unreadable");
  });

  it("does not let two processes use one journal, and takes over a lock left by a process that is gone", () => {
    const first = new FileStore(t.journal, { pid: 4001, isAlive: () => true });
    first.put(rec(1));
    const error = (() => {
      try {
        new FileStore(t.journal, { pid: 4002, isAlive: (pid) => pid === 4001 });
      } catch (e) {
        return e as StoreError;
      }
      return undefined;
    })();
    expect(error).to.be.instanceOf(StoreError);
    expect(error?.code).to.equal("locked");
    expect(error?.message).to.not.contain(t.dir); // no path in the message
    // The first process is gone (it never closed): its lock is stale and is taken over.
    const second = new FileStore(t.journal, { pid: 4002, isAlive: () => false });
    expect(second.size()).to.equal(1);
    second.close();
    expect(existsSync(`${t.journal}.lock`)).to.equal(false);
  });

  it("fails closed when a write fails: it stays unhealthy, refuses every later write, and a restart still reads what was safe", () => {
    let fail = false;
    const io: JournalIo = {
      ...nodeIo,
      write: (fd, text) => {
        if (fail) {
          nodeIo.write(fd, text.slice(0, Math.floor(text.length / 2))); // half of it reaches the disk, then the disk is full
          throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
        }
        nodeIo.write(fd, text);
      },
    };
    const a = new FileStore(t.journal, { io });
    a.put(rec(1));
    fail = true;
    const error = (() => {
      try {
        a.put(rec(2));
      } catch (e) {
        return e as StoreError;
      }
      return undefined;
    })();
    expect(error).to.be.instanceOf(StoreError);
    expect(error?.code).to.equal("write_failed");
    expect(a.healthy()).to.equal(false);
    expect(a.problem()).to.be.a("string").and.to.not.contain(t.dir);
    fail = false; // even if the disk recovers, a store that missed a write does not carry on as if it had not
    expect(() => a.put(rec(3))).to.throw(StoreError);
    expect(() => a.addUsage("k", 1n)).to.throw(StoreError);
    expect(a.get(hex(1))).to.not.equal(undefined); // reads still answer
    a.close();
    const b = new FileStore(t.journal); // the half-written line is cut off; the first record is whole
    expect(b.size()).to.equal(1);
    expect(b.get(hex(2))).to.equal(undefined);
    b.close();
  });

  it("refuses writes after it is closed", () => {
    const a = new FileStore(t.journal);
    a.close();
    expect(a.healthy()).to.equal(false);
    expect(() => a.put(rec(1))).to.throw(StoreError).with.property("code", "closed");
  });

  it("rewrites a long journal as one line per record when it opens, without changing what it holds", () => {
    // Written straight to the file: 2,100 flushed writes through the store would take a minute on a slow disk.
    const lines: string[] = [];
    for (let i = 0; i < 2100; i++) lines.push(JSON.stringify({ t: "put", r: rec(1, { updatedAt: i }) }));
    lines.push(JSON.stringify({ t: "usage", k: "intent:d:p", c: 1, a: "5" }));
    writeFileSync(t.journal, `${lines.join("\n")}\n`);
    expect(readFileSync(t.journal, "utf8").split("\n").length).to.be.greaterThan(2000);
    const b = new FileStore(t.journal);
    expect(readFileSync(t.journal, "utf8").trim().split("\n")).to.have.length(2); // one record and one counter
    expect(b.get(hex(1))?.updatedAt).to.equal(2099);
    expect(b.usage("intent:d:p")).to.deep.equal({ count: 1, amount: 5n });
    b.close();
  });

  it("the memory store takes the same calls, and is always healthy", () => {
    const m = new MemoryStore();
    m.putMany([rec(1), rec(2)], [["k", 3n]]);
    expect(m.size()).to.equal(2);
    expect(m.usage("k")).to.deep.equal({ count: 1, amount: 3n });
    expect(m.healthy()).to.equal(true);
    expect(m.problem()).to.equal(undefined);
  });
});

describe("Facilitator durability: a stop at any point in a batch's life", function () {
  this.timeout(120_000);
  let s: Stack;
  let t: Temp;
  let payer: Wallet;
  let builder: string;
  const price = USDC("0.01");

  beforeEach(async () => {
    s = await startStack({ feeBps: 100 });
    t = tempState();
    payer = throwawayWallet();
    builder = throwawayWallet().address;
    await fundWallet(s, payer, USDC("5"), parseEther("1"));
    await depositFor(s, payer, USDC("5"));
  });
  afterEach(async () => {
    await network.provider.send("evm_setAutomine", [true]);
    await s.stop();
    t.cleanup();
  });

  const payment = () => makePayment(s, payer, payer.address, requirementsFor(s, builder, price));
  const earnedOnce = async () => expect(await s.router.earnings(builder)).to.equal(price - price / 100n);

  it("keeps the queue across a restart: the same intent is one record, and it settles once", async () => {
    const a = await makeFacilitator(s, { store: new FileStore(t.journal) });
    const m = await payment();
    expect((await a.facilitator.settle(verifyBody(m))).success).to.equal(true);
    a.facilitator.store.close();

    const b = await makeFacilitator(s, { store: new FileStore(t.journal) });
    const again = await b.facilitator.settle(verifyBody(m));
    expect(again.success).to.equal(true);
    expect(again.extensions?.sluice?.status).to.equal("queued");
    expect(b.facilitator.store.size()).to.equal(1);
    expect(await b.facilitator.flush()).to.include({ submitted: 1, settled: 1 });
    await earnedOnce();
    expect((await b.facilitator.status(m.digest))?.status).to.equal("settled");
    b.facilitator.store.close();

    // Another restart, and the intent sent a third time: still one record, still paid once.
    const c = await makeFacilitator(s, { store: new FileStore(t.journal) });
    expect((await c.facilitator.settle(verifyBody(m))).extensions?.sluice?.status).to.equal("settled");
    expect(await c.facilitator.flush()).to.include({ submitted: 0 });
    expect(c.facilitator.store.size()).to.equal(1);
    await earnedOnce();
    c.facilitator.store.close();
  });

  it("keeps the daily counters across a restart, so a restart is not a way round a cap", async () => {
    const a = await makeFacilitator(s, { store: new FileStore(t.journal), caps: { payerDailyIntents: 2 } });
    for (let i = 0; i < 2; i++) expect((await a.facilitator.settle(verifyBody(await payment()))).success).to.equal(true);
    a.facilitator.store.close();
    const b = await makeFacilitator(s, { store: new FileStore(t.journal), caps: { payerDailyIntents: 2 } });
    expect(await b.facilitator.settle(verifyBody(await payment()))).to.include({ success: false, errorReason: ERRORS.capPayerDaily });
    b.facilitator.store.close();
  });

  it("puts a batch that never reached the network back in the queue, and sends it on the next flush", async () => {
    const chaos: Chaos = { mode: "drop", sent: 0 };
    const a = await makeFacilitator(s, { store: new FileStore(t.journal), provider: chaosProvider(s.provider, chaos) });
    const m = await payment();
    await a.facilitator.settle(verifyBody(m));
    const first = await a.facilitator.flush();
    expect(first).to.include({ submitted: 0, settled: 0, failed: 0 });
    expect(chaos.sent).to.equal(1);
    expect((await a.facilitator.status(m.digest))?.status).to.equal("queued"); // not lost, and not stuck as submitted
    chaos.mode = "off";
    expect(await a.facilitator.flush()).to.include({ submitted: 1, settled: 1 });
    await earnedOnce();
    a.facilitator.store.close();
  });

  it("recognises a batch that reached the chain but whose answer was lost, and does not send it again", async () => {
    const chaos: Chaos = { mode: "forward-then-throw", sent: 0 };
    const a = await makeFacilitator(s, { store: new FileStore(t.journal), provider: chaosProvider(s.provider, chaos) });
    const m = await payment();
    await a.facilitator.settle(verifyBody(m));
    const report = await a.facilitator.flush();
    expect(report.settled).to.equal(1); // found from the chain, from its Settled event
    const done = (await a.facilitator.status(m.digest))!;
    expect(done.status).to.equal("settled");
    // The transaction hash it records is the one on the chain that emitted the event.
    const logs = await settledEvents(s.router, payer.address);
    expect(logs).to.have.length(1);
    expect(done.transaction).to.equal(logs[0]!.transactionHash);
    expect(done.blockNumber).to.equal(logs[0]!.blockNumber);
    chaos.mode = "off";
    expect(await a.facilitator.flush()).to.include({ submitted: 0 });
    expect(chaos.sent).to.equal(1); // one transaction was ever sent
    expect(await s.provider.getTransactionCount(a.relayerAddress)).to.equal(1);
    await earnedOnce();
    a.facilitator.store.close();
  });

  it("finishes a batch a stopped process left behind: it settled on the chain, the journal still says submitted", async () => {
    // The first facilitator's transaction is mined, then it stops (its call never returns), before the hash is written down.
    const chaos: Chaos = { mode: "forward-then-hang", sent: 0 };
    const a = await makeFacilitator(s, { store: new FileStore(t.journal), provider: chaosProvider(s.provider, chaos) });
    const m = await payment();
    await a.facilitator.settle(verifyBody(m));
    void a.facilitator.flush(); // never finishes: this is the stopped process
    for (let i = 0; i < 100 && chaos.sent === 0; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 200));
    expect(readFileSync(t.journal, "utf8")).to.contain('"status":"submitted"');
    await earnedOnce();

    // The replacement starts from the same journal and the same relayer key, and settles what it finds from the chain.
    const b = await makeFacilitator(s, { store: new FileStore(t.journal), relayerKey: a.relayerKey });
    const done = (await b.facilitator.status(m.digest))!;
    expect(done.status).to.equal("settled");
    expect(done.transaction).to.match(/^0x[0-9a-f]{64}$/);
    expect(await b.facilitator.flush()).to.include({ submitted: 0 });
    expect(await s.provider.getTransactionCount(b.relayerAddress)).to.equal(1);
    await earnedOnce();
    b.facilitator.store.close();
  });

  it("does not count an intent twice once its batch is mined but not yet written down, so a payer who can afford a call is not refused", async () => {
    const tight = throwawayWallet();
    await fundWallet(s, tight, USDC("0.02"), parseEther("1"));
    await depositFor(s, tight, USDC("0.02")); // exactly two calls' worth
    const chaos: Chaos = { mode: "forward-then-hang", sent: 0 };
    const a = await makeFacilitator(s, { store: new FileStore(t.journal), provider: chaosProvider(s.provider, chaos) });
    const call = () => makePayment(s, tight, tight.address, requirementsFor(s, builder, price));
    const first = await call();
    expect((await a.facilitator.settle(verifyBody(first))).success).to.equal(true);
    void a.facilitator.flush(); // mined, and the process has not yet recorded it
    for (let i = 0; i < 100 && chaos.sent === 0; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 200));
    expect((await a.facilitator.status(first.digest))?.status).to.equal("submitted");
    expect(await s.router.payerBalance(tight.address)).to.equal(USDC("0.01")); // the chain already took it
    // The first call is in the chain's balance, not pending as well: a second call fits, a third does not.
    const second = await call();
    expect((await a.facilitator.settle(verifyBody(second))).success).to.equal(true);
    expect(await a.facilitator.settle(verifyBody(await call()))).to.include({ success: false, errorReason: ERRORS.insufficientFunds });
  });

  it("puts an intent back in the queue when the process stopped before the batch was ever sent", async () => {
    const m = await payment();
    const a = await makeFacilitator(s, { store: new FileStore(t.journal) });
    await a.facilitator.settle(verifyBody(m));
    // The state a stop leaves after the journal write and before the broadcast: submitted, no hash, no transaction.
    const queued = a.facilitator.store.get(m.digest)!;
    a.facilitator.store.put({ ...queued, status: "submitted", batch: "0xdead", fromBlock: 1 });
    a.facilitator.store.close();

    const b = await makeFacilitator(s, { store: new FileStore(t.journal), relayerKey: a.relayerKey });
    expect((await b.facilitator.status(m.digest))?.status).to.equal("queued");
    expect(await b.facilitator.flush()).to.include({ submitted: 1, settled: 1 });
    await earnedOnce();
    b.facilitator.store.close();
  });

  it("leaves an intent submitted while its transaction is still waiting, and settles it when it is mined, with one transaction in all", async () => {
    await network.provider.send("evm_setAutomine", [false]);
    const chaos: Chaos = { mode: "forward-then-hang", sent: 0 };
    const a = await makeFacilitator(s, { store: new FileStore(t.journal), provider: chaosProvider(s.provider, chaos) });
    const m = await payment();
    await a.facilitator.settle(verifyBody(m));
    void a.facilitator.flush(); // the transaction is in the node's queue and the process stops
    for (let i = 0; i < 100 && chaos.sent === 0; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 200));

    const b = await makeFacilitator(s, { store: new FileStore(t.journal), relayerKey: a.relayerKey });
    expect((await b.facilitator.status(m.digest))?.status).to.equal("submitted"); // waiting, not re-sent
    const waiting = await b.facilitator.flush();
    expect(waiting).to.include({ submitted: 0, settled: 0 });
    expect(await s.provider.send("eth_getTransactionCount", [b.relayerAddress, "pending"])).to.equal("0x1");
    const health = await b.facilitator.health();
    expect(health.inFlight.count).to.equal(1);

    await network.provider.send("evm_setAutomine", [true]);
    await network.provider.send("evm_mine", []);
    expect(await b.facilitator.flush()).to.include({ settled: 1 });
    expect((await b.facilitator.status(m.digest))?.status).to.equal("settled");
    expect(await s.provider.getTransactionCount(b.relayerAddress)).to.equal(1);
    await earnedOnce();
    b.facilitator.store.close();
  });

  it("does not count a failed connection to the node against an intent: it waits in the queue and settles when the node is back", async () => {
    const m = await payment();
    const down = Object.assign(new Error("node down"), { code: "NETWORK_ERROR" });
    const flaky = new Proxy(s.provider, {
      get(target, prop) {
        if (prop === "estimateGas") return async () => { throw down; };
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const a = await makeFacilitator(s, { store: new FileStore(t.journal), provider: flaky });
    await a.facilitator.settle(verifyBody(m));
    for (let i = 0; i < 5; i++) expect(await a.facilitator.flush()).to.include({ failed: 0, submitted: 0 });
    expect((await a.facilitator.status(m.digest))?.status).to.equal("queued");
    a.facilitator.store.close();
    const b = await makeFacilitator(s, { store: new FileStore(t.journal), relayerKey: a.relayerKey });
    expect(await b.facilitator.flush()).to.include({ submitted: 1, settled: 1 });
    b.facilitator.store.close();
  });

  it("sends nothing and accepts nothing when the store cannot be written, and says so in /health", async () => {
    let fail = false;
    const io: JournalIo = {
      ...nodeIo,
      write: (fd, text) => {
        if (fail) throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
        nodeIo.write(fd, text);
      },
    };
    const a = await makeFacilitator(s, { store: new FileStore(t.journal, { io }) });
    const queuedOk = await payment();
    expect((await a.facilitator.settle(verifyBody(queuedOk))).success).to.equal(true);
    fail = true;
    const m = await payment();
    const refused = await a.facilitator.settle(verifyBody(m));
    expect(refused).to.include({ success: false, errorReason: ERRORS.storeUnavailable });
    fail = false;
    expect(await a.facilitator.settle(verifyBody(await payment()))).to.include({ success: false, errorReason: ERRORS.storeUnavailable });
    expect((await a.facilitator.verify(verifyBody(await payment()))).invalidReason).to.equal(ERRORS.storeUnavailable);
    const report = await a.facilitator.flush();
    expect(report.held).to.equal(ERRORS.storeUnavailable);
    expect(report.submitted).to.equal(0);
    expect(await s.router.earnings(builder)).to.equal(0n); // the intent that was queued was not sent blind
    const health = await a.facilitator.health();
    expect(health.ok).to.equal(false);
    expect(health.store.healthy).to.equal(false);
    expect(JSON.stringify(health)).to.not.contain(t.dir);
    expect(a.facilitator.relayer.alerts.map((x) => x.kind)).to.include("store_unavailable");
  });

  it("will not start from a journal it cannot read", async () => {
    writeFileSync(t.journal, "not json at all\nstill not json\n");
    const error = await rejection(Promise.resolve().then(() => new FileStore(t.journal)));
    expect(error).to.be.instanceOf(StoreError);
  });
});

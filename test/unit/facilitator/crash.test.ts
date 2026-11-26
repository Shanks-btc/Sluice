// A real crash. The facilitator runs as its own process, its node is a proxy that fails on purpose, and the process is killed
// (SIGKILL: no handler runs, nothing is flushed) at three points in a batch's life. A second process then starts from the same
// queue file. In every case each intent is settled on the chain exactly once and none is lost, and the second process never sends
// a batch for an intent the chain already settled.
//
// Everything is local: the chain is the in-process Hardhat network over HTTP, the keys were made for the run, and no transaction
// leaves this machine.
import { readFileSync, writeFileSync } from "node:fs";
import { expect } from "chai";
import { Wallet, hexlify, randomBytes, parseEther } from "ethers";
import { USDC } from "../../helpers";
import { settledEvents, spawnFacilitator, startChaosProxy, tempState } from "../../helpers/chaos";
import type { ChaosProxy, Spawned, Temp } from "../../helpers/chaos";
import { makePayment, requirementsFor, verifyBody } from "../../helpers/payments";
import { depositFor, freshChain, fundWallet, setQie, startStack, throwawayWallet } from "../../helpers/stack";
import type { Stack } from "../../helpers/stack";

type Status = { status: string; transaction?: string; reason?: string };

describe("Facilitator crash recovery: the process is killed mid-batch", function () {
  this.timeout(300_000);
  let s: Stack;
  let t: Temp;
  let proxy: ChaosProxy;
  let payer: Wallet;
  let builder: string;
  let relayerKey: string;
  let relayerAddress: string;
  const running: Spawned[] = [];
  const price = USDC("0.01");

  beforeEach(async () => {
    await freshChain(); // the processes read the wall clock, so the chain's clock must be the wall clock too
    s = await startStack({ feeBps: 100 });
    t = tempState();
    proxy = await startChaosProxy(s.rpcUrl);
    payer = throwawayWallet();
    builder = throwawayWallet().address;
    relayerKey = hexlify(randomBytes(32));
    relayerAddress = new Wallet(relayerKey).address;
    await setQie(relayerAddress, parseEther("1"));
    await fundWallet(s, payer, USDC("5"), parseEther("1"));
    await depositFor(s, payer, USDC("5"));
  });
  afterEach(async () => {
    for (const p of running.splice(0)) {
      p.child.kill("SIGKILL");
      await p.exited;
    }
    await proxy.close();
    await s.stop();
    t.cleanup();
  });

  const start = async (flushMs = "500"): Promise<Spawned> => {
    const p = await spawnFacilitator({
      SLUICE_NETWORK: "local",
      SLUICE_RPC_URL: proxy.url,
      SLUICE_ROUTER: s.routerAddress,
      SLUICE_RELAYER_KEY: relayerKey,
      SLUICE_FACILITATOR_PORT: "0",
      SLUICE_FACILITATOR_STATE: t.journal,
      SLUICE_FACILITATOR_FLUSH_MS: flushMs,
    });
    running.push(p);
    return p;
  };
  const post = async (p: Spawned, path: string, body: unknown) => (await fetch(`http://127.0.0.1:${p.port}${path}`, { method: "POST", body: JSON.stringify(body) })).json() as Promise<Record<string, unknown>>;
  const status = async (p: Spawned, id: string) => (await (await fetch(`http://127.0.0.1:${p.port}/status/${id}`)).json()) as Status;
  const payments = async (n: number) => {
    const made = [];
    for (let i = 0; i < n; i++) made.push(await makePayment(s, payer, payer.address, requirementsFor(s, builder, price)));
    return made;
  };
  const waitFor = async (what: string, test: () => boolean | Promise<boolean>, ms = 60_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await test()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  const journal = () => readFileSync(t.journal, "utf8");
  const settledOnChain = async () => (await settledEvents(s.router, payer.address)).length;
  const paidOnce = async (n: bigint) => expect(await s.router.earnings(builder)).to.equal((price - price / 100n) * n);

  it("killed after the node has the transaction and before the process knows its hash: the next process finds it settled and sends nothing", async () => {
    proxy.mode = "hold-after-send";
    // The payments are made first and posted together, so that all three are queued before the process's first flush (it flushes every
    // 500 ms from when it starts). Posting them one at a time, as this test used to, let a flush fall between two of them on a slow
    // machine, and the batch then held two payments.
    // The first process flushes every 2 s instead of 500 ms: three posts that each check the chain can take longer than half a second when
    // the machine is busy (a full run of this suite), and a flush between two of them sent a batch of two.
    const made = await payments(3);
    const a = await start("2000");
    await Promise.all(made.map(async (m) => expect((await post(a, "/settle", verifyBody(m))).success).to.equal(true)));
    await proxy.sendSeen; // the node has the batch and the process has not been told
    await a.kill();
    expect(await settledOnChain()).to.equal(3); // it did settle on the chain
    expect(journal()).to.contain('"status":"submitted"'); // and the journal still says it was in flight
    expect(journal()).to.not.contain('"transaction":"0x'); // with no hash: the crash came first
    await paidOnce(3n);

    proxy.mode = "pass";
    const b = await start();
    for (const m of made) {
      const st = await status(b, m.digest);
      expect(st.status, "recovered from the chain").to.equal("settled");
      expect(st.transaction).to.match(/^0x[0-9a-f]{64}$/);
    }
    // It was not sent a second time: still three events, one transaction from the relayer, paid once.
    await new Promise((r) => setTimeout(r, 1500)); // a few flush ticks
    expect(await settledOnChain()).to.equal(3);
    expect(await s.provider.getTransactionCount(relayerAddress)).to.equal(1);
    await paidOnce(3n);
    // Sending an intent again is the same record.
    const again = await post(b, "/settle", verifyBody(made[0]!));
    expect(again.success).to.equal(true);
    expect((again.extensions as { sluice: { status: string } }).sluice.status).to.equal("settled");
  });

  it("killed before the node ever saw the transaction: the next process sends the batch, once", async () => {
    proxy.mode = "drop-send";
    const a = await start();
    const made = await payments(2);
    for (const m of made) await post(a, "/settle", verifyBody(m));
    await proxy.sendSeen; // the process wrote the batch down and tried to send it
    await a.kill();
    expect(await settledOnChain()).to.equal(0);
    expect(journal()).to.contain('"status":"submitted"');
    await paidOnce(0n);

    proxy.mode = "pass";
    const b = await start();
    await waitFor("the batch to settle", async () => (await status(b, made[0]!.digest)).status === "settled" && (await status(b, made[1]!.digest)).status === "settled");
    expect(await settledOnChain()).to.equal(2);
    expect(await s.provider.getTransactionCount(relayerAddress)).to.equal(1);
    await paidOnce(2n);
  });

  it("killed after the hash was written down and before the receipt: the next process reads the receipt and sends nothing", async () => {
    proxy.mode = "hold-receipts";
    const a = await start();
    const made = await payments(2);
    for (const m of made) await post(a, "/settle", verifyBody(m));
    await proxy.receiptHeld; // the transaction was sent, its hash is known, and the receipt never arrives
    // The hash must be on the batch's `submitted` line, written when the node took the transaction. (A process that is left running would
    // find the settled intent from the chain's events after its request limit, so the wait is short and looks only at `submitted`.)
    await waitFor("the hash on a submitted line of the journal", () => journal().split("\n").some((l) => l.includes('"status":"submitted"') && l.includes('"transaction":"0x')), 12_000);
    await a.kill();
    expect(await settledOnChain()).to.equal(2);
    expect(journal()).to.contain('"status":"submitted"');

    proxy.mode = "pass";
    const b = await start();
    const first = await status(b, made[0]!.digest);
    expect(first.status).to.equal("settled");
    const hashInJournal = /"transaction":"(0x[0-9a-f]{64})"/.exec(journal())?.[1];
    expect(first.transaction).to.equal(hashInJournal); // the hash that was written down before the crash
    expect(await s.provider.getTransactionCount(relayerAddress)).to.equal(1);
    await paidOnce(2n);
  });

  it("is killed again while it recovers, and the third process still ends with each intent settled once", async () => {
    proxy.mode = "hold-after-send";
    const a = await start();
    const made = await payments(2);
    for (const m of made) await post(a, "/settle", verifyBody(m));
    await proxy.sendSeen;
    await a.kill();
    proxy.mode = "pass";
    const b = await start();
    await b.kill(); // gone again straight after it started
    const c = await start();
    for (const m of made) expect((await status(c, m.digest)).status).to.equal("settled");
    expect(await settledOnChain()).to.equal(2);
    expect(await s.provider.getTransactionCount(relayerAddress)).to.equal(1);
    await paidOnce(2n);
  });

  it("refuses to start from a journal that was damaged in the middle, and settles nothing from it", async () => {
    const a = await start();
    const [m] = await payments(1);
    await post(a, "/settle", verifyBody(m!));
    await a.kill();
    const lines = journal().split("\n");
    lines.unshift("{ this is not a record");
    writeFileSync(t.journal, lines.join("\n"));
    let error = "";
    try {
      await start();
    } catch (e) {
      error = (e as Error).message;
    }
    expect(error).to.match(/queue store is damaged/);
    expect(error).to.not.contain(t.dir); // no path in what it prints
    expect(await settledOnChain()).to.equal(0);
  });
});

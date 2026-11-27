// A tool call must not be answered and left unpaid because one attempt to settle it failed. The two serverless functions run here on a
// local chain, with a stand-in for their database, and one drain is made to fail in each way it can. Whatever the tool server answered,
// then and when the same payment is sent again, an answer with the tool's content has to have its Settled event on the chain, also after
// the five minutes a payment lives, when a sweeper that comes late has run. A control with the order the tool server used before, queue
// and answer, shows that these checks see a call that was served and never paid. Every key and secret was made for the run.
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";
import { parseEther } from "ethers";
import type { Provider, Wallet } from "ethers";
import { network } from "hardhat";
import { RedisLedger, redisPrefix } from "@sluice/facilitator";
import type { Caps } from "@sluice/facilitator";
import { ERRORS, PAYMENT_META_KEY, toolIdOf } from "@sluice/sdk";
import { PaymentProxy, connectUpstream, parseConfig } from "@sluice/proxy";
import { LOCK_TTL_MS, createServerlessFacilitator } from "../../../packages/facilitator/src/vercel";
import { createServerlessTools } from "../../../examples/paid-tools/src/vercel";
import { createToolApp, readToolServerEnv, rpcFromProvider } from "../../../examples/paid-tools/src";
import type { Rpc } from "../../../examples/paid-tools/src";
import { USDC } from "../../helpers";
import { fakeExplorer } from "../../helpers/explorer";
import { FakeRedis } from "../../helpers/fake-redis";
import { makePayment, requirementsFor, verifyBody } from "../../helpers/payments";
import type { Made } from "../../helpers/payments";
import { depositFor, freshChain, fundWallet, setQie, startStack, throwawayWallet } from "../../helpers/stack";
import type { Stack } from "../../helpers/stack";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const PRICE = USDC("0.005");
type Answer = { result: { isError?: boolean; content: Array<{ text: string }>; structuredContent?: { error?: string } } };
const served = (a: Answer) => a.result.isError !== true;
const codeOf = (a: Answer) => a.result.structuredContent?.error;

/** How one drain fails. */
type Fault = "the node refuses the transaction" | "the node cannot be reached to estimate it" | "the function dies while sending it" | "the chain confirms it late" | "the wait for its receipt fails";

describe("Hosted tool calls: none served and left unpaid", function () {
  this.timeout(240_000);
  let s: Stack;
  let facilitatorDb: FakeRedis;
  let toolsDb: FakeRedis;
  let relayer: Wallet;
  let payer: Wallet;
  let builder: string;
  let background: Array<Promise<unknown>>;
  let runs: number;
  let databaseAhead: number;
  let fault: Fault | undefined;
  const secret = randomBytes(24).toString("hex");
  const closers: Array<() => void | Promise<void>> = [];

  beforeEach(async () => {
    await freshChain();
    s = await startStack({ feeBps: 100 });
    databaseAhead = 0;
    facilitatorDb = new FakeRedis(() => Date.now() + databaseAhead);
    toolsDb = new FakeRedis();
    relayer = throwawayWallet();
    payer = throwawayWallet();
    builder = throwawayWallet().address;
    background = [];
    runs = 0;
    fault = undefined;
    await setQie(relayer.address, parseEther("1"));
    await fundWallet(s, payer, USDC("5"), parseEther("1"));
    await depositFor(s, payer, USDC("5"));
  });
  afterEach(async () => {
    await network.provider.send("evm_setAutomine", [true]);
    for (const close of closers.splice(0)) await close();
    await s.stop();
  });

  /** The node, which fails once in the way `fault` names. */
  const node = (): Provider =>
    new Proxy(s.provider, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (typeof value !== "function") return value;
        const call = (value as (...a: unknown[]) => unknown).bind(target);
        return (...args: unknown[]) => {
          if (prop === "broadcastTransaction" && fault === "the node refuses the transaction") {
            fault = undefined;
            return Promise.reject(new Error("the node refused it"));
          }
          if (prop === "broadcastTransaction" && fault === "the function dies while sending it") {
            fault = undefined;
            return new Promise(() => undefined); // never sent, never heard from again
          }
          if (prop === "broadcastTransaction" && fault === "the wait for its receipt fails") {
            fault = undefined;
            return (call(...args) as Promise<{ hash: string }>).then((tx) => ({ hash: tx.hash, wait: () => Promise.reject(new Error("no receipt yet")) }));
          }
          if (prop === "estimateGas" && fault === "the node cannot be reached to estimate it") {
            fault = undefined;
            return Promise.reject(Object.assign(new Error("network"), { code: "NETWORK_ERROR" }));
          }
          return call(...args);
        };
      },
    }) as Provider;

  const serve = async (listener: (req: IncomingMessage, res: ServerResponse) => Promise<void>) => {
    const server = createServer((req, res) => void listener(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  };
  const common = () => ({
    SLUICE_NETWORK: "local",
    SLUICE_RPC_URL: s.rpcUrl,
    SLUICE_ROUTER: s.routerAddress,
    SLUICE_REDIS_REST_URL: "https://database.invalid",
    SLUICE_REDIS_REST_TOKEN: "t".repeat(40),
  });
  /** One copy of the facilitator function. `ahead` seconds puts its clock past the chain's. */
  const facilitator = async (ahead = 0, caps?: Partial<Caps>) => {
    const app = await createServerlessFacilitator({
      env: { ...common(), SLUICE_RELAYER_KEY: relayer.privateKey, SLUICE_FACILITATOR_SWEEP_SECRET: secret, ...(caps?.payerDailyAmount ? { SLUICE_FACILITATOR_PAYER_DAILY_QUSDC: "0.008" } : {}) },
      client: facilitatorDb,
      provider: node(),
      now: () => s.clock() + ahead,
      write: () => undefined,
      waitUntil: (work) => void background.push(work),
      captureWaitMs: 1_500,
    });
    return { app, url: await serve(app.listener) };
  };
  const rpc = (failing: { times: number } = { times: 0 }, during?: () => Promise<void>): Rpc => {
    const real = rpcFromProvider(s.provider);
    return {
      ...real,
      getCode: async (address) => {
        runs += 1;
        if (failing.times > 0) {
          failing.times -= 1;
          throw new Error("the node did not answer the tool");
        }
        await during?.();
        return real.getCode(address);
      },
    };
  };
  /** The hosted tool server, as Vercel runs it. */
  const tools = async (facilitatorUrl: string, use: Rpc = rpc()) => {
    const app = await createServerlessTools({ env: { ...common(), SLUICE_PAYEE: builder, SLUICE_FACILITATOR_URL: facilitatorUrl }, client: toolsDb, rpc: use, explorer: fakeExplorer(s.provider) });
    closers.push(() => app.destroy());
    return serve(app.listener);
  };
  /** The same server in the order it had before: queue, then answer. */
  const toolsThatQueue = async (facilitatorUrl: string) => {
    const app = await createToolApp({ env: readToolServerEnv({ ...common(), SLUICE_PAYEE: builder, SLUICE_FACILITATOR_URL: facilitatorUrl }), rpc: rpc(), explorer: fakeExplorer(s.provider) });
    closers.push(() => app.destroy());
    return serve(app.listener);
  };

  const lookup = (ahead = 0) => makePayment(s, payer, payer.address, requirementsFor(s, builder, PRICE, "contract_lookup"), { deadline: BigInt(s.clock() + ahead + 300) });
  const call = async (url: string, m: Made) => {
    const res = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "contract_lookup", arguments: { address: s.tokenAddress }, _meta: { [PAYMENT_META_KEY]: m.payload } } }),
    });
    return (await res.json()) as Answer;
  };
  const sweep = (url: string) => fetch(`${url}/internal/drain`, { method: "POST", headers: { authorization: `Bearer ${secret}` } }).then((r) => r.json() as Promise<Record<string, unknown>>);
  const paid = async (m: Made) => (await s.router.queryFilter(s.router.filters.Settled!())).filter((e) => String((e as unknown as { args: { nonce: string } }).args.nonce).toLowerCase() === m.intent.nonce.toLowerCase()).length;
  const ledger = () => new RedisLedger(facilitatorDb, redisPrefix("local", s.routerAddress));
  const statusOf = async (m: Made) => (await ledger().get(m.digest))?.status;
  /** What must never be: an answer with the tool's content, and no payment on the chain. */
  const servedUnpaid = async (answers: Answer[], m: Made) => answers.some(served) && (await paid(m)) === 0;

  /** A sweeper that comes after the payment has died: past its five minutes, and past any lock a dead function left. */
  const lateSweeps = async () => {
    databaseAhead = LOCK_TTL_MS + 1_000;
    const copy = await facilitator(600);
    await sweep(copy.url);
    await sweep(copy.url);
  };

  const faults: Fault[] = ["the node refuses the transaction", "the node cannot be reached to estimate it", "the function dies while sending it", "the chain confirms it late"];

  for (const which of faults) {
    it(`one drain fails (${which}), the sweeper comes too late: no answer without its payment`, async () => {
      const f = await facilitator();
      const url = await tools(f.url);
      const m = await lookup();
      if (which === "the chain confirms it late") await network.provider.send("evm_setAutomine", [false]);
      else fault = which;
      const first = await call(url, m);
      expect(fault, "the failure happened").to.equal(undefined);
      expect(served(first), "the first answer is held back").to.equal(false);
      expect(await servedUnpaid([first], m)).to.equal(false);
      await network.provider.send("evm_setAutomine", [true]);
      await network.provider.send("evm_mine", []);
      await lateSweeps();
      const again = await call(url, m);
      expect(await servedUnpaid([first, again], m)).to.equal(false);
      // The payer pays for exactly what they can have: if it settled, the same payment fetches the answer; if not, nothing was taken.
      expect(served(again)).to.equal((await paid(m)) === 1);
      expect(await paid(m)).to.be.at.most(1);
      expect(runs, "the tool is not run a second time for the same payment").to.equal(1);
      if (which === "the chain confirms it late") {
        expect(codeOf(first)).to.equal(ERRORS.paymentPending);
        expect(served(again)).to.equal(true);
      } else if (which !== "the function dies while sending it") {
        expect(codeOf(first), "it was marked as never to be sent").to.equal(ERRORS.paymentNotTaken);
        expect(await statusOf(m)).to.equal("failed");
        expect(await paid(m)).to.equal(0);
      }
    });

    it(`one drain fails (${which}), the sweeper comes in time: no answer without its payment`, async () => {
      const f = await facilitator();
      const url = await tools(f.url);
      const m = await lookup();
      if (which === "the chain confirms it late") await network.provider.send("evm_setAutomine", [false]);
      else fault = which;
      const first = await call(url, m);
      expect(await servedUnpaid([first], m)).to.equal(false);
      await network.provider.send("evm_setAutomine", [true]);
      await network.provider.send("evm_mine", []);
      databaseAhead = LOCK_TTL_MS + 1_000;
      await sweep((await facilitator()).url);
      const again = await call(url, m);
      expect(await servedUnpaid([first, again], m)).to.equal(false);
      expect(served(again)).to.equal((await paid(m)) === 1);
      // A payment that was sent, or might have been, is finished by the sweep; one marked as never to be sent stays so.
      expect(await paid(m)).to.equal(which === "the function dies while sending it" || which === "the chain confirms it late" ? 1 : 0);
    });
  }

  it("control: a server that queues and answers is left with a served call and no payment after one failed drain", async () => {
    const f = await facilitator();
    const url = await toolsThatQueue(f.url);
    const m = await lookup();
    fault = "the node refuses the transaction";
    const first = await call(url, m);
    await Promise.all(background);
    expect(served(first)).to.equal(true);
    await lateSweeps();
    expect(await statusOf(m)).to.equal("expired");
    expect(await servedUnpaid([first], m), "this is what the hosted order prevents").to.equal(true);
  });

  it("never marks as not to be sent a payment that was sent and is not yet confirmed, though no one holds the relayer", async () => {
    const f = await facilitator();
    const url = await tools(f.url);
    const m = await lookup();
    await network.provider.send("evm_setAutomine", [false]);
    fault = "the wait for its receipt fails"; // the send gives up waiting and lets the relayer go, with the transaction still waiting
    const first = await call(url, m);
    expect(codeOf(first)).to.equal(ERRORS.paymentPending);
    expect(await statusOf(m)).to.equal("submitted");
    expect(await ledger().lock("relayer", 1_000), "the relayer is free").to.not.equal(undefined);
    databaseAhead = LOCK_TTL_MS + 1_000; // let go of the lock this check took
    await network.provider.send("evm_setAutomine", [true]);
    await network.provider.send("evm_mine", []);
    const again = await call(url, m);
    expect(served(again)).to.equal(true);
    expect(await paid(m)).to.equal(1);
    expect(runs).to.equal(1);
  });

  it("runs nothing unless the facilitator says that it holds the payment", async () => {
    const f = await facilitator(0, { payerDailyAmount: 8_000n });
    const url = await tools(f.url);
    facilitatorDb.down = true;
    const down = await call(url, await lookup());
    expect(served(down)).to.equal(false);
    facilitatorDb.down = false;
    // A facilitator that offers no hold: nothing is run for it.
    const without = await call(await tools(s.facilitatorUrl), await lookup());
    expect(without.result.content[0]?.text).to.contain(ERRORS.facilitatorUnavailable);
    expect(runs).to.equal(0);
    expect(served(await call(url, await lookup()))).to.equal(true);
    const capped = await call(url, await lookup()); // the payer's daily cap holds a held payment like a queued one
    expect(capped.result.content[0]?.text).to.contain(ERRORS.capPayerDaily);
    expect(runs).to.equal(1);
  });

  it("charges nothing for a call that fails, and lets the same payment pay for the next good one", async () => {
    const f = await facilitator();
    const url = await tools(f.url, rpc({ times: 1 }));
    const m = await lookup();
    expect(served(await call(url, m))).to.equal(false);
    expect(await statusOf(m)).to.equal("held");
    await sweep(f.url);
    expect(await paid(m), "a held payment is sent by nothing").to.equal(0);
    expect(served(await call(url, m))).to.equal(true);
    expect(served(await call(url, m)), "and the answer is given again").to.equal(true);
    expect(await paid(m)).to.equal(1);
    expect(runs).to.equal(2);
  });

  it("gives a held payment to whoever has its token, once, and to nobody else", async () => {
    const f = await facilitator();
    const post = async (path: string, body: unknown) => (await (await fetch(`${f.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as { success?: boolean; isValid?: boolean; errorReason?: string; invalidReason?: string; extensions?: { sluice: { id: string; status: string; hold?: string } } };
    const m = await lookup();
    const held = await post("/hold", verifyBody(m));
    expect(held.extensions?.sluice).to.include({ id: m.digest, status: "held" });
    const token = held.extensions!.sluice.hold!;
    expect(token).to.match(/^0x[0-9a-f]{64}$/);
    expect(JSON.stringify(await ledger().get(m.digest)), "the token is not stored").to.not.contain(token);
    expect(await post("/settle", verifyBody(m))).to.include({ success: false, errorReason: ERRORS.intentReplayed });
    expect(await post("/hold", verifyBody(m))).to.include({ success: false, errorReason: ERRORS.intentReplayed });
    expect(await post("/verify", verifyBody(m))).to.include({ isValid: false, invalidReason: ERRORS.intentReplayed });
    expect(await post("/capture", { id: m.digest, token: `0x${"11".repeat(32)}` })).to.include({ success: false, errorReason: ERRORS.intentReplayed });
    expect(await post("/capture", { id: m.digest })).to.include({ success: false, errorReason: ERRORS.invalidPayload });
    expect(await post("/capture", { id: `0x${"22".repeat(32)}`, token })).to.include({ success: false, errorReason: ERRORS.notFound });
    await sweep(f.url);
    expect(await paid(m)).to.equal(0);
    const taken = await post("/capture", { id: m.digest, token });
    expect(taken.success).to.equal(true);
    expect(taken.extensions?.sluice).to.include({ status: "settled" });
    expect(taken.extensions?.sluice.hold, "the token is given once").to.equal(undefined);
    expect((await post("/capture", { id: m.digest, token })).success).to.equal(true);
    expect(await paid(m)).to.equal(1);
    // A queued payment, which has no token, cannot be captured.
    const queued = await lookup();
    await post("/settle", verifyBody(queued));
    expect(await post("/capture", { id: queued.digest, token })).to.include({ success: false, errorReason: ERRORS.intentReplayed });
    await Promise.all(background);
  });

  it("counts a held payment against its payer until it dies, and takes nothing for it afterwards", async () => {
    const f = await facilitator();
    const poor = throwawayWallet();
    await fundWallet(s, poor, PRICE, parseEther("1"));
    await depositFor(s, poor, PRICE);
    const pay = (ahead = 0) => makePayment(s, poor, poor.address, requirementsFor(s, builder, PRICE, "contract_lookup"), { deadline: BigInt(s.clock() + ahead + 300) });
    const first = await pay();
    const held = await f.app.facilitator.hold(verifyBody(first));
    expect(held.success).to.equal(true);
    expect(await f.app.facilitator.settle(verifyBody(await pay()))).to.include({ success: false, errorReason: ERRORS.insufficientFunds });
    const later = await facilitator(600);
    await sweep(later.url);
    expect(await statusOf(first)).to.equal("expired");
    expect(await later.app.facilitator.capture({ id: first.digest, token: held.extensions!.sluice!.hold })).to.include({ success: false, errorReason: ERRORS.paymentNotTaken });
    expect((await later.app.facilitator.hold(verifyBody(await pay(600)))).success, "the balance counts again").to.equal(true);
    // One that is past its deadline and not yet swept is not released either.
    const stale = await lookup();
    const heldStale = await f.app.facilitator.hold(verifyBody(stale));
    expect(await later.app.facilitator.capture({ id: stale.digest, token: heldStale.extensions!.sluice!.hold })).to.include({ success: false, errorReason: ERRORS.expired });
    expect(await paid(first)).to.equal(0);
    expect(await paid(stale)).to.equal(0);
  });

  it("takes nothing, and gives no answer, when the switch is turned on between the run and the capture", async () => {
    const f = await facilitator();
    const url = await tools(f.url, rpc({ times: 0 }, async () => void (await facilitatorDb.command(["SET", ledger().killSwitchKey, "1"]))));
    const m = await lookup();
    const first = await call(url, m);
    expect(served(first)).to.equal(false);
    expect(first.result.content[0]?.text).to.contain(ERRORS.killSwitch);
    expect(await statusOf(m)).to.equal("held");
    await facilitatorDb.command(["DEL", ledger().killSwitchKey]);
    expect(served(await call(url, m)), "sent again with the switch off, it is paid and answered").to.equal(true);
    expect(await paid(m)).to.equal(1);
    expect(runs).to.equal(1);
  });

  it("lets a proxy send the same payment again until the chain has it, and pays once", async () => {
    const f = await facilitator();
    const url = await tools(f.url);
    const agent = throwawayWallet();
    await (
      await (s.vault.connect(payer.connect(s.provider)) as unknown as { authorize: (g: unknown, t: unknown) => Promise<{ wait: () => Promise<unknown> }> }).authorize(
        { agent: agent.address, budget: USDC("0.5"), perCallCap: USDC("0.05"), expiry: BigInt(s.clock() + 86_400) },
        [{ payee: builder, toolId: toolIdOf("contract_lookup") }],
      )
    ).wait();
    const dir = mkdtempSync(join(tmpdir(), "sluice-unpaid-"));
    closers.push(() => rmSync(dir, { recursive: true, force: true }));
    const config = parseConfig(
      { upstream: { url: `${url}/mcp` }, router: s.routerAddress, asset: s.tokenAddress, payer: payer.address, budget: { perCallCap: "0.05", totalCap: "1.00", expiresAt: new Date((s.clock() + 3_600) * 1000).toISOString(), allowedTools: [{ tool: "contract_lookup", payee: builder }] }, logFile: "log.jsonl", stateFile: "state.json" },
      s.clock(),
      dir,
    );
    const upstream = await connectUpstream(config.upstream);
    closers.push(() => upstream.close());
    const proxy = new PaymentProxy({ config, signer: agent, upstream: upstream as never, now: s.clock, resendDelayMs: 700 });
    await network.provider.send("evm_setAutomine", [false]);
    const mined = (async () => {
      await pause(2_500);
      await network.provider.send("evm_setAutomine", [true]);
      await network.provider.send("evm_mine", []);
    })();
    const result = await proxy.callTool({ name: "contract_lookup", arguments: { address: s.tokenAddress } });
    await mined;
    expect(result.isError, JSON.stringify(result.structuredContent)).to.not.equal(true);
    expect(proxy.policy.payments, "one payment was signed").to.equal(1);
    expect(proxy.policy.spentUnits).to.equal(PRICE);
    expect((await s.router.queryFilter(s.router.filters.Settled!())).length).to.equal(1);
    expect(runs).to.equal(1);
  });
});

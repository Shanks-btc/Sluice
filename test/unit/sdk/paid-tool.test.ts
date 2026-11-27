// paidTool on a real MCP server (Streamable HTTP) with a real MCP client, a real facilitator and the real router on a
// local chain. No payment travels anywhere but this machine.
import { expect } from "chai";
import { Wallet, parseEther } from "ethers";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import {
  ERRORS,
  FacilitatorClient,
  FacilitatorUnavailable,
  NameResolutionError,
  PAYMENT_META_KEY,
  PAYMENT_RESPONSE_META_KEY,
  PRICING_META_KEY,
  MemoryIdempotencyStore,
  createPaywall,
  parsePaymentRequired,
  serveMcpHttp,
  settlementOf,
  toolIdOf,
} from "@sluice/sdk";
import type { FacilitatorApi, IdempotencyStore, PaywallEvent } from "@sluice/sdk";
import { USDC } from "../../helpers";
import { rejection } from "../../helpers/assert";
import { makePayment, requirementsFor } from "../../helpers/payments";
import { depositFor, fundWallet, startStack, throwawayWallet } from "../../helpers/stack";
import type { Stack } from "../../helpers/stack";

type Result = { isError?: boolean; content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; _meta?: Record<string, unknown> };

describe("paidTool: an MCP server that charges per call", function () {
  let s: Stack;
  let payer: Wallet;
  let builder: Wallet;
  let down = false;
  let breakSettle = false;
  let settleVerdict: { success: boolean; errorReason?: string; transaction: string; network: string } | undefined;
  let runs: Record<string, number>;
  let events: PaywallEvent[];
  let close: () => Promise<void>;
  let url: string;
  let client: Client;

  /** A facilitator that can be made unreachable, to test what a tool server does then. */
  const flaky = (inner: FacilitatorApi): FacilitatorApi => ({
    verify: async (p, r) => {
      if (down) throw new FacilitatorUnavailable("down");
      return inner.verify(p, r);
    },
    settle: async (p, r) => {
      if (down || breakSettle) throw new FacilitatorUnavailable("down");
      if (settleVerdict) return settleVerdict;
      return inner.settle(p, r);
    },
  });

  before(async () => {
    s = await startStack({ feeBps: 100 });
    payer = throwawayWallet();
    builder = throwawayWallet();
    await fundWallet(s, payer, USDC("20"), parseEther("1"));
    await depositFor(s, payer, USDC("20"));
    runs = {};
    events = [];
    const paywall = createPaywall({
      facilitator: flaky(new FacilitatorClient({ url: s.facilitatorUrl })),
      router: s.routerAddress,
      vault: s.vaultAddress,
      asset: s.tokenAddress,
      now: s.clock,
      onEvent: (e) => events.push(e),
    });
    const build = async () => {
      const server = new McpServer({ name: "paid-test", version: "0.0.1" });
      await paywall.registerPaidTool(
        server,
        { name: "echo", price: "0.01", payee: builder.address, description: "Echoes text.", inputSchema: { text: z.string() } },
        async (args: { text: string }, _extra, payment) => {
          runs.echo = (runs.echo ?? 0) + 1;
          return { content: [{ type: "text", text: `echo:${args.text}:${payment.payer}` }] };
        },
      );
      await paywall.registerPaidTool(
        server,
        { name: "flaky", price: "0.02", payee: builder.address, inputSchema: { fail: z.boolean() } },
        async (args: { fail: boolean }) => {
          runs.flaky = (runs.flaky ?? 0) + 1;
          if (args.fail) throw new Error("the upstream service is down");
          return { content: [{ type: "text", text: "ok" }] };
        },
      );
      await paywall.registerPaidTool(
        server,
        { name: "soft", price: "0.02", payee: builder.address, inputSchema: {} },
        async () => {
          runs.soft = (runs.soft ?? 0) + 1;
          return { isError: true, content: [{ type: "text", text: "the service said no" }] };
        },
      );
      server.registerTool("free", { description: "A free tool.", inputSchema: {} }, async () => ({ content: [{ type: "text", text: "free" }] }));
      return server;
    };
    const { server, port } = await serveMcpHttp(build);
    url = `http://127.0.0.1:${port}/mcp`;
    close = () => new Promise<void>((resolve) => server.close(() => resolve()));
    client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  });
  after(async () => {
    await client.close();
    await close();
    await s.stop();
  });
  beforeEach(() => {
    down = false;
    breakSettle = false;
    settleVerdict = undefined;
    runs = {};
    events.length = 0;
  });

  const call = (name: string, args: Record<string, unknown>, payment?: unknown) =>
    client.callTool({ name, arguments: args, ...(payment ? { _meta: { [PAYMENT_META_KEY]: payment } } : {}) }) as Promise<Result>;
  const echoRequirements = () => requirementsFor(s, builder.address, USDC("0.01"), "echo");
  const pay = (over = {}, signer: Wallet = payer, who = payer.address, req = echoRequirements()) => makePayment(s, signer, who, req, over);

  it("advertises its price in tools/list and leaves a free tool alone", async () => {
    const { tools } = await client.listTools();
    const echo = tools.find((t) => t.name === "echo")!;
    expect(echo._meta?.[PRICING_META_KEY]).to.deep.include({
      scheme: "sluice-intent", network: "eip155:1990", amount: "10000", price: "0.010000", payTo: builder.address, router: s.routerAddress,
    });
    expect(echo.description).to.contain("0.010000 QUSDC");
    expect(tools.find((t) => t.name === "free")!._meta?.[PRICING_META_KEY]).to.equal(undefined);
    expect((await call("free", {})).content[0]?.text).to.equal("free");
  });

  it("answers a call without payment with the requirements, in the x402 MCP wire format", async () => {
    const r = await call("echo", { text: "hi" });
    expect(r.isError).to.equal(true);
    expect(runs.echo).to.equal(undefined);
    const required = parsePaymentRequired(r)!;
    expect(required.x402Version).to.equal(2);
    expect(required.resource.url).to.equal("mcp://tool/echo");
    expect(required.accepts).to.have.length(1);
    const a = required.accepts[0]!;
    expect(a).to.deep.include({ scheme: "sluice-intent", network: "eip155:1990", amount: "10000", asset: s.tokenAddress, payTo: builder.address });
    expect(a.maxTimeoutSeconds).to.equal(300);
    expect(a.extra).to.deep.include({ name: "SluiceRouter", version: "1", router: s.routerAddress, toolId: toolIdOf("echo"), vault: s.vaultAddress });
    // structuredContent and content[0].text carry the same object, as the transport spec requires.
    expect(JSON.parse(r.content[0]!.text!)).to.deep.equal(r.structuredContent);
  });

  it("runs the tool for a valid payment, returns the settlement, and queues the payment with the facilitator", async () => {
    const m = await pay();
    const r = await call("echo", { text: "hi" }, m.payload);
    expect(r.isError).to.not.equal(true);
    expect(r.content[0]?.text).to.equal(`echo:hi:${payer.address}`);
    const settlement = settlementOf(r)!;
    expect(settlement).to.deep.include({ success: true, transaction: "", network: "eip155:1990", payer: payer.address });
    expect(settlement.extensions?.sluice).to.deep.include({ id: m.digest, status: "queued" });
    expect(r._meta?.[PAYMENT_RESPONSE_META_KEY]).to.deep.equal(settlement);
    expect(runs.echo).to.equal(1);

    const before = (await s.router.earnings(builder.address)) as bigint;
    await s.facilitator.flush();
    expect((await s.facilitator.status(m.digest))?.status).to.equal("settled");
    expect(((await s.router.earnings(builder.address)) as bigint) - before).to.equal(USDC("0.01") - USDC("0.01") / 100n);
  });

  it("never charges twice or runs a tool twice for the same intent, even when the calls are concurrent", async () => {
    const m = await pay();
    const [a, b, c] = await Promise.all([call("echo", { text: "x" }, m.payload), call("echo", { text: "x" }, m.payload), call("echo", { text: "x" }, m.payload)]);
    const again = await call("echo", { text: "x" }, m.payload);
    for (const r of [a, b, c, again]) {
      expect(r.isError).to.not.equal(true);
      expect(r.content[0]?.text).to.equal(`echo:x:${payer.address}`);
      expect(settlementOf(r)?.extensions?.sluice?.id).to.equal(m.digest);
    }
    expect(runs.echo, "the tool ran once").to.equal(1);
    expect(s.facilitator.store.size() >= 1).to.equal(true);
    await s.facilitator.flush();
    const status = (await s.facilitator.status(m.digest))!;
    expect(status.status).to.equal("settled");
    expect(events.filter((e) => e.type === "settled")).to.have.length(1);
  });

  it("refuses the same intent on a different call, without running the tool", async () => {
    const m = await pay();
    expect((await call("echo", { text: "first" }, m.payload)).isError).to.not.equal(true);
    const second = await call("echo", { text: "second" }, m.payload);
    expect(second.isError).to.equal(true);
    expect(parsePaymentRequired(second)?.error).to.equal(ERRORS.intentReplayed);
    expect(runs.echo).to.equal(1);
  });

  it("refuses a payment for a different tool's price: the same signed intent cannot be moved to another tool", async () => {
    const forEcho = await pay();
    const r = await call("flaky", { fail: false }, forEcho.payload);
    expect(r.isError).to.equal(true);
    expect(parsePaymentRequired(r)?.error).to.be.oneOf([ERRORS.acceptedMismatch, ERRORS.toolMismatch, ERRORS.amountTooLow]);
    expect(runs.flaky).to.equal(undefined);
  });

  describe("refuses, answering with the requirements and a reason, and does not run the tool", () => {
    const refused = async (m: Awaited<ReturnType<typeof pay>> | { payload: unknown }, reason: string) => {
      const r = await call("echo", { text: "x" }, m.payload);
      expect(r.isError).to.equal(true);
      expect(parsePaymentRequired(r)?.error).to.equal(reason);
      expect(runs.echo).to.equal(undefined);
    };
    it("wrong chain", async () => refused(await makePayment(s, payer, payer.address, echoRequirements(), {}, 1), ERRORS.sessionNotFound));
    it("a router other than the server's", async () => {
      const other = { ...echoRequirements(), extra: { ...echoRequirements().extra, router: throwawayWallet().address } };
      await refused(await makePayment(s, payer, payer.address, other), ERRORS.invalidRouter);
    });
    it("an expired intent", async () => refused(await pay({ deadline: BigInt(s.clock() - 1) }), ERRORS.expired));
    it("an amount below the price", async () => refused(await pay({ amount: USDC("0.0099") }), ERRORS.amountTooLow));
    it("a price the client rewrote in its copy of the terms", async () => {
      const m = await pay();
      const edited = { ...m.payload, accepted: { ...m.payload.accepted, amount: "1" } };
      await refused({ payload: edited }, ERRORS.acceptedMismatch);
    });
    it("a different payee", async () => refused(await pay({ payee: throwawayWallet().address }), ERRORS.payeeMismatch));
    it("a malformed payment", async () => refused({ payload: { x402Version: 2, nonsense: true } }, ERRORS.invalidPayload));
    it("a payer with no balance", async () => {
      const broke = throwawayWallet();
      await refused(await pay({}, broke, broke.address), ERRORS.insufficientFunds);
    });
    it("a key that holds no session for the payer", async () => refused(await pay({}, throwawayWallet(), payer.address), ERRORS.sessionNotFound));
  });

  it("does not charge for a tool that fails, and lets the same intent be used again once it works", async () => {
    const req = requirementsFor(s, builder.address, USDC("0.02"), "flaky");
    const m = await makePayment(s, payer, payer.address, req);
    const failed = await call("flaky", { fail: true }, m.payload);
    expect(failed.isError).to.equal(true);
    expect(settlementOf(failed)).to.equal(undefined);
    expect((await s.facilitator.status(m.digest))).to.equal(undefined); // nothing was queued
    // The intent was never used, so retrying with it (and arguments that work) succeeds and is charged once.
    const ok = await call("flaky", { fail: false }, m.payload);
    expect(ok.isError).to.not.equal(true);
    expect(settlementOf(ok)?.success).to.equal(true);
    expect(runs.flaky).to.equal(2);
    await s.facilitator.flush();
    expect((await s.facilitator.status(m.digest))?.status).to.equal("settled");
  });

  it("does not charge for a tool that returns an error result, and queues nothing", async () => {
    const m = await makePayment(s, payer, payer.address, requirementsFor(s, builder.address, USDC("0.02"), "soft"));
    const r = await call("soft", {}, m.payload);
    expect(r.isError).to.equal(true);
    expect(r.content[0]?.text).to.equal("the service said no");
    expect(settlementOf(r)).to.equal(undefined);
    expect((await s.facilitator.status(m.digest))).to.equal(undefined);
    expect(runs.soft).to.equal(1);
  });

  it("treats a settlement the facilitator declined as a failure: no tool content, and the payment-required form with its reason", async () => {
    settleVerdict = { success: false, errorReason: ERRORS.capPayerDaily, transaction: "", network: "eip155:1990" };
    const r = await call("echo", { text: "declined" }, (await pay()).payload);
    expect(r.isError).to.equal(true);
    expect(r.content[0]?.text).to.not.contain("echo:declined");
    expect(parsePaymentRequired(r)?.error).to.equal(ERRORS.capPayerDaily);
    expect(settlementOf(r)).to.equal(undefined);
  });

  it("reports an unreachable facilitator as an error, not as a request to pay again, and runs nothing", async () => {
    down = true;
    const r = await call("echo", { text: "x" }, (await pay()).payload);
    expect(r.isError).to.equal(true);
    expect(parsePaymentRequired(r)).to.equal(undefined);
    expect(r.structuredContent).to.deep.include({ error: ERRORS.facilitatorUnavailable });
    expect(runs.echo).to.equal(undefined);
  });

  it("does not return the tool's content when settlement cannot be requested, and settles on a retry without running the tool again", async () => {
    const m = await pay();
    breakSettle = true;
    const r = await call("echo", { text: "x" }, m.payload);
    expect(r.isError).to.equal(true);
    expect(r.content[0]?.text).to.not.contain("echo:x");
    expect(runs.echo).to.equal(1);
    breakSettle = false;
    const retry = await call("echo", { text: "x" }, m.payload);
    expect(retry.isError).to.not.equal(true);
    expect(retry.content[0]?.text).to.equal(`echo:x:${payer.address}`);
    expect(settlementOf(retry)?.extensions?.sluice?.id).to.equal(m.digest);
    expect(runs.echo, "the tool did not run a second time").to.equal(1);
  });

  describe("payees", () => {
    it("takes an address, and refuses a .qie name when no resolver is configured (and says why)", async () => {
      const server = new McpServer({ name: "x", version: "0" });
      const paywall = createPaywall({ facilitator: "http://127.0.0.1:1", router: s.routerAddress, asset: s.tokenAddress });
      const err = await rejection(paywall.registerPaidTool(server, { name: "named", price: "0.01", payee: "builder.qie" }, async () => ({ content: [] })));
      expect(err).to.be.instanceOf(NameResolutionError);
      expect(err.message).to.match(/no \.qie resolver is configured/);
      expect(err.message).to.match(/no documented on-chain QIE ID read/);
      const garbage = await rejection(paywall.registerPaidTool(server, { name: "bad", price: "0.01", payee: "not an address" }, async () => ({ content: [] })));
      expect(garbage).to.be.instanceOf(NameResolutionError);
    });

    it("resolves a .qie name through a supplied resolver and advertises the resolved address", async () => {
      const target = throwawayWallet().address;
      const server = new McpServer({ name: "x", version: "0" });
      const paywall = createPaywall({
        facilitator: "http://127.0.0.1:1", router: s.routerAddress, asset: s.tokenAddress,
        resolver: async (name) => (name === "builder.qie" ? target : null),
      });
      await paywall.registerPaidTool(server, { name: "named", price: "0.01", payee: "Builder.qie" }, async () => ({ content: [] }));
      const missing = await rejection(paywall.registerPaidTool(server, { name: "named2", price: "0.01", payee: "nobody.qie" }, async () => ({ content: [] })));
      expect(missing.message).to.match(/returned no address/);
    });

    it("rejects a price that is zero, negative or has too many decimals", () => {
      const paywall = createPaywall({ facilitator: "http://127.0.0.1:1", router: s.routerAddress });
      for (const price of ["0", "-1", "0.0000001", "abc", "", 0n]) {
        expect(() => paywall.requirementsFor({ name: "t", price, payee: builder.address }), String(price)).to.throw();
      }
    });
  });
});

describe("paidTool: concurrent calls against a slow idempotency store", function () {
  this.timeout(60_000);
  let s: Stack;
  const builder = throwawayWallet();
  const payer = throwawayWallet();

  before(async () => {
    s = await startStack();
  });
  after(async () => {
    await s.stop();
  });

  /** A store that takes a while to answer, as a database would, which is what opens the race a fast in-memory store hides. */
  const slowStore = (delayMs: number): IdempotencyStore => {
    const inner = new MemoryIdempotencyStore();
    return {
      get: async (id) => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return inner.get(id);
      },
      set: (id, entry) => inner.set(id, entry),
    };
  };
  const stub = (): FacilitatorApi => ({
    verify: async () => ({ isValid: true }),
    settle: async () => ({ success: true, transaction: "", network: "eip155:1990", extensions: { sluice: { id: "queued", status: "queued" } } }),
  });

  const setup = () => {
    let runs = 0;
    const paywall = createPaywall({ facilitator: stub(), router: s.routerAddress, asset: s.tokenAddress, now: s.clock, store: slowStore(40) });
    const tool = paywall.paidTool<{ text: string }>({ name: "echo", price: "0.01", payee: builder.address }, async (a) => {
      runs += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { content: [{ type: "text", text: `echo:${a.text}` }] };
    });
    return { tool, runs: () => runs };
  };
  const payment = async () => (await makePayment(s, payer, payer.address, requirementsFor(s, builder.address, USDC("0.01")))).payload;

  it("runs the tool once when calls with one intent and the same arguments arrive together", async () => {
    const { tool, runs } = setup();
    const meta = { _meta: { [PAYMENT_META_KEY]: await payment() } };
    const results = await Promise.all([1, 2, 3, 4].map(() => tool({ text: "same" }, meta)));
    expect(runs()).to.equal(1);
    for (const r of results) {
      expect(r.isError).to.not.equal(true);
      expect(r.content[0]?.text).to.equal("echo:same");
    }
  });

  it("refuses a call that arrives together with the first and uses the same intent for different arguments", async () => {
    const { tool, runs } = setup();
    const meta = { _meta: { [PAYMENT_META_KEY]: await payment() } };
    const [a, b] = await Promise.all([tool({ text: "one" }, meta), tool({ text: "two" }, meta)]);
    expect(runs(), "the tool ran for one of them only").to.equal(1);
    expect(a.isError).to.not.equal(true);
    expect(a.content[0]?.text).to.equal("echo:one");
    expect(b.isError).to.equal(true);
    expect(parsePaymentRequired(b)?.error).to.equal(ERRORS.intentReplayed);
  });

  // A server that answers only once a payment has settled, against facilitators that answer in every other way.
  type Answer = Awaited<ReturnType<NonNullable<FacilitatorApi["capture"]>>>;
  const said = (success: boolean, status?: string, over: Partial<Answer> = {}, token?: string): Answer => ({
    success,
    transaction: "",
    network: "eip155:1990",
    ...(status ? { extensions: { sluice: { id: "id", status, ...(token ? { hold: token } : {}) } } } : {}),
    ...over,
  });
  const holding = (hold: () => Promise<Answer>, capture: () => Promise<Answer>) => {
    let runs = 0;
    const facilitator: FacilitatorApi = { ...stub(), hold, capture };
    const paywall = createPaywall({ facilitator, router: s.routerAddress, asset: s.tokenAddress, now: s.clock, answerOnlyWhenSettled: true });
    const tool = paywall.paidTool<{ text: string }>({ name: "echo", price: "0.01", payee: builder.address }, async (a) => {
      runs += 1;
      return { content: [{ type: "text", text: `secret answer: ${a.text}` }] };
    });
    return { tool, runs: () => runs };
  };
  const held = async () => said(true, "held", {}, "token");

  it("runs nothing for a facilitator that does not say it holds the payment, with a token", async () => {
    const answers: Array<() => Promise<Answer>> = [
      async () => said(true, "queued", {}, "token"),
      async () => said(true, "held"),
      async () => said(false, "held", {}, "token"),
      async () => said(false, undefined, { errorReason: ERRORS.insufficientFunds }),
      async () => ({ error: "not_found" }) as unknown as Answer,
      async () => Promise.reject(new Error("unreachable")),
    ];
    for (const answer of answers) {
      const { tool, runs } = holding(answer, async () => said(true, "settled"));
      const out = await tool({ text: "x" }, { _meta: { [PAYMENT_META_KEY]: await payment() } });
      expect(out.isError, answer.toString()).to.equal(true);
      expect(runs(), answer.toString()).to.equal(0);
    }
  });

  it("gives the tool's answer for no capture but one that says the payment settled", async () => {
    const answers: Array<[() => Promise<Answer>, string]> = [
      [async () => said(true, "queued"), ERRORS.paymentPending],
      [async () => said(true), ERRORS.paymentPending],
      [async () => said(false, "submitted", { errorReason: ERRORS.paymentPending }), ERRORS.paymentPending],
      [async () => Promise.reject(new Error("timed out")), ERRORS.paymentPending],
      [async () => said(false, "failed", { errorReason: ERRORS.paymentNotTaken }), ERRORS.paymentNotTaken],
      [async () => ({ error: "not_found" }) as unknown as Answer, ERRORS.unexpectedSettle],
    ];
    for (const [answer, code] of answers) {
      const { tool } = holding(held, answer);
      const out = await tool({ text: "x" }, { _meta: { [PAYMENT_META_KEY]: await payment() } });
      expect(out.isError, answer.toString()).to.equal(true);
      expect(JSON.stringify(out), answer.toString()).to.not.contain("secret answer");
      expect(JSON.stringify(out), answer.toString()).to.contain(code);
    }
  });

  it("answers for a settled capture, once, and again without running or capturing", async () => {
    let captures = 0;
    const { tool, runs } = holding(held, async () => (captures++ === 0 ? said(false, "submitted", { errorReason: ERRORS.paymentPending }) : said(true, "settled")));
    const meta = { _meta: { [PAYMENT_META_KEY]: await payment() } };
    expect((await tool({ text: "a" }, meta)).isError).to.equal(true);
    expect((await tool({ text: "b" }, meta)).isError, "a payment that has an answer waiting pays for no other call").to.equal(true);
    const out = await tool({ text: "a" }, meta);
    expect(out.content[0]?.text).to.equal("secret answer: a");
    expect((await tool({ text: "a" }, meta)).content[0]?.text).to.equal("secret answer: a");
    expect([runs(), captures]).to.deep.equal([1, 2]);
  });

  it("captures nothing for a call that fails, whether the tool throws or answers with an error", async () => {
    for (const failing of [
      async () => ({ isError: true, content: [{ type: "text" as const, text: "no" }] }),
      async () => Promise.reject(new Error("broke")),
    ]) {
      let captures = 0;
      const facilitator: FacilitatorApi = { ...stub(), hold: held, capture: async () => ((captures += 1), said(true, "settled")) };
      const tool = createPaywall({ facilitator, router: s.routerAddress, asset: s.tokenAddress, now: s.clock, answerOnlyWhenSettled: true }).paidTool({ name: "echo", price: "0.01", payee: builder.address }, failing);
      expect((await tool({}, { _meta: { [PAYMENT_META_KEY]: await payment() } })).isError).to.equal(true);
      expect(captures).to.equal(0);
    }
  });

  it("cannot be built to answer only for settled payments with a facilitator that cannot hold one", () => {
    expect(() => createPaywall({ facilitator: stub(), router: s.routerAddress, asset: s.tokenAddress, answerOnlyWhenSettled: true })).to.throw(/hold and capture/);
  });
});

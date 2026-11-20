// The hosted tool server: what it reads from the environment and when it refuses to start, how it tells a paid call from an unpaid
// one, and the limits it puts on callers. The chain is the local Hardhat network served over HTTP; the facilitator is real; the keys
// were made for the run. Nothing leaves this machine.
import { createServer } from "node:http";
import type { Server } from "node:http";
import { expect } from "chai";
import { Wallet, parseEther } from "ethers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PAYMENT_META_KEY, PAYMENT_RESPONSE_META_KEY, createLogger } from "@sluice/sdk";
import {
  DEFAULT_PRICES, ToolServerEnvError, carriesPayment, createToolServer, describeRequest, parsePrices, readToolServerEnv, rpcFromProvider, withTimeout,
} from "../../../examples/paid-tools/src";
import type { ToolServer, ToolServerEnv } from "../../../examples/paid-tools/src";
import { USDC } from "../../helpers";
import { rejection } from "../../helpers/assert";
import { fakeExplorer } from "../../helpers/explorer";
import { makePayment, requirementsFor, verifyBody } from "../../helpers/payments";
import { depositFor, freshChain, fundWallet, startStack, throwawayWallet } from "../../helpers/stack";
import type { Stack } from "../../helpers/stack";

const ROUTER = `0x${"12".repeat(20)}`;
const PAYEE = `0x${"34".repeat(20)}`;
const base = {
  SLUICE_NETWORK: "local",
  SLUICE_ROUTER: ROUTER,
  SLUICE_PAYEE: PAYEE,
  SLUICE_FACILITATOR_URL: "http://127.0.0.1:8402",
  SLUICE_RPC_URL: "http://127.0.0.1:8545",
};

describe("Tool server settings", () => {
  it("refuses to start without a named network, and has no default for it", () => {
    const { SLUICE_NETWORK: _omitted, ...without } = base;
    expect(() => readToolServerEnv(without)).to.throw(ToolServerEnvError, /SLUICE_NETWORK/);
    expect(() => readToolServerEnv({ ...base, SLUICE_NETWORK: "" })).to.throw(/there is no default/);
    expect(() => readToolServerEnv({ ...base, SLUICE_NETWORK: "production" })).to.throw(/mainnet, testnet or local/);
  });

  it("refuses to start on mainnet without a router, and with a router that is not an address", () => {
    const mainnet = { ...base, SLUICE_NETWORK: "mainnet", SLUICE_RPC_URL: "https://rpc1mainnet.qie.digital/", SLUICE_FACILITATOR_URL: "https://facilitator.example.com" };
    expect(readToolServerEnv({ ...mainnet, SLUICE_ROUTER: ROUTER })).to.deep.include({ network: "mainnet", chainId: 1990 });
    const { SLUICE_ROUTER: _omitted, ...without } = mainnet;
    expect(() => readToolServerEnv(without)).to.throw(/refusing to start on mainnet: SLUICE_ROUTER/);
    expect(() => readToolServerEnv({ ...mainnet, SLUICE_ROUTER: "0x12" })).to.throw(/SLUICE_ROUTER/);
    expect(() => readToolServerEnv({ ...mainnet, SLUICE_ROUTER: "" })).to.throw(/SLUICE_ROUTER/);
  });

  it("uses QIE's public RPC for the network named, the testnet's chain id, and refuses plain http away from this machine", () => {
    const testnet = readToolServerEnv({ ...base, SLUICE_NETWORK: "testnet", SLUICE_RPC_URL: "", SLUICE_FACILITATOR_URL: "https://f.example.com" });
    expect(testnet).to.deep.include({ chainId: 1983, rpcUrl: "https://rpc1testnet.qie.digital/" });
    expect(() => readToolServerEnv({ ...base, SLUICE_RPC_URL: "http://rpc.example.com" })).to.throw(/https/);
    expect(() => readToolServerEnv({ ...base, SLUICE_FACILITATOR_URL: "http://facilitator.example.com" })).to.throw(/SLUICE_FACILITATOR_URL must be https/);
    expect(() => readToolServerEnv({ ...base, SLUICE_EXPLORER_URL: "http://explorer.example.com" })).to.throw(/SLUICE_EXPLORER_URL/);
    expect(() => readToolServerEnv({ ...base, SLUICE_RPC_URL: "https://rpc1mainnet.qie.digital/" })).to.throw(/local run needs/);
    expect(() => readToolServerEnv({ ...base, SLUICE_RPC_URL: "" })).to.throw(/SLUICE_RPC_URL/);
  });

  it("needs the payee and the facilitator", () => {
    expect(() => readToolServerEnv({ ...base, SLUICE_PAYEE: "" })).to.throw(/SLUICE_PAYEE/);
    expect(() => readToolServerEnv({ ...base, SLUICE_PAYEE: "builder.qie" })).to.throw(/SLUICE_PAYEE/);
    expect(() => readToolServerEnv({ ...base, SLUICE_FACILITATOR_URL: "" })).to.throw(/SLUICE_FACILITATOR_URL/);
  });

  it("has safe defaults: loopback only, a small body, unpaid calls rationed harder than any call", () => {
    const e = readToolServerEnv(base);
    expect(e).to.deep.include({ host: "127.0.0.1", port: 8403, maxBodyBytes: 32_768, ipPerMinute: 300, unpaidPerMinute: 60, trustedProxyHops: 0, rpcTimeoutMs: 10_000, logLevel: "info" });
    expect(e.prices).to.deep.equal({ ...DEFAULT_PRICES });
    expect(e.router).to.equal(ROUTER.replace(/^0x(.*)$/, (_m, h: string) => `0x${h}`) && e.router); // checksummed
  });

  it("reads the price table from the environment and refuses what it cannot read", () => {
    expect(parsePrices("token_risk_check=0.02, dex_quote=0.004")).to.deep.equal({ token_risk_check: "0.02", dex_quote: "0.004", contract_lookup: "0.005" });
    expect(readToolServerEnv({ ...base, SLUICE_TOOLS_PRICES: "contract_lookup=1" }).prices.contract_lookup).to.equal("1");
    for (const bad of ["nothing=1", "dex_quote", "dex_quote=", "dex_quote=0", "dex_quote=-1", "dex_quote=1.2345678", "dex_quote=abc", "dex_quote=1=2"]) {
      expect(() => parsePrices(bad), bad).to.throw(ToolServerEnvError);
    }
  });

  it("stops the start on a limit it cannot read, or an unpaid limit above the general one", () => {
    for (const bad of [
      { SLUICE_TOOLS_MAX_BODY_BYTES: "10" }, { SLUICE_TOOLS_MAX_BODY_BYTES: "99999999" }, { SLUICE_TOOLS_RATE_LIMIT_IP: "0" }, { SLUICE_TOOLS_RATE_LIMIT_UNPAID: "x" },
      { SLUICE_TOOLS_TRUST_PROXY_HOPS: "9" }, { SLUICE_TOOLS_RPC_TIMEOUT_MS: "5" }, { SLUICE_TOOLS_PORT: "70000" }, { SLUICE_TOOLS_HOST: "bad host!" }, { SLUICE_TOOLS_LOG_LEVEL: "loud" },
      { SLUICE_TOOLS_RATE_LIMIT_IP: "10", SLUICE_TOOLS_RATE_LIMIT_UNPAID: "20" },
    ]) {
      expect(() => readToolServerEnv({ ...base, ...bad }), JSON.stringify(bad)).to.throw(ToolServerEnvError);
    }
  });
});

describe("Telling a paid call from an unpaid one", () => {
  const call = (meta?: Record<string, unknown>) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "dex_quote", arguments: {}, ...(meta ? { _meta: meta } : {}) } });

  it("counts a tools/call that carries x402/payment as paid, and everything else as unpaid", () => {
    expect(carriesPayment(call({ [PAYMENT_META_KEY]: { x402Version: 2 } }))).to.equal(true);
    expect(carriesPayment(call())).to.equal(false);
    expect(carriesPayment(call({ other: 1 }))).to.equal(false);
    expect(carriesPayment(call({ [PAYMENT_META_KEY]: null }))).to.equal(false);
    expect(carriesPayment(call({ [PAYMENT_META_KEY]: "yes" }))).to.equal(false);
    expect(carriesPayment({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { [PAYMENT_META_KEY]: {} } } })).to.equal(false); // only a tool call can be paid
    expect(carriesPayment({ jsonrpc: "2.0", id: 1, method: "initialize" })).to.equal(false);
    expect(carriesPayment([call(), call({ [PAYMENT_META_KEY]: {} })])).to.equal(true);
    expect(carriesPayment(5)).to.equal(false);
    expect(carriesPayment(null)).to.equal(false);
  });

  it("describes a request by its method and tool name only", () => {
    expect(describeRequest(call({ [PAYMENT_META_KEY]: { signature: "0xsecret" } }))).to.deep.equal({ method: "tools/call", tool: "dex_quote" });
    expect(describeRequest({ method: "tools/list" })).to.deep.equal({ method: "tools/list" });
    expect(describeRequest({})).to.deep.equal({ method: "unknown" });
    expect(describeRequest([call()])).to.deep.equal({ method: "tools/call", tool: "dex_quote" });
  });
});

describe("A time limit on reads from the node", () => {
  it("rejects a read that does not answer in time, passes a quick one, and leaves no timer running", async () => {
    const slow = { call: () => new Promise<string>(() => undefined), getCode: () => new Promise<string>(() => undefined), getStorageAt: () => new Promise<string>(() => undefined) };
    const quick = { call: async () => "0x01", getCode: async () => "0x6001", getStorageAt: async () => "0x00" };
    const started = Date.now();
    const error = await rejection(withTimeout(slow, 150).getCode("0x00"));
    expect(error.message).to.match(/did not answer in time/);
    expect(Date.now() - started).to.be.within(100, 2_000);
    await rejection(withTimeout(slow, 50).call("0x00", "0x"));
    await rejection(withTimeout(slow, 50).getStorageAt("0x00", "0x0"));
    expect(await withTimeout(quick, 1_000).getCode("0x00")).to.equal("0x6001");
    expect(await withTimeout(quick, 1_000).call("0x00", "0x")).to.equal("0x01");
  });
});

describe("The hosted tool server", function () {
  this.timeout(180_000);
  let s: Stack;
  let tools: ToolServer;
  let url: string;
  let payer: Wallet;
  let builder: string;
  let lines: string[];
  const closers: Array<() => Promise<void>> = [];

  const envFor = (extra: Partial<ToolServerEnv> = {}): ToolServerEnv => ({
    ...readToolServerEnv({ ...base, SLUICE_ROUTER: s.routerAddress, SLUICE_PAYEE: builder, SLUICE_FACILITATOR_URL: s.facilitatorUrl, SLUICE_RPC_URL: s.rpcUrl, SLUICE_TOOLS_PORT: "0" }),
    ...extra,
  });
  const start = async (extra: Partial<ToolServerEnv> = {}, more: Parameters<typeof createToolServer>[0] extends infer O ? Partial<O> : never = {}) => {
    const t = await createToolServer({ env: envFor(extra), logger: createLogger({ write: (l) => lines.push(l), level: "debug" }), explorer: fakeExplorer(s.provider), ...more } as Parameters<typeof createToolServer>[0]);
    const port = await t.listen();
    closers.push(() => t.close());
    return { t, base: `http://127.0.0.1:${port}` };
  };
  const mcp = (base: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const toolCall = (name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) => ({
    jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) },
  });

  beforeEach(async () => {
    await freshChain(); // the tool server reads the wall clock, so the chain's clock must be the wall clock too
    s = await startStack({ feeBps: 100 });
    payer = throwawayWallet();
    builder = throwawayWallet().address;
    lines = [];
    await fundWallet(s, payer, USDC("5"), parseEther("1"));
    await depositFor(s, payer, USDC("5"));
    ({ t: tools } = await start());
    url = `http://127.0.0.1:${(tools.server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
    await s.stop();
  });

  it("serves its tools to a real MCP client over Streamable HTTP, and says what it charges in /health", async () => {
    const client = new Client({ name: "test-agent", version: "0.0.1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
    try {
      expect((await client.listTools()).tools.map((t) => t.name).sort()).to.deep.equal(["contract_lookup", "dex_quote", "token_risk_check"]);
    } finally {
      await client.close();
    }
    const health = (await (await fetch(`${url}/health`)).json()) as Record<string, unknown>;
    expect(health).to.deep.include({ ok: true, service: "sluice-paid-tools", network: "local", chainId: 1990, payee: builder });
    expect((health.tools as Array<{ name: string; price: string }>).find((t) => t.name === "contract_lookup")).to.deep.equal({ name: "contract_lookup", price: "0.005" });
    expect(JSON.stringify(health)).to.not.match(/0x[0-9a-f]{64}/i); // no key, no hash
  });

  it("answers a call with no payment with the price, and a call with a signed payment with the result and the settlement", async () => {
    const asked = (await (await mcp(url, toolCall("contract_lookup", { address: s.tokenAddress }))).json()) as { result: { isError?: boolean; structuredContent?: Record<string, unknown> } };
    expect(asked.result.isError).to.equal(true);
    const accepts = (asked.result.structuredContent as { accepts: Array<{ amount: string; payTo: string }> }).accepts;
    expect(accepts[0]).to.deep.include({ amount: "5000", payTo: builder });

    const requirements = requirementsFor(s, builder, USDC("0.005"), "contract_lookup");
    const made = await makePayment(s, payer, payer.address, requirements);
    const paid = (await (await mcp(url, toolCall("contract_lookup", { address: s.tokenAddress }, { [PAYMENT_META_KEY]: made.payload }))).json()) as {
      result: { isError?: boolean; structuredContent?: { isContract?: boolean }; _meta?: Record<string, { success: boolean; payer: string }> };
    };
    expect(paid.result.isError).to.not.equal(true);
    expect(paid.result.structuredContent?.isContract).to.equal(true);
    expect(paid.result._meta?.[PAYMENT_RESPONSE_META_KEY]).to.deep.include({ success: true, payer: payer.address });
    expect(await s.facilitator.flush()).to.include({ submitted: 1, settled: 1 });
    expect(await s.router.earnings(builder)).to.equal(USDC("0.005") - USDC("0.005") / 100n);
  });

  it("charges the price from the environment's table, and says so in the price it asks", async () => {
    const dear = await start({ prices: { ...DEFAULT_PRICES, contract_lookup: "0.25" } });
    const asked = (await (await mcp(dear.base, toolCall("contract_lookup", { address: s.tokenAddress }))).json()) as { result: { structuredContent: { accepts: Array<{ amount: string }> } } };
    expect(asked.result.structuredContent.accepts[0]?.amount).to.equal("250000");
  });

  it("limits calls with no payment per address, answers 429 with Retry-After, and still serves a paid call from that address", async () => {
    const limited = await start({ unpaidPerMinute: 3, ipPerMinute: 50 });
    for (let i = 0; i < 3; i++) expect((await mcp(limited.base, toolCall("dex_quote", { tokenIn: "QIE", tokenOut: "QIE", amountIn: "1" }))).status).to.equal(200);
    const refused = await mcp(limited.base, toolCall("dex_quote", { tokenIn: "QIE", tokenOut: "QIE", amountIn: "1" }));
    expect(refused.status).to.equal(429);
    expect(Number(refused.headers.get("retry-after"))).to.be.within(1, 60);
    expect((await refused.json()) as object).to.deep.include({ jsonrpc: "2.0" });
    expect((await mcp(limited.base, { jsonrpc: "2.0", id: 2, method: "tools/list" })).status, "tools/list carries no payment, so it is unpaid too").to.equal(429);

    // The same address, with a payment, is not held back by the unpaid limit.
    const made = await makePayment(s, payer, payer.address, requirementsFor(s, builder, USDC("0.005"), "contract_lookup"));
    const paid = await mcp(limited.base, toolCall("contract_lookup", { address: s.tokenAddress }, { [PAYMENT_META_KEY]: made.payload }));
    expect(paid.status).to.equal(200);
    expect(((await paid.json()) as { result: { isError?: boolean } }).result.isError).to.not.equal(true);
  });

  it("limits every kind of request per address, so a flood of paid-looking requests is not unlimited either", async () => {
    const limited = await start({ ipPerMinute: 4, unpaidPerMinute: 2 });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await mcp(limited.base, toolCall("dex_quote", {}, { [PAYMENT_META_KEY]: { not: "valid" } }))).status);
    expect(statuses.slice(0, 4).every((c) => c === 200)).to.equal(true);
    expect(statuses.slice(4)).to.deep.equal([429, 429]);
  });

  it("does not believe X-Forwarded-For with no proxy configured, and counts the client the proxy saw when one is", async () => {
    const plain = await start({ unpaidPerMinute: 1, ipPerMinute: 10 });
    expect((await mcp(plain.base, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { "x-forwarded-for": "1.1.1.1" })).status).to.equal(200);
    expect((await mcp(plain.base, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { "x-forwarded-for": "2.2.2.2" })).status).to.equal(429);
    const behind = await start({ unpaidPerMinute: 1, ipPerMinute: 10, trustedProxyHops: 1 });
    const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    expect((await mcp(behind.base, list, { "x-forwarded-for": "9.9.9.9, 1.1.1.1" })).status).to.equal(200);
    expect((await mcp(behind.base, list, { "x-forwarded-for": "8.8.8.8, 1.1.1.1" })).status).to.equal(429); // same client behind the proxy
    expect((await mcp(behind.base, list, { "x-forwarded-for": "8.8.8.8, 2.2.2.2" })).status).to.equal(200);
  });

  it("refuses a body over the limit before reading it, and one that is not JSON, and the wrong method or path", async () => {
    const small = await start({ maxBodyBytes: 2_048 });
    const big = await mcp(small.base, "x".repeat(10_000)).catch(() => undefined);
    if (big) expect(big.status).to.equal(413);
    expect((await mcp(small.base, "{nope")).status).to.equal(400);
    expect((await mcp(small.base, "5")).status).to.equal(400);
    expect((await fetch(`${small.base}/mcp`)).status).to.equal(405);
    expect((await fetch(`${small.base}/elsewhere`)).status).to.equal(404);
    expect((await mcp(small.base, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).to.equal(200);
  });

  it("answers 504 when a request takes too long, and the stalled read does not hold the server", async () => {
    const hang = { call: () => new Promise<string>(() => undefined), getCode: () => new Promise<string>(() => undefined), getStorageAt: () => new Promise<string>(() => undefined) };
    const slow = await start({}, { rpc: hang, handlerTimeoutMs: 400 });
    const made = await makePayment(s, payer, payer.address, requirementsFor(s, builder, USDC("0.005"), "contract_lookup"));
    const started = Date.now();
    const res = await mcp(slow.base, toolCall("contract_lookup", { address: s.tokenAddress }, { [PAYMENT_META_KEY]: made.payload }));
    expect(res.status).to.equal(504);
    expect(Date.now() - started).to.be.within(300, 5_000);
    expect((await fetch(`${slow.base}/health`)).status).to.equal(200);
    expect(await s.facilitator.flush()).to.include({ submitted: 0 }); // it was never charged: the tool did not finish
  });

  it("refuses to start when the router cannot be read in time, with a fixed message that holds no URL", async () => {
    const silent: Server = createServer(() => undefined); // takes the connection and never answers
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    try {
      const port = (silent.address() as { port: number }).port;
      const started = Date.now();
      const error = await rejection(createToolServer({ env: envFor({ rpcUrl: `http://127.0.0.1:${port}`, rpcTimeoutMs: 600 }) }));
      expect(error).to.be.instanceOf(ToolServerEnvError);
      expect(error.message).to.equal("refusing to start: the router could not be read at SLUICE_ROUTER on that network");
      expect(Date.now() - started).to.be.lessThan(15_000);
    } finally {
      silent.closeAllConnections();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });

  it("refuses to start on mainnet when the router does not hold QUSDC", async () => {
    const error = await rejection(createToolServer({ env: envFor({ network: "mainnet" }) }));
    expect(error).to.be.instanceOf(ToolServerEnvError);
    expect(error.message).to.match(/router does not hold QUSDC/);
  });

  it("logs the method, the tool and the outcome, and never a signature, an argument or a payment", async () => {
    const made = await makePayment(s, payer, payer.address, requirementsFor(s, builder, USDC("0.005"), "contract_lookup"));
    await mcp(url, toolCall("contract_lookup", { address: s.tokenAddress }, { [PAYMENT_META_KEY]: made.payload }));
    await mcp(url, toolCall("contract_lookup", { address: s.tokenAddress }));
    const all = lines.join("\n");
    const requests = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.msg === "request");
    expect(requests.map((r) => [r.method, r.tool, r.paid, r.status])).to.deep.include.members([["tools/call", "contract_lookup", true, 200], ["tools/call", "contract_lookup", false, 200]]);
    expect(all).to.not.contain(made.signature);
    expect(all).to.not.contain(made.signature.slice(2));
    expect(all).to.not.contain(s.tokenAddress); // an argument
    expect(all).to.not.match(/"signature"|authorization|privateKey/i);
  });
});

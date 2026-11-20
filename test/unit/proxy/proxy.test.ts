// The payment proxy: config, the owner's budget, and paying a real paid MCP server through a real facilitator.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";
import { Wallet, parseEther } from "ethers";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { FacilitatorClient, createPaywall, parsePaymentRequired, serveMcpHttp, settlementOf, toolIdOf } from "@sluice/sdk";
import { BudgetPolicy, ConfigError, PaymentLog, PaymentProxy, ProxyStartError, parseConfig } from "@sluice/proxy";
import type { ProxyConfig } from "@sluice/proxy";
import { USDC } from "../../helpers";
import { rejection } from "../../helpers/assert";
import { requirementsFor } from "../../helpers/payments";
import { depositFor, fundWallet, startStack, throwawayWallet } from "../../helpers/stack";
import type { Stack } from "../../helpers/stack";

const FUTURE = "2099-01-01T00:00:00Z";

describe("Proxy: configuration", () => {
  const router = throwawayWallet().address;
  const base = () => ({
    upstream: { url: "http://127.0.0.1:3402/mcp" },
    router,
    payer: throwawayWallet().address,
    budget: { perCallCap: "0.05", totalCap: "1.00", expiresAt: FUTURE, allowedTools: [{ tool: "echo", payee: throwawayWallet().address }] },
  });

  it("reads a valid config, in QUSDC units, with the key left out", () => {
    const c = parseConfig(base());
    expect(c.budget.perCallCap).to.equal(50_000n);
    expect(c.budget.totalCap).to.equal(1_000_000n);
    expect(c.chainId).to.equal(1990);
    expect(c.sessionKeyEnv).to.equal("SLUICE_AGENT_KEY");
    expect(JSON.stringify(c, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).to.not.match(/0x[0-9a-f]{64}/i);
  });

  const bad: Array<[string, (c: Record<string, any>) => void, RegExp]> = [
    ["no upstream", (c) => delete c.upstream, /upstream/],
    ["an upstream URL that is not https and not local", (c) => (c.upstream = { url: "http://example.com/mcp" }), /https/],
    ["a payer that is not an address", (c) => (c.payer = "0x123"), /payer must be an address/],
    ["a router that is not an address", (c) => (c.router = "router"), /router must be an address/],
    ["a per-call cap of zero", (c) => (c.budget.perCallCap = "0"), /perCallCap/],
    ["a per-call cap above the total", (c) => (c.budget.perCallCap = "2"), /cannot be above/],
    ["too many decimals", (c) => (c.budget.totalCap = "1.0000001"), /totalCap/],
    ["an expiry in the past", (c) => (c.budget.expiresAt = "2020-01-01T00:00:00Z"), /expired/],
    ["an expiry that is not a date", (c) => (c.budget.expiresAt = "later"), /date/],
    ["no allowed tools", (c) => (c.budget.allowedTools = []), /at least one tool/],
    ["an allowed tool with no payee", (c) => (c.budget.allowedTools = [{ tool: "echo" }]), /payee/],
    ["a key written where the environment variable name belongs", (c) => (c.sessionKeyEnv = `0x${"ab".repeat(32)}`), /environment variable name/],
  ];
  for (const [name, mutate, message] of bad) {
    it(`refuses ${name}`, () => {
      const c = base() as Record<string, any>;
      mutate(c);
      expect(() => parseConfig(c)).to.throw(ConfigError, message);
    });
  }

  it("refuses a config that is not an object", () => {
    for (const v of [null, 5, "x", []]) expect(() => parseConfig(v)).to.throw(ConfigError);
  });
});

describe("Proxy: the owner's budget (policy)", function () {
  let dir: string;
  let config: ProxyConfig;
  const builder = throwawayWallet().address;
  const router = throwawayWallet().address;
  const stack = { routerAddress: router, vaultAddress: router, tokenAddress: "0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5" };
  let nowValue = 1_800_000_000;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sluice-policy-"));
    nowValue = 1_800_000_000;
    config = parseConfig(
      {
        upstream: { url: "http://127.0.0.1:3402/mcp" },
        router,
        payer: throwawayWallet().address,
        budget: { perCallCap: "0.05", totalCap: "0.12", expiresAt: new Date((nowValue + 3600) * 1000).toISOString(), allowedTools: [{ tool: "echo", payee: builder }] },
        logFile: "log.jsonl",
        stateFile: "state.json",
      },
      nowValue,
      dir,
    );
  });

  const offer = (price: bigint, over: { payee?: string; tool?: string; router?: string } = {}) =>
    ({ ...requirementsFor(stack, over.payee ?? builder, price, over.tool ?? "echo") }) as ReturnType<typeof requirementsFor>;

  it("allows a call inside the budget", () => {
    const p = new BudgetPolicy(config, () => nowValue);
    expect(p.evaluate("echo", offer(USDC("0.01")))).to.deep.equal({ ok: true, amount: 10_000n });
  });

  it("refuses each way the budget can be broken, with a code for it", () => {
    const p = new BudgetPolicy(config, () => nowValue);
    const code = (tool: string, r: ReturnType<typeof offer>) => {
      const d = p.evaluate(tool, r);
      return d.ok ? "ok" : d.code;
    };
    expect(code("other", offer(USDC("0.01"), { tool: "other" }))).to.equal("unknown_tool");
    expect(code("echo", offer(USDC("0.01"), { payee: throwawayWallet().address }))).to.equal("payee_not_allowed");
    expect(code("echo", { ...offer(USDC("0.01")), extra: { ...offer(USDC("0.01")).extra, toolId: toolIdOf("something-else") } })).to.equal("tool_id_mismatch");
    expect(code("echo", offer(USDC("0.06")))).to.equal("over_per_call_cap");
    expect(code("echo", { ...offer(USDC("0.01")), amount: "0" })).to.equal("invalid_amount");
    expect(code("echo", { ...offer(USDC("0.01")), amount: "ten" })).to.equal("invalid_amount");
    expect(code("echo", { ...offer(USDC("0.01")), scheme: "exact" })).to.equal("unsupported_requirements");
    expect(code("echo", { ...offer(USDC("0.01")), network: "eip155:8453" })).to.equal("unsupported_requirements");
    expect(code("echo", { ...offer(USDC("0.01")), asset: throwawayWallet().address })).to.equal("unsupported_requirements");
    expect(code("echo", { ...offer(USDC("0.01")), extra: { ...offer(USDC("0.01")).extra, router: throwawayWallet().address } })).to.equal("unsupported_requirements");
    nowValue += 3601;
    expect(code("echo", offer(USDC("0.01")))).to.equal("budget_expired");
  });

  it("counts what it has committed against the total cap, and persists it", () => {
    const p = new BudgetPolicy(config, () => nowValue);
    p.commit(USDC("0.05"));
    p.commit(USDC("0.05"));
    expect(p.evaluate("echo", offer(USDC("0.03")))).to.deep.include({ ok: false, code: "over_total_cap" });
    expect(p.evaluate("echo", offer(USDC("0.02")))).to.deep.equal({ ok: true, amount: 20_000n });
    expect(p.remainingUnits).to.equal(USDC("0.02"));
    // A new process reads the same state file and keeps counting.
    const again = new BudgetPolicy(config, () => nowValue);
    expect(again.spentUnits).to.equal(USDC("0.10"));
    expect(again.payments).to.equal(2);
  });

  it("treats an unreadable state file as fully spent, never as a fresh budget", () => {
    writeFileSync(config.stateFile, "{not json");
    const p = new BudgetPolicy(config, () => nowValue);
    expect(p.remainingUnits).to.equal(0n);
    expect(p.evaluate("echo", offer(USDC("0.01")))).to.deep.include({ ok: false, code: "over_total_cap" });
  });

  it("writes a log with no signature and no key, skipping damaged lines when reading", () => {
    const log = new PaymentLog(config.logFile);
    log.append({ event: "paid", tool: "echo", payee: builder, amount: "0.010000", id: `0x${"ab".repeat(32)}`, status: "queued" });
    require("node:fs").appendFileSync(config.logFile, "garbage\n");
    log.append({ event: "refused", tool: "echo", reason: "over_per_call_cap" });
    const rows = log.read();
    expect(rows.map((r) => r.event)).to.deep.equal(["paid", "refused"]);
    expect(readFileSync(config.logFile, "utf8")).to.not.match(/signature/i);
  });
});

describe("Proxy: paying a paid MCP server", function () {
  let s: Stack;
  let owner: Wallet;
  let agent: Wallet;
  let builder: Wallet;
  let dir: string;
  let upstream: Client;
  let close: () => Promise<void>;
  let url: string;
  let runs: Record<string, number>;
  let counter: { calls: number };

  before(async () => {
    s = await startStack();
    owner = throwawayWallet();
    agent = throwawayWallet();
    builder = throwawayWallet();
    await fundWallet(s, owner, USDC("20"), parseEther("1"));
    await depositFor(s, owner, USDC("20"));
    await (
      await s.vault.connect(owner.connect(s.provider)).authorize(
        { agent: agent.address, budget: USDC("0.5"), perCallCap: USDC("0.05"), expiry: BigInt(s.clock() + 86_400) },
        [
          { payee: builder.address, toolId: toolIdOf("echo") },
          { payee: builder.address, toolId: toolIdOf("pricey") },
        ],
      )
    ).wait();

    runs = {};
    counter = { calls: 0 };
    const paywall = createPaywall({ facilitator: new FacilitatorClient({ url: s.facilitatorUrl }), router: s.routerAddress, vault: s.vaultAddress, asset: s.tokenAddress, now: s.clock });
    const stranger = throwawayWallet().address;
    const build = async () => {
      const server = new McpServer({ name: "paid", version: "0" });
      const tool = (name: string, price: string, payee = builder.address) =>
        paywall.registerPaidTool(server, { name, price, payee, inputSchema: { text: z.string() } }, async (a: { text: string }) => {
          runs[name] = (runs[name] ?? 0) + 1;
          return { content: [{ type: "text", text: `${name}:${a.text}` }] };
        });
      await tool("echo", "0.01");
      await tool("pricey", "0.06"); // above the per-call cap
      await tool("unlisted", "0.01"); // not on the owner's list
      await tool("misdirected", "0.01", stranger); // a payee the owner did not name
      return server;
    };
    const served = await serveMcpHttp(build);
    url = `http://127.0.0.1:${served.port}/mcp`;
    close = () => new Promise<void>((resolve) => served.server.close(() => resolve()));
    upstream = new Client({ name: "proxy-upstream", version: "0" });
    await upstream.connect(new StreamableHTTPClientTransport(new URL(url)));
  });
  after(async () => {
    await upstream.close();
    await close();
    await s.stop();
  });

  const makeProxy = (over: { totalCap?: string; perCallCap?: string; now?: () => number; key?: Wallet } = {}) => {
    dir = mkdtempSync(join(tmpdir(), "sluice-proxy-"));
    const config = parseConfig(
      {
        upstream: { url },
        router: s.routerAddress,
        payer: owner.address,
        asset: s.tokenAddress,
        budget: {
          perCallCap: over.perCallCap ?? "0.05",
          totalCap: over.totalCap ?? "0.5",
          expiresAt: new Date((s.clock() + 86_400) * 1000).toISOString(),
          allowedTools: [
            { tool: "echo", payee: builder.address },
            { tool: "pricey", payee: builder.address },
            { tool: "misdirected", payee: builder.address },
          ],
        },
      },
      s.clock(),
      dir,
    );
    const counting = {
      listTools: (p?: { cursor?: string }) => upstream.listTools(p),
      callTool: (p: { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> }) => {
        counter.calls += 1;
        return upstream.callTool(p);
      },
    };
    return { config, proxy: new PaymentProxy({ config, signer: over.key ?? agent, upstream: counting, now: over.now ?? s.clock }) };
  };

  beforeEach(() => {
    runs = {};
    counter.calls = 0;
  });

  const echo = (proxy: PaymentProxy, text = "hi") => proxy.callTool({ name: "echo", arguments: { text } });

  it("passes a tool list straight through", async () => {
    const { proxy } = makeProxy();
    const list = (await proxy.listTools()) as { tools: Array<{ name: string }> };
    expect(list.tools.map((t) => t.name).sort()).to.deep.equal(["echo", "misdirected", "pricey", "unlisted"]);
  });

  it("pays an in-budget call with the session key, logs it, and the router charges the owner's balance", async () => {
    const { config, proxy } = makeProxy();
    const before = (await s.router.payerBalance(owner.address)) as bigint;
    const r = await echo(proxy);
    expect(r.isError).to.not.equal(true);
    expect(r.content[0]?.text).to.equal("echo:hi");
    expect(counter.calls, "one call without payment, one retry with it").to.equal(2);
    expect(settlementOf(r)?.success).to.equal(true);

    await s.facilitator.flush();
    expect(((await s.router.payerBalance(owner.address)) as bigint)).to.equal(before - USDC("0.01"));
    const logged = proxy.log.read();
    expect(logged).to.have.length(1);
    expect(logged[0]).to.deep.include({ event: "paid", tool: "echo", payee: builder.address, amount: "0.010000", status: "queued" });
    expect(s.facilitator.status(logged[0]!.id!)?.status).to.equal("settled");
    expect(proxy.policy.spentUnits).to.equal(USDC("0.01"));
    expect(JSON.parse(readFileSync(config.stateFile, "utf8"))).to.deep.equal({ spent: "10000", count: 1 });
    expect(readFileSync(config.logFile, "utf8")).to.not.match(/signature|0x[0-9a-f]{130}/i);
  });

  it("settled intents were signed by the agent session key, not the owner", async () => {
    const { proxy } = makeProxy();
    await echo(proxy, "who signed");
    await s.facilitator.flush();
    const id = proxy.log.read().at(-1)!.id!;
    const rec = s.facilitator.store.get(id)!;
    expect(rec.signer).to.equal(agent.address);
    expect(rec.payer).to.equal(owner.address);
  });

  it("refuses a tool the owner did not list, without signing anything or contacting the facilitator", async () => {
    const { proxy } = makeProxy();
    const queued = s.facilitator.store.size();
    const r = await proxy.callTool({ name: "unlisted", arguments: { text: "x" } });
    expect(r.isError).to.equal(true);
    expect(r.structuredContent).to.deep.include({ error: "sluice_proxy_refused", reason: "unknown_tool" });
    expect(runs.unlisted).to.equal(undefined);
    expect(counter.calls, "no retry").to.equal(1);
    expect(s.facilitator.store.size()).to.equal(queued);
    expect(proxy.policy.spentUnits).to.equal(0n);
    expect(proxy.log.read().at(-1)).to.deep.include({ event: "refused", tool: "unlisted", reason: "unknown_tool" });
  });

  it("refuses a payee the owner did not name for the tool", async () => {
    const { proxy } = makeProxy();
    const r = await proxy.callTool({ name: "misdirected", arguments: { text: "x" } });
    expect(r.structuredContent).to.deep.include({ reason: "payee_not_allowed" });
    expect(proxy.policy.spentUnits).to.equal(0n);
  });

  it("refuses a price above the per-call cap", async () => {
    const { proxy } = makeProxy();
    const r = await proxy.callTool({ name: "pricey", arguments: { text: "x" } });
    expect(r.structuredContent).to.deep.include({ reason: "over_per_call_cap" });
    expect(String((r.structuredContent as { detail: string }).detail)).to.contain("0.060000");
    expect(runs.pricey).to.equal(undefined);
  });

  it("refuses the purchase that would pass the total cap, and stops there", async () => {
    const { proxy } = makeProxy({ totalCap: "0.03", perCallCap: "0.03" });
    for (let i = 0; i < 3; i++) expect((await echo(proxy, `n${i}`)).isError).to.not.equal(true);
    const over = await echo(proxy, "n3");
    expect(over.isError).to.equal(true);
    expect(over.structuredContent).to.deep.include({ reason: "over_total_cap" });
    expect(proxy.policy.spentUnits).to.equal(USDC("0.03"));
  });

  it("holds the total cap under concurrent calls: five at once against a cap of three", async () => {
    const { proxy } = makeProxy({ totalCap: "0.03", perCallCap: "0.03" });
    const results = await Promise.all([1, 2, 3, 4, 5].map((i) => echo(proxy, `c${i}`)));
    const paid = results.filter((r) => !r.isError);
    const refused = results.filter((r) => r.isError);
    expect(paid).to.have.length(3);
    expect(refused).to.have.length(2);
    expect(proxy.policy.spentUnits).to.equal(USDC("0.03"));
  });

  it("refuses everything once the budget has expired", async () => {
    let t = s.clock();
    const { proxy } = makeProxy({ now: () => t });
    expect((await echo(proxy)).isError).to.not.equal(true);
    t += 100_000; // past the owner's expiry
    const r = await echo(proxy, "late");
    expect(r.structuredContent).to.deep.include({ reason: "budget_expired" });
  });

  it("stops at the chain's limit even if its own config is looser: the vault's budget is the final word", async () => {
    // The owner's on-chain session allows 0.5 QUSDC. Spend it with signed calls, then ask the proxy for one more.
    const sessionAgent = throwawayWallet();
    await (
      await s.vault.connect(owner.connect(s.provider)).authorize(
        { agent: sessionAgent.address, budget: USDC("0.02"), perCallCap: USDC("0.02"), expiry: BigInt(s.clock() + 86_400) },
        [{ payee: builder.address, toolId: toolIdOf("echo") }],
      )
    ).wait();
    const { proxy } = makeProxy({ key: sessionAgent, totalCap: "1.00" }); // the proxy thinks it has a full 1.00
    expect((await echo(proxy, "a")).isError).to.not.equal(true);
    expect((await echo(proxy, "b")).isError).to.not.equal(true);
    const third = await echo(proxy, "c");
    expect(third.isError).to.equal(true);
    expect(parsePaymentRequired(third)?.error).to.equal("sluice_budget_exceeded");
    expect(proxy.log.read().at(-1)).to.deep.include({ event: "failed", reason: "sluice_budget_exceeded" });
  });

  it("pays at most once per call, even if the server keeps asking", async () => {
    // A server that answers every call, paid or not, with payment required:
    const required = await upstream.callTool({ name: "echo", arguments: { text: "x" } });
    const always = {
      listTools: async () => ({ tools: [] }),
      callTool: async () => {
        counter.calls += 1;
        return required;
      },
    };
    const { config } = makeProxy();
    const proxy = new PaymentProxy({ config, signer: agent, upstream: always, now: s.clock });
    const r = await proxy.callTool({ name: "echo", arguments: { text: "x" } });
    expect(r.isError).to.equal(true);
    expect(counter.calls, "one call, one paid retry, nothing more").to.equal(2);
    expect(proxy.policy.payments).to.equal(1);
  });

  it("does not interfere when the agent supplies its own payment, and passes free tools through", async () => {
    const { proxy } = makeProxy();
    const r = await proxy.callTool({ name: "echo", arguments: { text: "x" }, _meta: { "x402/payment": { x402Version: 2, bogus: true } } });
    expect(r.isError).to.equal(true);
    expect(proxy.policy.spentUnits).to.equal(0n);
  });

  it("will not start with the owner's own key", async () => {
    const err = await rejection(Promise.resolve().then(() => makeProxy({ key: owner })));
    expect(err).to.be.instanceOf(ProxyStartError);
    expect(err.message).to.match(/never with the owner's key/);
  });
});

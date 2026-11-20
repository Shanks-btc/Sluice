// The wallet MCP, driven by a real MCP client over an in-memory transport, against the local chain and a paid server.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";
import { Interface, Wallet, parseEther } from "ethers";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { ERC20_ABI, FacilitatorClient, createPaywall, routerInterface, serveMcpHttp, toolIdOf } from "@sluice/sdk";
import { PaymentProxy, parseConfig } from "@sluice/proxy";
import type { ProxyConfig, UpstreamClient } from "@sluice/proxy";
import { ChainReader, WalletStartError, assertSessionKey, createWalletServer } from "@sluice/wallet-mcp";
import { USDC } from "../../helpers";
import { rejection } from "../../helpers/assert";
import { depositFor, fundWallet, startStack, throwawayWallet } from "../../helpers/stack";
import type { Stack } from "../../helpers/stack";

type Reply = { isError?: boolean; structuredContent?: Record<string, any>; content: Array<{ type: string; text?: string }> };

describe("Wallet MCP", function () {
  let s: Stack;
  let owner: Wallet;
  let agent: Wallet;
  let builder: Wallet;
  let config: ProxyConfig;
  let upstream: Client;
  let closeUpstream: () => Promise<void>;
  let client: Client;
  let chain: ChainReader;
  let proxy: PaymentProxy;

  before(async () => {
    s = await startStack();
    owner = throwawayWallet();
    agent = throwawayWallet();
    builder = throwawayWallet();
    const expiry = s.clock() + 86_400; // the chain's session and the config share one value, so no expiry warning is expected
    await fundWallet(s, owner, USDC("20"), parseEther("1"));
    await depositFor(s, owner, USDC("10"));
    await (
      await s.vault.connect(owner.connect(s.provider)).authorize(
        { agent: agent.address, budget: USDC("0.5"), perCallCap: USDC("0.05"), expiry: BigInt(expiry) },
        [{ payee: builder.address, toolId: toolIdOf("echo") }],
      )
    ).wait();

    const paywall = createPaywall({ facilitator: new FacilitatorClient({ url: s.facilitatorUrl }), router: s.routerAddress, asset: s.tokenAddress, now: s.clock });
    const served = await serveMcpHttp(async () => {
      const server = new McpServer({ name: "paid", version: "0" });
      await paywall.registerPaidTool(server, { name: "echo", price: "0.01", payee: builder.address, inputSchema: { text: z.string() } }, async (a: { text: string }) => ({
        content: [{ type: "text", text: `echo:${a.text}` }],
      }));
      await paywall.registerPaidTool(server, { name: "pricey", price: "0.06", payee: builder.address, inputSchema: { text: z.string() } }, async () => ({ content: [{ type: "text", text: "x" }] }));
      return server;
    });
    closeUpstream = () => new Promise<void>((resolve) => served.server.close(() => resolve()));
    upstream = new Client({ name: "wallet-upstream", version: "0" });
    await upstream.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${served.port}/mcp`)));

    const dir = mkdtempSync(join(tmpdir(), "sluice-wallet-"));
    config = parseConfig(
      {
        upstream: { url: `http://127.0.0.1:${served.port}/mcp` },
        router: s.routerAddress,
        payer: owner.address,
        asset: s.tokenAddress,
        budget: {
          perCallCap: "0.05", totalCap: "0.5", expiresAt: new Date(expiry * 1000).toISOString(),
          allowedTools: [{ tool: "echo", payee: builder.address }, { tool: "pricey", payee: builder.address }],
        },
      },
      s.clock(),
      dir,
    );
    proxy = new PaymentProxy({ config, signer: agent, upstream: upstream as unknown as UpstreamClient, now: s.clock });
    chain = await ChainReader.connect(s.provider, s.routerAddress);

    const server = createWalletServer({ config, chain, agent: agent.address, upstream: async () => upstream as unknown as UpstreamClient, now: s.clock });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    client = new Client({ name: "agent", version: "0" });
    await client.connect(a);
  });
  after(async () => {
    await client.close();
    await upstream.close();
    await closeUpstream();
    await s.stop();
  });

  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<Reply>;

  it("has exactly the five tools, and none that signs, sends, takes a key or changes a budget", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).to.deep.equal(["balance", "budget_status", "deposit_instructions", "pay_history", "price_check"]);
    for (const t of tools) {
      const props = Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
      for (const p of props) expect(p, `${t.name} parameter`).to.not.match(/key|secret|seed|mnemonic|password|sign|budget|cap|expir|raise/i);
      expect(t.name).to.not.match(/sign|send|pay$|transfer|approve|authorize|set_|raise/);
    }
  });

  it("balance: reads the owner's prepaid balance, wallet QUSDC and this agent's session from the chain", async () => {
    const r = await call("balance");
    expect(r.isError).to.not.equal(true);
    const d = r.structuredContent!;
    expect(d).to.deep.include({ account: owner.address, prepaid: "10.000000", wallet: "10.000000", agent: agent.address, router: s.routerAddress });
    expect(d.session).to.deep.include({ active: true, budget: "0.500000", spent: "0.000000", remaining: "0.500000", perCallCap: "0.050000" });
    expect(JSON.parse(r.content[0]!.text!)).to.deep.equal(d);
  });

  it("balance: says plainly that it cannot resolve a .qie name, and why, and rejects nonsense", async () => {
    const named = await call("balance", { account: "alice.qie" });
    expect(named.isError).to.equal(true);
    expect(named.structuredContent).to.deep.include({ error: "name_resolution_unavailable" });
    expect(named.structuredContent!.message).to.match(/no \.qie resolver/);
    expect(named.structuredContent!.hint).to.match(/no documented on-chain read/);
    const bad = await call("balance", { account: "not an address" });
    expect(bad.isError).to.equal(true);
    const other = await call("balance", { account: builder.address });
    expect(other.structuredContent).to.deep.include({ account: builder.address, prepaid: "0.000000" });
  });

  it("deposit_instructions: exact calls for the owner, the zero-QIE option and the QUSDC admin risk, and sends nothing", async () => {
    const before = await s.router.payerBalance(owner.address);
    const r = await call("deposit_instructions", { amount: "5" });
    const d = r.structuredContent!;
    expect(d.for).to.equal("the owner");
    const [approve, deposit, authorize] = d.steps;
    expect(approve.to).to.equal(s.tokenAddress);
    const decoded = new Interface(ERC20_ABI as unknown as string[]).parseTransaction({ data: approve.data })!;
    expect([decoded.name, decoded.args[0], decoded.args[1]]).to.deep.equal(["approve", s.routerAddress, 5_000_000n]);
    expect(deposit.to).to.equal(s.routerAddress);
    const dep = routerInterface.parseTransaction({ data: deposit.data })!;
    expect([dep.name, dep.args[0]]).to.deep.equal(["deposit", 5_000_000n]);
    expect(authorize.to).to.equal(d.vault);
    expect(authorize.grant).to.deep.include({ agent: agent.address, budget: "500000", perCallCap: "50000" });
    expect(d.withNoQie.summary).to.match(/no QIE/);
    expect(d.withNoQie.how).to.match(/never give the owner's key/i);
    expect(d.warnings[0]).to.contain("admin account can give itself the right to burn any holder's QUSDC");
    expect(await s.router.payerBalance(owner.address)).to.equal(before);
    expect((await call("deposit_instructions", { amount: "0" })).isError).to.equal(true);
    expect((await call("deposit_instructions", { amount: "abc" })).isError).to.equal(true);
  });

  it("price_check: reads the advertised price, then the authoritative one, and says whether the budget allows it, paying nothing", async () => {
    const spentBefore = proxy.policy.spentUnits;
    const queued = s.facilitator.store.size();
    const advertised = await call("price_check", { tool: "echo" });
    expect(advertised.structuredContent!.advertised).to.deep.include({ scheme: "sluice-intent", amount: "10000", price: "0.010000", payTo: builder.address });
    expect(advertised.structuredContent!.authoritative).to.equal(null);

    const quote = await call("price_check", { tool: "echo", arguments: { text: "x" } });
    expect(quote.structuredContent!.authoritative).to.deep.include({ paymentRequired: true });
    expect(quote.structuredContent!.authoritative.accepts[0]).to.deep.include({ price: "0.010000", payTo: builder.address, router: s.routerAddress });
    expect(quote.structuredContent!.wouldPay).to.deep.equal({ allowed: true, price: "0.010000" });

    const pricey = await call("price_check", { tool: "pricey", arguments: { text: "x" } });
    expect(pricey.structuredContent!.wouldPay).to.deep.include({ allowed: false, code: "over_per_call_cap" });

    const missing = await call("price_check", { tool: "nope" });
    expect(missing.isError).to.equal(true);
    expect(missing.structuredContent).to.deep.include({ error: "unknown_tool" });

    expect(proxy.policy.spentUnits, "no budget was used").to.equal(spentBefore);
    expect(s.facilitator.store.size(), "nothing was queued").to.equal(queued);
  });

  it("pay_history and budget_status: reflect payments the proxy made, locally and on the chain", async () => {
    for (const text of ["a", "b"]) expect((await proxy.callTool({ name: "echo", arguments: { text } })).isError).to.not.equal(true);
    await s.facilitator.flush();

    const history = (await call("pay_history", { limit: 10 })).structuredContent!;
    expect(history.local.map((e: { event: string }) => e.event)).to.deep.equal(["paid", "paid"]);
    expect(history.chain.rows).to.have.length(2);
    expect(history.chain.rows[0]).to.deep.include({ amount: "0.010000", payee: builder.address, signer: agent.address });
    expect(history.chain.complete).to.equal(true);
    expect((await call("pay_history", { source: "local" })).structuredContent!.chain).to.equal(undefined);
    expect((await call("pay_history", { source: "chain", limit: 1 })).structuredContent!.chain.rows).to.have.length(1);
    expect((await call("pay_history", { limit: 0 })).isError).to.equal(true); // outside 1 to 100

    const b = (await call("budget_status")).structuredContent!;
    expect(b.local).to.deep.include({ perCallCap: "0.050000", totalCap: "0.500000", spent: "0.020000", remaining: "0.480000", payments: 2, expired: false });
    expect(b.chain).to.deep.include({ budget: "0.500000", spent: "0.020000", remaining: "0.480000" });
    expect(b.warnings).to.deep.equal([]);
    expect(b.whoCanChangeIt).to.match(/Only the owner/);
  });

  it("budget_status: warns when the local limits are looser than the chain's, and when the chain has no session", async () => {
    await (
      await s.vault.connect(owner.connect(s.provider)).authorize(
        { agent: agent.address, budget: USDC("0.1"), perCallCap: USDC("0.02"), expiry: BigInt(s.clock() + 3600) },
        [{ payee: builder.address, toolId: toolIdOf("echo") }],
      )
    ).wait();
    const loose = (await call("budget_status")).structuredContent!;
    expect(loose.warnings.join(" ")).to.match(/per-call cap is above the chain's/);
    expect(loose.warnings.join(" ")).to.match(/total cap is above the chain's/);
    expect(loose.warnings.join(" ")).to.match(/expiry is later/);

    const stranger = throwawayWallet();
    const orphan = createWalletServer({ config, chain, agent: stranger.address, now: s.clock });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await orphan.connect(b);
    const c2 = new Client({ name: "orphan", version: "0" });
    await c2.connect(a);
    const none = (await c2.callTool({ name: "budget_status", arguments: {} })) as Reply;
    expect(none.structuredContent!.chain).to.equal(null);
    expect(none.structuredContent!.warnings[0]).to.match(/no session for this agent key/);
    await c2.close();
  });

  it("can never raise its own budget: no argument or tool changes the owner's session", async () => {
    const sessionBefore = await chain.session(owner.address, agent.address);
    for (const name of ["balance", "budget_status", "price_check", "pay_history", "deposit_instructions"]) {
      await call(name, { tool: "echo", budget: "1000", totalCap: "1000", perCallCap: "1000", expiry: 9_999_999_999, privateKey: `0x${"11".repeat(32)}` }).catch(() => undefined);
    }
    const sessionAfter = await chain.session(owner.address, agent.address);
    expect(sessionAfter).to.deep.equal(sessionBefore);
  });

  describe("the session key it will load", () => {
    it("refuses the owner's own address, the router's owner and its fee recipient, and accepts a plain session key", async () => {
      expect(await rejection(assertSessionKey(chain, config, owner.address))).to.be.instanceOf(WalletStartError);
      const asOwner = await rejection(assertSessionKey(chain, config, s.owner.address));
      expect(asOwner.message).to.match(/router's owner/);
      const asFee = await rejection(assertSessionKey(chain, config, s.feeRecipient.address));
      expect(asFee.message).to.match(/fee recipient/);
      await assertSessionKey(chain, config, agent.address);
    });
  });
});

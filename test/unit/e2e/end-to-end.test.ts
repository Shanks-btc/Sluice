// End to end, across real processes on this machine:
//
//   an agent (MCP client)  ->  sluice-proxy (stdio)  ->  the example paid tools (stdio)  ->  the facilitator (HTTP)  ->  the router
//
// The owner starts with QUSDC and zero QIE: they onboard, authorise the agent and could later leave, all by signing,
// with the facilitator paying the gas. The chain is the local Hardhat chain served over HTTP; the explorer is a local
// stand-in. No key leaves this machine and nothing is sent to QIE.
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";
import { Wallet, id } from "ethers";
import { ethers } from "hardhat";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  FacilitatorClient, PAYMENT_RESPONSE_META_KEY, signAuthorize, signOnboarding, toolIdOf,
} from "@sluice/sdk";
import { deployContract, USDC } from "../../helpers";
import { fakeExplorer } from "../../helpers/explorer";
import { connectStdio, ROOT, tsCommand } from "../../helpers/spawn";
import { freshChain, fundWallet, startStack, throwawayWallet } from "../../helpers/stack";
import type { Stack } from "../../helpers/stack";

type Reply = { isError?: boolean; structuredContent?: Record<string, any>; content: Array<{ type: string; text?: string }>; _meta?: Record<string, any> };

async function serveExplorer(get: (path: string) => Promise<{ status: number; json: unknown }>): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    void get(req.url ?? "/").then(
      (r) => res.writeHead(r.status, { "content-type": "application/json" }).end(JSON.stringify(r.json)),
      () => res.writeHead(500).end("{}"),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server };
}

describe("End to end: agent -> proxy -> paid tools -> facilitator -> router", function () {
  this.timeout(240_000);

  let s: Stack;
  let owner: Wallet;
  let agent: Wallet;
  let builder: Wallet;
  let dir: string;
  let configPath: string;
  let agentClient: Client;
  let explorerServer: Server;
  let roleToken: string;
  const clients: Client[] = [];

  before(async () => {
    await freshChain(); // the programs below read the wall clock, so the chain's clock must be the wall clock too
    s = await startStack({ feeBps: 100 });
    owner = throwawayWallet();
    agent = throwawayWallet();
    builder = throwawayWallet();

    // A token with an admin that can burn, for the paid risk check to find.
    const [admin, tokenOwner] = await ethers.getSigners();
    const token = await deployContract("RoleToken", [admin!.address, tokenOwner!.address]);
    roleToken = await token.getAddress();
    await (await token.connect(admin!).grantRole(id("VAULT_ROLE"), builder.address)).wait();
    const explorer = fakeExplorer(ethers.provider);
    const served = await serveExplorer(explorer);
    explorerServer = served.server;

    // The owner holds QUSDC and no QIE. Everything below is signed by the owner and sent by the facilitator.
    await fundWallet(s, owner, USDC("20"));
    expect(await s.provider.getBalance(owner.address)).to.equal(0n);
    const facilitator = new FacilitatorClient({ url: s.facilitatorUrl });
    const gasPrice = (await s.provider.getFeeData()).gasPrice as bigint;
    const { approveTx, depositTx } = await signOnboarding(owner, { router: s.routerAddress, asset: s.tokenAddress, amount: USDC("5"), nonce: 0, gasPrice });
    const onboarded = await facilitator.onboard({ payer: owner.address, approveTx, depositTx });
    expect(onboarded.ok, onboarded.detail).to.equal(true);

    const expiry = s.clock() + 86_400; // one value for the chain's session and for the proxy's config, so they agree to the second
    const grant = { agent: agent.address, budget: USDC("0.5"), perCallCap: USDC("0.02"), expiry: BigInt(expiry) };
    const tools = [
      { payee: builder.address, toolId: toolIdOf("token_risk_check") },
      { payee: builder.address, toolId: toolIdOf("contract_lookup") },
    ];
    const deadline = BigInt(s.clock() + 600);
    const signature = await signAuthorize(owner, s.vaultAddress, { payer: owner.address, grant, tools, nonce: 0n, deadline });
    const authorised = await facilitator.relay({
      kind: "authorize", payer: owner.address, tools, deadline: deadline.toString(), signature,
      grant: { agent: agent.address, budget: grant.budget.toString(), perCallCap: grant.perCallCap.toString(), expiry: grant.expiry.toString() },
    });
    expect(authorised.ok, authorised.detail).to.equal(true);

    dir = mkdtempSync(join(tmpdir(), "sluice-e2e-"));
    mkdirSync(dir, { recursive: true });
    const upstream = tsCommand("examples/paid-tools/src/cli.ts");
    configPath = join(dir, "sluice.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        upstream: {
          command: upstream.command,
          args: upstream.args,
          cwd: ROOT,
          env: {
            SLUICE_ROUTER: s.routerAddress,
            SLUICE_FACILITATOR_URL: s.facilitatorUrl,
            SLUICE_PAYEE: builder.address,
            SLUICE_RPC_URL: s.rpcUrl,
            SLUICE_EXPLORER_URL: served.url,
          },
        },
        router: s.routerAddress,
        payer: owner.address,
        asset: s.tokenAddress,
        rpcUrl: s.rpcUrl,
        budget: {
          perCallCap: "0.02",
          totalCap: "0.5",
          expiresAt: new Date(expiry * 1000).toISOString(),
          allowedTools: [
            { tool: "token_risk_check", payee: builder.address },
            { tool: "contract_lookup", payee: builder.address },
          ],
        },
        logFile: "payments.jsonl",
        stateFile: "budget.json",
      }),
    );
    agentClient = await connectStdio("packages/proxy/src/cli.ts", ["--config", configPath], { SLUICE_AGENT_KEY: agent.privateKey });
    clients.push(agentClient);
  });

  after(async () => {
    for (const c of clients) await c.close().catch(() => undefined);
    await new Promise<void>((resolve) => explorerServer.close(() => resolve()));
    await s.stop();
  });

  const call = (name: string, args: Record<string, unknown>) => agentClient.callTool({ name, arguments: args }) as Promise<Reply>;

  it("starts the owner with QUSDC and no QIE: deposited and authorised by signature, with the relayer paying", async () => {
    expect(await s.router.payerBalance(owner.address)).to.equal(USDC("5"));
    const session = await s.vault.sessionOf(owner.address, agent.address);
    expect(session.budget).to.equal(USDC("0.5"));
    expect(await s.provider.getBalance(owner.address)).to.be.lessThan(10n ** 14n); // only the unused part of the onboarding gas
    expect(await s.token.balanceOf(s.relayerAddress)).to.equal(0n);
  });

  it("shows the agent the paid server's tools through the proxy", async () => {
    const { tools } = await agentClient.listTools();
    expect(tools.map((t) => t.name).sort()).to.deep.equal(["contract_lookup", "dex_quote", "token_risk_check"]);
  });

  it("pays for a real tool result: the agent calls, the proxy pays, the server answers, the facilitator settles, the router splits", async () => {
    const before = (await s.router.payerBalance(owner.address)) as bigint;
    const r = await call("token_risk_check", { address: roleToken });
    expect(r.isError, JSON.stringify(r.content)).to.not.equal(true);
    const report = JSON.parse(r.content[0]!.text!);
    expect(report.isContract).to.equal(true);
    expect(report.token).to.deep.include({ symbol: "RLT", decimals: 6 });
    expect(report.flags.map((f: { code: string }) => f.code)).to.include.members(["admin_can_burn_holders", "role_admin_can_grant_burn", "owner_is_eoa"]);

    const settlement = r._meta![PAYMENT_RESPONSE_META_KEY];
    expect(settlement).to.deep.include({ success: true, transaction: "", network: "eip155:1990", payer: owner.address });
    const intentId = settlement.extensions.sluice.id as string;
    expect(settlement.extensions.sluice.status).to.equal("queued");

    expect(await s.facilitator.flush()).to.include({ submitted: 1, settled: 1 });
    expect((await s.facilitator.status(intentId))).to.deep.include({ status: "settled", payer: owner.address, payee: builder.address, amount: USDC("0.01").toString() });
    expect((await s.router.payerBalance(owner.address)) as bigint).to.equal(before - USDC("0.01"));
    expect((await s.router.earnings(builder.address)) as bigint).to.equal(USDC("0.01") - USDC("0.01") / 100n);
    expect((await s.router.earnings(s.feeRecipient.address)) as bigint).to.equal(USDC("0.01") / 100n);
    const rec = s.facilitator.store.get(intentId)!;
    expect(rec.signer, "signed by the agent's session key").to.equal(agent.address);
    expect(await s.token.balanceOf(s.relayerAddress), "the relayer never held QUSDC").to.equal(0n);
  });

  it("pays for a second tool, and the proxy's log and budget file record both", async () => {
    const r = await call("contract_lookup", { address: roleToken });
    expect(r.isError).to.not.equal(true);
    const lookup = JSON.parse(r.content[0]!.text!);
    expect(lookup).to.deep.include({ isContract: true });
    expect(lookup.explorer).to.deep.include({ available: true, verified: false }); // the stand-in explorer has no source for it
    await s.facilitator.flush();

    const log = readFileSync(join(dir, "payments.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log.map((e) => [e.event, e.tool, e.amount])).to.deep.equal([
      ["paid", "token_risk_check", "0.010000"],
      ["paid", "contract_lookup", "0.005000"],
    ]);
    expect(JSON.parse(readFileSync(join(dir, "budget.json"), "utf8"))).to.deep.equal({ spent: "15000", count: 2 });
    expect(readFileSync(join(dir, "payments.jsonl"), "utf8")).to.not.match(/signature|privateKey|0x[0-9a-f]{130}/i);
  });

  it("refuses to pay for a tool the owner did not allow, and nothing is signed or queued", async () => {
    const queued = s.facilitator.store.size();
    const r = await call("dex_quote", { tokenIn: "QIE", tokenOut: s.tokenAddress, amountIn: "1" });
    expect(r.isError).to.equal(true);
    expect(r.structuredContent).to.deep.include({ error: "sluice_proxy_refused", reason: "unknown_tool" });
    expect(s.facilitator.store.size()).to.equal(queued);
    expect(JSON.parse(readFileSync(join(dir, "budget.json"), "utf8")).spent).to.equal("15000");
  });

  it("does not charge for a call that fails (an address the tool cannot read) and says nothing was paid", async () => {
    const before = (await s.router.payerBalance(owner.address)) as bigint;
    await s.facilitator.flush();
    const r = await call("token_risk_check", { address: "not-an-address" });
    expect(r.isError).to.equal(true);
    expect(await s.facilitator.flush()).to.include({ submitted: 0 });
    expect((await s.router.payerBalance(owner.address)) as bigint).to.equal(before);
  });

  it("the wallet MCP, started as its own process, reads the same budget, history and chain", async () => {
    const wallet = await connectStdio("packages/wallet-mcp/src/cli.ts", ["--config", configPath], { SLUICE_AGENT_KEY: agent.privateKey });
    clients.push(wallet);
    const tools = (await wallet.listTools()).tools.map((t) => t.name).sort();
    expect(tools).to.deep.equal(["balance", "budget_status", "deposit_instructions", "pay_history", "price_check"]);

    const budget = ((await wallet.callTool({ name: "budget_status", arguments: {} })) as Reply).structuredContent!;
    expect(budget.local).to.deep.include({ spent: "0.015000", remaining: "0.485000", payments: 2 });
    expect(budget.chain).to.deep.include({ budget: "0.500000", spent: "0.015000", remaining: "0.485000" });
    expect(budget.warnings).to.deep.equal([]);

    const balance = ((await wallet.callTool({ name: "balance", arguments: {} })) as Reply).structuredContent!;
    expect(balance).to.deep.include({ account: owner.address, prepaid: "4.985000", agent: agent.address });

    const history = ((await wallet.callTool({ name: "pay_history", arguments: {} })) as Reply).structuredContent!;
    // Two payments and the refusal of dex_quote. The call that failed validation never reached payment, so it is not logged.
    expect(history.local.map((e: { event: string }) => e.event)).to.deep.equal(["paid", "paid", "refused"]);
    expect(history.chain.rows.map((x: { amount: string }) => x.amount)).to.deep.equal(["0.005000", "0.010000"]); // newest first

    const price = ((await wallet.callTool({ name: "price_check", arguments: { tool: "contract_lookup", arguments: { address: roleToken } } })) as Reply).structuredContent!;
    expect(price.authoritative.accepts[0]).to.deep.include({ price: "0.005000", payTo: builder.address });
    expect(price.wouldPay).to.deep.equal({ allowed: true, price: "0.005000" });
    expect(((await s.router.payerBalance(owner.address)) as bigint), "price_check paid nothing").to.equal(USDC("4.985"));
  });

  it("the wallet MCP will not start with the owner's key", async () => {
    let started = true;
    try {
      const c = await connectStdio("packages/wallet-mcp/src/cli.ts", ["--config", configPath], { SLUICE_AGENT_KEY: owner.privateKey });
      clients.push(c);
    } catch {
      started = false;
    }
    expect(started).to.equal(false);
  });

  it("the proxy will not start with the owner's key either", async () => {
    let started = true;
    try {
      clients.push(await connectStdio("packages/proxy/src/cli.ts", ["--config", configPath], { SLUICE_AGENT_KEY: owner.privateKey }));
    } catch {
      started = false;
    }
    expect(started).to.equal(false);
  });

  it("does not hand its session key to the upstream process", async () => {
    const fixture = tsCommand("test/helpers/fixtures/env-echo-server.ts");
    const echoConfig = join(dir, "echo.config.json");
    writeFileSync(
      echoConfig,
      JSON.stringify({
        upstream: { command: fixture.command, args: fixture.args, cwd: ROOT },
        router: s.routerAddress,
        payer: owner.address,
        asset: s.tokenAddress,
        budget: { perCallCap: "0.01", totalCap: "0.1", expiresAt: new Date((s.clock() + 3600) * 1000).toISOString(), allowedTools: [{ tool: "env_names", payee: builder.address }] },
        logFile: "echo.jsonl",
        stateFile: "echo-budget.json",
      }),
    );
    const c = await connectStdio("packages/proxy/src/cli.ts", ["--config", echoConfig], { SLUICE_AGENT_KEY: agent.privateKey });
    clients.push(c);
    const names = JSON.parse(((await c.callTool({ name: "env_names", arguments: {} })) as Reply).content[0]!.text!) as string[];
    expect(names.length).to.be.greaterThan(0);
    expect(names).to.not.include("SLUICE_AGENT_KEY");
    expect(names.join(" ")).to.not.match(/KEY|SECRET|SLUICE_CONFIG/);
  });

  it("the proxy refuses to start with no key, or a key written wrongly, and says what to set", async () => {
    for (const bad of ["", "0x1234", "not-a-key"]) {
      let started = true;
      try {
        clients.push(await connectStdio("packages/proxy/src/cli.ts", ["--config", configPath], { SLUICE_AGENT_KEY: bad }));
      } catch {
        started = false;
      }
      expect(started, JSON.stringify(bad.length)).to.equal(false);
    }
    expect(new Wallet(agent.privateKey).address).to.equal(agent.address);
  });
});

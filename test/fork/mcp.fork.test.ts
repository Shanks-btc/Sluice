// The MCP payment layer against a local fork of QIE mainnet, with the REAL QUSDC. Nothing is sent to QIE: the fork lives in
// this process, the keys are generated here, and QUSDC is minted on the fork only, by impersonating QUSDC's own vault.
//
// What this proves that the unit tests cannot: a wallet that holds real QUSDC and zero QIE can start, because the real
// token has no permit and no EIP-3009; a paid call settles through the real token; and a builder with no QIE can leave.
import { expect } from "chai";
import { Wallet } from "ethers";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  FacilitatorClient, ONBOARD_APPROVE_GAS, ONBOARD_DEPOSIT_GAS, createPaywall, serveMcpHttp, signAuthorize, signOnboarding, toolIdOf,
} from "@sluice/sdk";
import { PaymentProxy, parseConfig } from "@sluice/proxy";
import type { ProxyConfig, UpstreamClient } from "@sluice/proxy";
import { ChainReader, createWalletServer } from "@sluice/wallet-mcp";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { main as summaryMain } from "../../scripts/evidence-summary";
import { randomNonce, routerDomain, USDC, withdrawTypes } from "../helpers";
import { QUSDC } from "../helpers/fork";
import { fundWallet, startStack, throwawayWallet } from "../helpers/stack";
import type { Stack } from "../helpers/stack";

describe("Fork: the MCP payment layer with the real QUSDC", function () {
  this.timeout(900_000);

  let s: Stack;
  let owner: Wallet;
  let agent: Wallet;
  let builder: Wallet;
  let upstream: Client;
  let closeServer: () => Promise<void>;
  let proxy: PaymentProxy;
  let proxyConfig: ProxyConfig;
  let deployBlock: number;
  let measured: { approveGas: bigint; depositGas: bigint; topUpWei: bigint; gasPrice: bigint };

  before(async () => {
    s = await startStack({ fork: true });
    expect(s.tokenAddress.toLowerCase(), "the router holds the real QUSDC").to.equal(QUSDC.toLowerCase());
    deployBlock = await s.provider.getBlockNumber(); // the router was deployed at or just before this block
    owner = throwawayWallet();
    agent = throwawayWallet();
    builder = throwawayWallet();
  });
  after(async () => {
    await upstream?.close();
    await closeServer?.();
    await s.stop();
  });

  it("starts a wallet that holds real QUSDC and zero QIE: it signs two transactions and the facilitator sends them", async () => {
    await fundWallet(s, owner, USDC("12")); // real QUSDC, minted on the fork only
    expect(await s.provider.getBalance(owner.address)).to.equal(0n);
    expect(await s.token.balanceOf(owner.address)).to.equal(USDC("12"));

    const gasPrice = (await s.provider.getFeeData()).gasPrice as bigint;
    const { approveTx, depositTx } = await signOnboarding(owner, { router: s.routerAddress, amount: USDC("10"), nonce: 0, gasPrice });
    const out = await new FacilitatorClient({ url: s.facilitatorUrl }).onboard({ payer: owner.address, approveTx, depositTx });
    expect(out.ok, out.detail).to.equal(true);

    expect(await s.router.payerBalance(owner.address)).to.equal(USDC("10"));
    expect(await s.token.allowance(owner.address, s.routerAddress)).to.equal(0n);
    expect(await s.token.balanceOf(owner.address)).to.equal(USDC("2"));

    const [approveReceipt, depositReceipt] = await Promise.all([s.provider.getTransactionReceipt(out.approveTx as string), s.provider.getTransactionReceipt(out.depositTx as string)]);
    measured = { approveGas: approveReceipt!.gasUsed, depositGas: depositReceipt!.gasUsed, topUpWei: BigInt(out.topUpWei as string), gasPrice };
    // The signed gas limits cover what the real token and the real router used, with the unused part refunded.
    expect(measured.approveGas <= ONBOARD_APPROVE_GAS).to.equal(true);
    expect(measured.depositGas <= ONBOARD_DEPOSIT_GAS).to.equal(true);
    expect(measured.topUpWei).to.equal((ONBOARD_APPROVE_GAS + ONBOARD_DEPOSIT_GAS) * gasPrice);
    expect(await s.token.balanceOf(s.relayerAddress), "the relayer never held QUSDC").to.equal(0n);
    // eslint-disable-next-line no-console
    console.log(`      measured on the fork: approve ${measured.approveGas} gas, first deposit ${measured.depositGas} gas, top-up ${measured.topUpWei} wei at ${gasPrice} wei per gas`);
  });

  it("authorises an agent with the owner's signature alone, then pays a tool through the proxy, and the facilitator settles it", async () => {
    const facilitator = new FacilitatorClient({ url: s.facilitatorUrl });
    const tools = [{ payee: builder.address, toolId: toolIdOf("echo") }];
    const grant = { agent: agent.address, budget: USDC("1"), perCallCap: USDC("0.05"), expiry: BigInt(s.clock() + 86_400) };
    const deadline = BigInt(s.clock() + 600);
    const signature = await signAuthorize(owner, s.vaultAddress, { payer: owner.address, grant, tools, nonce: 0n, deadline });
    const authorised = await facilitator.relay({
      kind: "authorize", payer: owner.address, tools, deadline: deadline.toString(), signature,
      grant: { agent: agent.address, budget: grant.budget.toString(), perCallCap: grant.perCallCap.toString(), expiry: grant.expiry.toString() },
    });
    expect(authorised.ok, authorised.detail).to.equal(true);

    const paywall = createPaywall({ facilitator, router: s.routerAddress, vault: s.vaultAddress, now: s.clock }); // QUSDC is the default asset
    const served = await serveMcpHttp(async () => {
      const server = new McpServer({ name: "fork-paid", version: "0" });
      await paywall.registerPaidTool(server, { name: "echo", price: "0.01", payee: builder.address, inputSchema: { text: z.string() } }, async (a: { text: string }) => ({
        content: [{ type: "text", text: `echo:${a.text}` }],
      }));
      return server;
    });
    closeServer = () => new Promise<void>((resolve) => served.server.close(() => resolve()));
    upstream = new Client({ name: "fork-upstream", version: "0" });
    await upstream.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${served.port}/mcp`)));

    const config = parseConfig(
      {
        upstream: { url: `http://127.0.0.1:${served.port}/mcp` },
        router: s.routerAddress,
        payer: owner.address,
        budget: { perCallCap: "0.05", totalCap: "1", expiresAt: new Date(Number(grant.expiry) * 1000).toISOString(), allowedTools: [{ tool: "echo", payee: builder.address }] },
      },
      s.clock(),
      mkdtempSync(join(tmpdir(), "sluice-fork-")),
    );
    proxyConfig = config;
    proxy = new PaymentProxy({ config, signer: agent, upstream: upstream as unknown as UpstreamClient, now: s.clock });

    const r = await proxy.callTool({ name: "echo", arguments: { text: "real-qusdc" } });
    expect(r.isError).to.not.equal(true);
    expect(r.content[0]?.text).to.equal("echo:real-qusdc");
    const report = await s.facilitator.flush();
    expect(report).to.include({ submitted: 1, settled: 1 });
    expect(await s.router.payerBalance(owner.address)).to.equal(USDC("10") - USDC("0.01"));
    expect(await s.router.earnings(builder.address)).to.equal(USDC("0.01") - USDC("0.01") / 100n);
    // Settling moved no QUSDC: the real token's balance of the router is unchanged.
    const [held, owed] = (await s.router.solvency()) as [bigint, bigint];
    expect(held >= owed).to.equal(true);
  });

  it("the wallet MCP reads the owner's real-QUSDC balance, the agent's session and the paid call from the fork", async () => {
    const chain = await ChainReader.connect(s.provider, s.routerAddress);
    expect(chain.tokenAddress.toLowerCase()).to.equal(QUSDC.toLowerCase());
    const server = createWalletServer({ config: proxyConfig, chain, agent: agent.address, now: s.clock });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const client = new Client({ name: "fork-agent", version: "0" });
    await client.connect(a);
    try {
      const balance = ((await client.callTool({ name: "balance", arguments: {} })) as { structuredContent: Record<string, any> }).structuredContent;
      expect(balance).to.deep.include({ account: owner.address, token: s.tokenAddress, prepaid: "9.990000", wallet: "2.000000", agent: agent.address });
      expect(balance.session).to.deep.include({ active: true, budget: "1.000000", spent: "0.010000", remaining: "0.990000" });
      const budget = ((await client.callTool({ name: "budget_status", arguments: {} })) as { structuredContent: Record<string, any> }).structuredContent;
      expect(budget.local).to.deep.include({ spent: "0.010000", payments: 1 });
      expect(budget.chain).to.deep.include({ spent: "0.010000" });
      expect(budget.warnings).to.deep.equal([]);
      const history = ((await client.callTool({ name: "pay_history", arguments: { source: "chain" } })) as { structuredContent: Record<string, any> }).structuredContent;
      expect(history.chain.rows).to.have.length(1);
      expect(history.chain.rows[0]).to.deep.include({ amount: "0.010000", payee: builder.address, signer: agent.address });
    } finally {
      await client.close();
    }
  });

  it("the paid-call summary counts the settled call, and leaves it out once its payer is on the founder list", async () => {
    const lines: string[] = [];
    const env = { SLUICE_ROUTER: s.routerAddress, SLUICE_FROM_BLOCK: String(deployBlock), EVIDENCE_RPC_URL: s.rpcUrl };
    expect(await summaryMain(env, (l) => lines.push(l))).to.equal(0);
    const out = lines.join("\n");
    expect(out).to.contain("Settled events found: 1");
    expect(out).to.contain("paid calls counted: 1");
    expect(out).to.contain("distinct payers: 1");
    expect(out).to.contain("distinct builders: 1");
    const founderList = JSON.stringify({
      version: 2, updated: "2026-11-19", description: "a test list",
      wallets: [{ address: owner.address, label: "test founder" }],
      history: [{ version: 1, date: "2026-11-19", note: "created" }, { version: 2, date: "2026-11-19", note: "test" }],
    });
    const filtered: string[] = [];
    expect(await summaryMain(env, (l) => filtered.push(l), undefined, founderList)).to.equal(0);
    expect(filtered.join("\n")).to.contain("paid calls counted: 0");
    expect(filtered.join("\n")).to.contain("left out as founder wallets: 1");
  });

  it("lets the builder, who holds no QIE, take the earnings out as real QUSDC through the facilitator", async () => {
    expect(await s.provider.getBalance(builder.address)).to.equal(0n);
    const earned = (await s.router.earnings(builder.address)) as bigint;
    const dest = throwawayWallet().address;
    const message = { account: builder.address, to: dest, amount: earned, relayerFee: 0n, nonce: randomNonce(), deadline: BigInt(s.clock() + 600) };
    const signature = await builder.signTypedData(routerDomain(s.routerAddress), withdrawTypes, message);
    const out = await new FacilitatorClient({ url: s.facilitatorUrl }).relay({
      kind: "withdraw", account: builder.address, to: dest, amount: earned.toString(), nonce: message.nonce, deadline: message.deadline.toString(), signature,
    });
    expect(out.ok, out.detail).to.equal(true);
    expect(await s.token.balanceOf(dest)).to.equal(earned);
    expect(await s.token.balanceOf(s.relayerAddress), "the relayer never held QUSDC").to.equal(0n);
  });

  it("keeps the relayer inside its caps while doing all of this, and reports no alert it should not", async () => {
    const health = await s.facilitator.health();
    expect(health.relayerQusdcUnits).to.equal("0");
    const b = s.facilitator.relayer.budget();
    expect(b.spentWei > 0n).to.equal(true);
    expect(b.spentWei + b.reservedWei <= b.budgetWei).to.equal(true);
    expect(s.facilitator.relayer.alerts).to.deep.equal([]); // well under half of the day's budget
    expect(measured.approveGas > 0n).to.equal(true);
  });
});

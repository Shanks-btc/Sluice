// The scenario the remote-hosting tests run, once on the local chain (test/unit/e2e/remote.test.ts) and once on the fork of QIE mainnet
// with the real QUSDC (test/fork/remote.fork.test.ts): an agent behind the payment proxy calls a tool server that is its own process and
// reached over HTTP, which verifies and settles through a facilitator that is its own process. Every refusal of the proxy still holds.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";
import { id, parseEther } from "ethers";
import { ethers } from "hardhat";
import { PAYMENT_RESPONSE_META_KEY } from "@sluice/sdk";
import { deployContract, USDC } from "./index";
import { fakeExplorer, serveExplorer } from "./explorer";
import { startDeployment } from "./remote";
import type { Deployment } from "./remote";
import type { Stack } from "./stack";
import { setQie } from "./stack";

type Reply = { isError?: boolean; structuredContent?: Record<string, any>; content: Array<{ type: string; text?: string }>; _meta?: Record<string, any> };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls the facilitator process's /status until the intent is settled (its own timer sends the batch). */
export async function settled(d: Deployment, intentId: string, ms = 60_000): Promise<{ status: string; transaction?: string; reason?: string }> {
  const end = Date.now() + ms;
  let last: { status: string; transaction?: string; reason?: string } = { status: "unknown" };
  while (Date.now() < end) {
    last = (await (await fetch(`${d.facilitatorUrl}/status/${intentId}`)).json()) as typeof last;
    if (last.status === "settled" || last.status === "skipped" || last.status === "failed") return last;
    await sleep(200);
  }
  return last;
}

export async function runRemoteScenario(stack: Stack, roleTokenHolder?: { token: string }): Promise<void> {
  // A token for the paid risk check to read. On the local chain it is a test token with an admin that can burn.
  let target: string;
  if (roleTokenHolder) {
    target = roleTokenHolder.token;
  } else {
    const [admin, tokenOwner] = await ethers.getSigners();
    const token = await deployContract("RoleToken", [admin!.address, tokenOwner!.address]);
    await (await token.connect(admin!).grantRole(id("VAULT_ROLE"), tokenOwner!.address)).wait();
    target = await token.getAddress();
  }
  const explorer = await serveExplorer(fakeExplorer(ethers.provider));
  // Three tools are allowed; the third's price is above the per-call cap on purpose, so the proxy must refuse it.
  const d = await startDeployment(stack, {
    explorerUrl: explorer.url,
    tools: { SLUICE_TOOLS_PRICES: "dex_quote=0.05" },
    budget: { perCallCap: "0.02", totalCap: "0.02", allowed: ["token_risk_check", "contract_lookup", "dex_quote"] },
  });
  try {
    const call = (name: string, args: Record<string, unknown>) => d.agentClient.callTool({ name, arguments: args }) as Promise<Reply>;

    // 1. The proxy reaches the tool server over HTTP and sees its tools.
    expect((await d.agentClient.listTools()).tools.map((t) => t.name).sort()).to.deep.equal(["contract_lookup", "dex_quote", "token_risk_check"]);
    const health = (await (await fetch(`${d.tools.url}/health`)).json()) as { network: string; tools: Array<{ name: string; price: string }> };
    expect(health.network).to.equal("local");
    expect(health.tools.find((t) => t.name === "dex_quote")?.price).to.equal("0.05");

    // 2. A paid call: the proxy pays inside the owner's budget, the remote server answers, the remote facilitator settles it.
    const before = (await stack.router.payerBalance(d.owner.address)) as bigint;
    const first = await call("contract_lookup", { address: target });
    expect(first.isError, JSON.stringify(first.content)).to.not.equal(true);
    expect(first.structuredContent).to.deep.include({ isContract: true });
    const settlement = first._meta![PAYMENT_RESPONSE_META_KEY];
    expect(settlement).to.deep.include({ success: true, payer: d.owner.address });
    const done = await settled(d, settlement.extensions.sluice.id as string);
    expect(done.status, JSON.stringify(done)).to.equal("settled");
    expect(done.transaction).to.match(/^0x[0-9a-f]{64}$/);
    expect((await stack.router.payerBalance(d.owner.address)) as bigint).to.equal(before - USDC("0.005"));
    expect((await stack.router.earnings(d.builder.address)) as bigint).to.be.greaterThan(0n);
    expect(await stack.token.balanceOf(await new (await import("ethers")).Wallet(d.agent.privateKey).getAddress()), "the agent key holds no QUSDC").to.equal(0n);

    // 3. A tool priced above the per-call cap is refused by the proxy, and nothing is signed or sent for it.
    const queuedBefore = (await (await fetch(`${d.facilitatorUrl}/health`)).json()) as { queued: number };
    const dear = await call("dex_quote", { tokenIn: "QIE", tokenOut: target, amountIn: "1" });
    expect(dear.isError).to.equal(true);
    expect(dear.structuredContent).to.deep.include({ error: "sluice_proxy_refused" });
    expect(((await (await fetch(`${d.facilitatorUrl}/health`)).json()) as { queued: number }).queued).to.equal(queuedBefore.queued);

    // 4. The total budget is kept exactly: 0.005 of 0.02 is spent, three more calls fit (0.020 in all), the next is refused. The calls come
    //    faster than the facilitator sends batches, so this also holds the facilitator to counting a payment once, not twice, while its batch is
    //    mined and not yet recorded.
    for (let i = 0; i < 3; i++) {
      const r = await call("contract_lookup", { address: target });
      expect(r.isError, `call ${i}: ${JSON.stringify(r.structuredContent ?? r.content)}`).to.not.equal(true);
    }
    const over = await call("contract_lookup", { address: target });
    expect(over.isError).to.equal(true);
    expect(over.structuredContent).to.deep.include({ error: "sluice_proxy_refused" });
    expect(JSON.parse(readFileSync(join(d.dir, "budget.json"), "utf8"))).to.deep.equal({ spent: "20000", count: 4 });

    // 5. A call with no payment, straight to the tool server over HTTP, is answered with the price and nothing is charged.
    const direct = await fetch(`${d.tools.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "contract_lookup", arguments: { address: target } } }),
    });
    expect(direct.status).to.equal(200);
    expect(((await direct.json()) as { result: { isError: boolean; structuredContent: { accepts: Array<{ amount: string }> } } }).result.structuredContent.accepts[0]?.amount).to.equal("5000");

    // 6. The tool server's own log holds no signature and no payment, and nothing a key looks like.
    await sleep(300);
    const log = d.tools.lines.join("\n");
    expect(log).to.contain("tools/call");
    expect(log).to.not.match(/"signature"|authorization|privateKey|0x[0-9a-f]{130}/i);
    expect(log).to.not.contain(d.agent.privateKey);
    void parseEther;
    void setQie;
  } finally {
    await d.stop();
    await explorer.close();
  }
}

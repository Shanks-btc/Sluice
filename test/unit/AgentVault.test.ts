import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import {
  authorizeTypes,
  deploy,
  fundBalance,
  newIntent,
  nowSeconds,
  randomNonce,
  revokeTypes,
  signedIntent,
  toolId,
  USDC,
  vaultDomain,
} from "../helpers";
import type { Grant, Intent, Tool, TypedSigner, World } from "../helpers";

const WEATHER = toolId("weather");
const TRANSLATE = toolId("translate");

async function session(w: World, over: Partial<Grant> = {}, tools?: Tool[]) {
  const agent = ethers.Wallet.createRandom(); // an agent key: it only signs and never holds QIE
  const grant: Grant = {
    agent: agent.address,
    budget: USDC(5),
    perCallCap: USDC(1),
    expiry: (await nowSeconds()) + 3600n,
    ...over,
  };
  const list = tools ?? [{ payee: w.builder.address, toolId: WEATHER }];
  return { agent, grant, tools: list };
}

async function authorized(feeBps = 100, over: Partial<Grant> = {}, tools?: Tool[]) {
  const w = await deploy({ feeBps });
  await fundBalance(w, w.payer, USDC(20));
  const s = await session(w, over, tools);
  await w.vault.connect(w.payer).authorize(s.grant, s.tools);
  return { w, ...s };
}

const agentPays = (
  w: World,
  agent: TypedSigner,
  amount: bigint,
  over: { payee?: string; toolId?: string; payer?: string; deadline?: bigint } = {},
) => {
  const extra: Partial<Intent> = { toolId: over.toolId ?? WEATHER };
  if (over.deadline !== undefined) extra.deadline = over.deadline;
  return signedIntent(w, agent, over.payer ?? w.payer.address, over.payee ?? w.builder.address, amount, extra);
};

describe("AgentVault: authorising a session", () => {
  it("stores the policy, counts the session and emits an event", async () => {
    const w = await deploy();
    const s = await session(w);
    const toolsHash = await w.vault.hashTools(s.tools);
    await expect(w.vault.connect(w.payer).authorize(s.grant, s.tools))
      .to.emit(w.vault, "SessionAuthorized")
      .withArgs(w.payer.address, s.agent.address, 1, s.grant.budget, s.grant.perCallCap, s.grant.expiry, toolsHash);
    const stored = await w.vault.sessionOf(w.payer.address, s.agent.address);
    expect(stored.budget).to.equal(s.grant.budget);
    expect(stored.spent).to.equal(0);
    expect(stored.perCallCap).to.equal(s.grant.perCallCap);
    expect(stored.expiry).to.equal(s.grant.expiry);
    expect(stored.id).to.equal(1);
    expect(await w.vault.sessionCount()).to.equal(1);
    expect(await w.vault.remainingBudget(w.payer.address, s.agent.address)).to.equal(s.grant.budget);
  });

  it("allows only the listed (builder, tool) pairs, and bytes32(0) as a wildcard for one builder's tools", async () => {
    const w = await deploy();
    const s = await session(w, {}, [
      { payee: w.builder.address, toolId: WEATHER },
      { payee: w.other.address, toolId: ethers.ZeroHash },
    ]);
    await w.vault.connect(w.payer).authorize(s.grant, s.tools);
    const allowed = (payee: string, tool: string) => w.vault.isToolAllowed(w.payer.address, s.agent.address, payee, tool);
    expect(await allowed(w.builder.address, WEATHER)).to.equal(true);
    expect(await allowed(w.builder.address, TRANSLATE)).to.equal(false);
    expect(await allowed(w.stranger.address, WEATHER)).to.equal(false);
    expect(await allowed(w.other.address, WEATHER)).to.equal(true);
    expect(await allowed(w.other.address, TRANSLATE)).to.equal(true);
  });

  it("reports no session and no allowed tools for an agent that was never authorised", async () => {
    const w = await deploy();
    const nobody = ethers.Wallet.createRandom();
    expect(await w.vault.remainingBudget(w.payer.address, nobody.address)).to.equal(0);
    expect(await w.vault.isToolAllowed(w.payer.address, nobody.address, w.builder.address, WEATHER)).to.equal(false);
    expect((await w.vault.sessionOf(w.payer.address, nobody.address)).id).to.equal(0);
  });

  it("refuses bad parameters", async () => {
    const w = await deploy();
    const base = await session(w);
    const refuses = (error: string, grant: Partial<Grant>, tools: Tool[] = base.tools) =>
      expect(w.vault.connect(w.payer).authorize({ ...base.grant, ...grant }, tools)).to.be.revertedWithCustomError(
        w.vault,
        error,
      );
    await refuses("InvalidSession", { agent: ethers.ZeroAddress });
    await refuses("InvalidSession", { agent: w.payer.address });
    await refuses("InvalidSession", { budget: 0n });
    await refuses("InvalidSession", { budget: 2n ** 128n });
    await refuses("InvalidSession", { perCallCap: 0n });
    await refuses("InvalidSession", { perCallCap: base.grant.budget + 1n });
    await refuses("InvalidSession", { expiry: await nowSeconds() });
    await refuses("InvalidSession", { expiry: 2n ** 64n });
    await refuses("EmptyToolList", {}, []);
    const tooMany = Array.from({ length: 33 }, (_, i) => ({ payee: w.builder.address, toolId: toolId(`t${i}`) }));
    await refuses("TooManyTools", {}, tooMany);
    await refuses("ZeroAddress", {}, [{ payee: ethers.ZeroAddress, toolId: WEATHER }]);
    // The limit is 32 and a cap equal to the budget is fine.
    const thirtyTwo = tooMany.slice(0, 32);
    await w.vault.connect(w.payer).authorize({ ...base.grant, perCallCap: base.grant.budget }, thirtyTwo);
  });

  it("re-authorising an agent starts a new session: spent resets and the old tool list is gone", async () => {
    const { w, agent, grant } = await authorized();
    const first = await agentPays(w, agent, USDC(1));
    await w.router.settle(first.intent, first.signature);
    expect(await w.vault.remainingBudget(w.payer.address, agent.address)).to.equal(USDC(4));
    await w.vault.connect(w.payer).authorize(grant, [{ payee: w.other.address, toolId: TRANSLATE }]);
    expect((await w.vault.sessionOf(w.payer.address, agent.address)).id).to.equal(2);
    expect(await w.vault.remainingBudget(w.payer.address, agent.address)).to.equal(USDC(5));
    const old = await agentPays(w, agent, USDC(1));
    await expect(w.router.settle(old.intent, old.signature)).to.be.revertedWithCustomError(w.router, "ToolNotAllowed");
    const fresh = await agentPays(w, agent, USDC(1), { payee: w.other.address, toolId: TRANSLATE });
    await w.router.settle(fresh.intent, fresh.signature);
  });
});

describe("AgentVault: authorising by signature, for a payer who holds no QIE", () => {
  async function setup() {
    const w = await deploy();
    const payer = ethers.Wallet.createRandom(); // never funded: it only signs
    await w.token.mint(w.other.address, USDC(10));
    await w.token.connect(w.other).approve(w.routerAddress, USDC(10));
    await w.router.connect(w.other).depositFor(payer.address, USDC(10));
    const s = await session(w);
    const deadline = (await nowSeconds()) + 3600n;
    const value = async (nonce?: bigint) => ({
      payer: payer.address,
      agent: s.grant.agent,
      budget: s.grant.budget,
      perCallCap: s.grant.perCallCap,
      expiry: s.grant.expiry,
      tools: s.tools,
      nonce: nonce ?? (await w.vault.nonces(payer.address)),
      deadline,
    });
    const sign = async (over: Record<string, unknown> = {}) =>
      payer.signTypedData(vaultDomain(w.vaultAddress), authorizeTypes, { ...(await value()), ...over });
    return { w, payer, s, deadline, value, sign };
  }

  it("hashes an authorisation exactly as ethers does", async () => {
    const { w, payer, s, deadline, value } = await setup();
    expect(await w.vault.hashAuthorization(payer.address, s.grant, s.tools, deadline)).to.equal(
      ethers.TypedDataEncoder.hash(vaultDomain(w.vaultAddress), authorizeTypes, await value()),
    );
    expect(await w.vault.domainSeparator()).to.equal(ethers.TypedDataEncoder.hashDomain(vaultDomain(w.vaultAddress)));
  });

  it("lets a relayer submit it, bumps the payer's nonce, and the agent can then spend", async () => {
    const { w, payer, s, deadline, sign } = await setup();
    const signature = await sign();
    await expect(w.vault.connect(w.relayer).authorizeBySig(payer.address, s.grant, s.tools, deadline, signature)).to.emit(
      w.vault,
      "SessionAuthorized",
    );
    expect(await w.vault.nonces(payer.address)).to.equal(1);
    expect(await ethers.provider.getBalance(payer.address)).to.equal(0);
    const item = await agentPays(w, s.agent, USDC(1), { payer: payer.address });
    await w.router.settle(item.intent, item.signature);
    expect(await w.router.payerBalance(payer.address)).to.equal(USDC(9));
  });

  it("cannot be replayed, and refuses an expired, forged or altered authorisation", async () => {
    const { w, payer, s, deadline, sign } = await setup();
    const signature = await sign();
    await w.vault.authorizeBySig(payer.address, s.grant, s.tools, deadline, signature);
    await expect(w.vault.authorizeBySig(payer.address, s.grant, s.tools, deadline, signature)).to.be.revertedWithCustomError(
      w.vault,
      "InvalidSignature",
    );
    const fresh = await sign();
    await expect(
      w.vault.authorizeBySig(payer.address, s.grant, s.tools, (await nowSeconds()) - 1n, fresh),
    ).to.be.revertedWithCustomError(w.vault, "Expired");
    const forged = await ethers.Wallet.createRandom().signTypedData(vaultDomain(w.vaultAddress), authorizeTypes, {
      payer: payer.address,
      agent: s.grant.agent,
      budget: s.grant.budget,
      perCallCap: s.grant.perCallCap,
      expiry: s.grant.expiry,
      tools: s.tools,
      nonce: 1,
      deadline,
    });
    await expect(w.vault.authorizeBySig(payer.address, s.grant, s.tools, deadline, forged)).to.be.revertedWithCustomError(
      w.vault,
      "InvalidSignature",
    );
    const valid = await sign({ nonce: 1n });
    const bigger = { ...s.grant, budget: s.grant.budget * 2n };
    await expect(w.vault.authorizeBySig(payer.address, bigger, s.tools, deadline, valid)).to.be.revertedWithCustomError(
      w.vault,
      "InvalidSignature",
    );
    const moreTools = [...s.tools, { payee: w.other.address, toolId: TRANSLATE }];
    await expect(w.vault.authorizeBySig(payer.address, s.grant, moreTools, deadline, valid)).to.be.revertedWithCustomError(
      w.vault,
      "InvalidSignature",
    );
    await expect(w.vault.authorizeBySig(payer.address, s.grant, s.tools, deadline, "0x1234")).to.be.revertedWithCustomError(
      w.vault,
      "InvalidSignature",
    );
  });

  it("refuses a signature made for another vault or another chain", async () => {
    const { w, payer, s, deadline, value } = await setup();
    const other = await deploy();
    const v = await value();
    const wrongVault = await payer.signTypedData(vaultDomain(other.vaultAddress), authorizeTypes, v);
    const wrongChain = await payer.signTypedData(vaultDomain(w.vaultAddress, 1), authorizeTypes, v);
    for (const bad of [wrongVault, wrongChain]) {
      await expect(w.vault.authorizeBySig(payer.address, s.grant, s.tools, deadline, bad)).to.be.revertedWithCustomError(
        w.vault,
        "InvalidSignature",
      );
    }
  });

  it("applies the same parameter rules to a signed authorisation", async () => {
    const { w, payer, s, deadline, value } = await setup();
    const bad = { ...s.grant, perCallCap: 0n };
    const signature = await payer.signTypedData(vaultDomain(w.vaultAddress), authorizeTypes, { ...(await value()), perCallCap: 0n });
    await expect(w.vault.authorizeBySig(payer.address, bad, s.tools, deadline, signature)).to.be.revertedWithCustomError(
      w.vault,
      "InvalidSession",
    );
  });
});

describe("AgentVault: what an agent can spend", () => {
  it("settles an agent-signed intent against the payer's prepaid balance and tracks the spend", async () => {
    const { w, agent } = await authorized(100);
    const item = await agentPays(w, agent, USDC(1));
    await expect(w.router.settle(item.intent, item.signature))
      .to.emit(w.router, "Settled")
      .withArgs(w.payer.address, w.builder.address, WEATHER, USDC(1), USDC("0.01"), item.intent.nonce, agent.address);
    const half = await agentPays(w, agent, USDC("0.5"));
    await expect(w.router.settle(half.intent, half.signature)).to.emit(w.vault, "SessionSpent");
    expect(await w.vault.remainingBudget(w.payer.address, agent.address)).to.equal(USDC("3.5"));
    expect(await w.router.payerBalance(w.payer.address)).to.equal(USDC("18.5"));
  });

  it("allows a call exactly at the per-call cap and refuses one unit above it", async () => {
    const { w, agent } = await authorized();
    const atCap = await agentPays(w, agent, USDC(1));
    await w.router.settle(atCap.intent, atCap.signature);
    const above = await agentPays(w, agent, USDC(1) + 1n);
    await expect(w.router.settle(above.intent, above.signature)).to.be.revertedWithCustomError(w.router, "PerCallCapExceeded");
    expect(await w.router.nonceUsed(w.payer.address, above.intent.nonce)).to.equal(false);
    expect(await w.vault.remainingBudget(w.payer.address, agent.address)).to.equal(USDC(4)); // the refusal spent nothing
  });

  it("refuses a call that would take the total spent above the budget, and allows spending it exactly", async () => {
    const { w, agent } = await authorized(100, { budget: USDC(3), perCallCap: USDC(2) });
    const a = await agentPays(w, agent, USDC(2));
    await w.router.settle(a.intent, a.signature);
    const over = await agentPays(w, agent, USDC("1.000001"));
    await expect(w.router.settle(over.intent, over.signature)).to.be.revertedWithCustomError(w.router, "BudgetExceeded");
    const exact = await agentPays(w, agent, USDC(1));
    await w.router.settle(exact.intent, exact.signature);
    expect(await w.vault.remainingBudget(w.payer.address, agent.address)).to.equal(0);
    const none = await agentPays(w, agent, 1n);
    await expect(w.router.settle(none.intent, none.signature)).to.be.revertedWithCustomError(w.router, "BudgetExceeded");
  });

  it("refuses after the session expires, and not before", async () => {
    const { w, agent, grant } = await authorized();
    const deadline = grant.expiry + 1000n; // the intent itself stays valid past the session's expiry
    const atExpiry = await agentPays(w, agent, USDC("0.1"), { deadline });
    const afterExpiry = await agentPays(w, agent, USDC("0.1"), { deadline });
    await time.setNextBlockTimestamp(grant.expiry); // timestamp == expiry is still allowed
    await w.router.settle(atExpiry.intent, atExpiry.signature);
    await time.setNextBlockTimestamp(grant.expiry + 1n);
    await expect(w.router.settle(afterExpiry.intent, afterExpiry.signature)).to.be.revertedWithCustomError(
      w.router,
      "SessionExpired",
    );
    expect(await w.router.nonceUsed(w.payer.address, afterExpiry.intent.nonce)).to.equal(false);
  });

  it("refuses a tool, or a builder, the payer did not list", async () => {
    const { w, agent } = await authorized();
    const wrongTool = await agentPays(w, agent, USDC("0.5"), { toolId: TRANSLATE });
    await expect(w.router.settle(wrongTool.intent, wrongTool.signature)).to.be.revertedWithCustomError(w.router, "ToolNotAllowed");
    // The agent cannot redirect the budget to itself or to an accomplice.
    const redirected = await agentPays(w, agent, USDC("0.5"), { payee: w.stranger.address });
    await expect(w.router.settle(redirected.intent, redirected.signature)).to.be.revertedWithCustomError(w.router, "ToolNotAllowed");
    expect(await w.router.earnings(w.stranger.address)).to.equal(0);
  });

  it("allows any tool of a builder when the payer listed the wildcard", async () => {
    const w = await deploy();
    await fundBalance(w, w.payer, USDC(5));
    const s = await session(w, {}, [{ payee: w.builder.address, toolId: ethers.ZeroHash }]);
    await w.vault.connect(w.payer).authorize(s.grant, s.tools);
    for (const name of ["a", "b", "c"]) {
      const item = await agentPays(w, s.agent, USDC("0.1"), { toolId: toolId(name) });
      await w.router.settle(item.intent, item.signature);
    }
    expect(await w.router.earnings(w.builder.address)).to.equal(USDC("0.297")); // 0.3 minus a 1% fee
    // The wildcard covers that builder only.
    const elsewhere = await agentPays(w, s.agent, USDC("0.1"), { payee: w.other.address, toolId: toolId("a") });
    await expect(w.router.settle(elsewhere.intent, elsewhere.signature)).to.be.revertedWithCustomError(w.router, "ToolNotAllowed");
  });

  it("refuses an agent after the payer revokes it, in the same block, and refuses an agent never authorised", async () => {
    const { w, agent } = await authorized();
    const ok = await agentPays(w, agent, USDC("0.1"));
    await w.router.settle(ok.intent, ok.signature);
    await expect(w.vault.connect(w.payer).revoke(agent.address))
      .to.emit(w.vault, "SessionRevoked")
      .withArgs(w.payer.address, agent.address, 1);
    const after = await agentPays(w, agent, USDC("0.1"));
    await expect(w.router.settle(after.intent, after.signature)).to.be.revertedWithCustomError(w.router, "SessionNotFound");
    const never = await agentPays(w, ethers.Wallet.createRandom(), USDC("0.1"));
    await expect(w.router.settle(never.intent, never.signature)).to.be.revertedWithCustomError(w.router, "SessionNotFound");
  });

  it("never lets an agent spend another payer's balance", async () => {
    const { w, agent } = await authorized();
    await fundBalance(w, w.other, USDC(5));
    const item = await agentPays(w, agent, USDC("0.5"), { payer: w.other.address });
    await expect(w.router.settle(item.intent, item.signature)).to.be.revertedWithCustomError(w.router, "SessionNotFound");
    expect(await w.router.payerBalance(w.other.address)).to.equal(USDC(5));
  });

  it("lets the payer sign an intent directly with no policy at all", async () => {
    const { w } = await authorized(100, { perCallCap: USDC("0.1"), budget: USDC("0.1") });
    const big = await signedIntent(w, w.payer, w.payer.address, w.stranger.address, USDC(10), { toolId: TRANSLATE });
    await w.router.settle(big.intent, big.signature);
    expect(await w.router.payerBalance(w.payer.address)).to.equal(USDC(10));
  });

  it("does not consume the session when the prepaid balance cannot cover the call", async () => {
    const { w, agent } = await authorized();
    await w.router.connect(w.payer).refund(USDC(20), w.payer.address);
    const item = await agentPays(w, agent, USDC(1));
    await expect(w.router.settle(item.intent, item.signature)).to.be.revertedWithCustomError(w.router, "InsufficientBalance");
    expect(await w.vault.remainingBudget(w.payer.address, agent.address)).to.equal(USDC(5));
  });

  it("keeps sessions for different agents and different payers apart", async () => {
    const w = await deploy();
    await fundBalance(w, w.payer, USDC(10));
    await fundBalance(w, w.other, USDC(10));
    const a = await session(w);
    const b = await session(w, { budget: USDC(2), perCallCap: USDC(2) });
    await w.vault.connect(w.payer).authorize(a.grant, a.tools);
    await w.vault.connect(w.payer).authorize(b.grant, b.tools);
    await w.vault.connect(w.other).authorize(a.grant, a.tools); // the same agent key, authorised by another payer
    const one = await agentPays(w, a.agent, USDC(1));
    await w.router.settle(one.intent, one.signature);
    expect(await w.vault.remainingBudget(w.payer.address, a.agent.address)).to.equal(USDC(4));
    expect(await w.vault.remainingBudget(w.payer.address, b.agent.address)).to.equal(USDC(2));
    expect(await w.vault.remainingBudget(w.other.address, a.agent.address)).to.equal(USDC(5));
  });

  it("enforces the budget part-way through a batch and reports the rest as skipped", async () => {
    const { w, agent } = await authorized(100, { budget: USDC(5), perCallCap: USDC(2) });
    const items = [];
    for (let i = 0; i < 4; i++) items.push(await agentPays(w, agent, USDC(2)));
    const args = [items.map((i) => i.intent), items.map((i) => i.signature)];
    expect(await w.router.batchSettle.staticCall(...args)).to.equal(2);
    const tx = await w.router.batchSettle(...args);
    const reason = w.router.interface.getError("BudgetExceeded")!.selector;
    await expect(tx).to.emit(w.router, "SettleSkipped").withArgs(2, w.payer.address, items[2]!.intent.nonce, reason);
    await expect(tx).to.emit(w.router, "SettleSkipped").withArgs(3, w.payer.address, items[3]!.intent.nonce, reason);
    expect(await w.vault.remainingBudget(w.payer.address, agent.address)).to.equal(USDC(1));
  });

  it("lets only the router spend a session", async () => {
    const { w, agent } = await authorized();
    await expect(
      w.vault.connect(w.stranger).consume(w.payer.address, agent.address, w.builder.address, WEATHER, 1),
    ).to.be.revertedWithCustomError(w.vault, "NotRouter");
    await expect(
      w.vault.connect(w.payer).consume(w.payer.address, agent.address, w.builder.address, WEATHER, 1),
    ).to.be.revertedWithCustomError(w.vault, "NotRouter");
    expect(await w.vault.router()).to.equal(w.routerAddress);
  });
});

describe("AgentVault: revoking", () => {
  it("refuses to revoke a session that does not exist, and a second revoke", async () => {
    const { w, agent } = await authorized();
    await expect(w.vault.connect(w.payer).revoke(w.other.address)).to.be.revertedWithCustomError(w.vault, "SessionNotFound");
    await w.vault.connect(w.payer).revoke(agent.address);
    await expect(w.vault.connect(w.payer).revoke(agent.address)).to.be.revertedWithCustomError(w.vault, "SessionNotFound");
    await expect(w.vault.connect(w.stranger).revoke(agent.address)).to.be.revertedWithCustomError(w.vault, "SessionNotFound");
  });

  it("revokeBySig lets a payer with no QIE revoke through a relayer, once", async () => {
    const w = await deploy();
    const payer = ethers.Wallet.createRandom();
    await w.token.mint(w.other.address, USDC(5));
    await w.token.connect(w.other).approve(w.routerAddress, USDC(5));
    await w.router.connect(w.other).depositFor(payer.address, USDC(5));
    const s = await session(w);
    const deadline = (await nowSeconds()) + 3600n;
    const auth = await payer.signTypedData(vaultDomain(w.vaultAddress), authorizeTypes, {
      payer: payer.address, agent: s.grant.agent, budget: s.grant.budget, perCallCap: s.grant.perCallCap,
      expiry: s.grant.expiry, tools: s.tools, nonce: 0, deadline,
    });
    await w.vault.connect(w.relayer).authorizeBySig(payer.address, s.grant, s.tools, deadline, auth);
    const request = { payer: payer.address, agent: s.agent.address, nonce: 1, deadline };
    const signature = await payer.signTypedData(vaultDomain(w.vaultAddress), revokeTypes, request);
    await expect(w.vault.connect(w.relayer).revokeBySig(payer.address, s.agent.address, deadline, signature))
      .to.emit(w.vault, "SessionRevoked");
    expect(await w.vault.nonces(payer.address)).to.equal(2);
    const item = await agentPays(w, s.agent, USDC("0.1"), { payer: payer.address });
    await expect(w.router.settle(item.intent, item.signature)).to.be.revertedWithCustomError(w.router, "SessionNotFound");
    await expect(w.vault.revokeBySig(payer.address, s.agent.address, deadline, signature)).to.be.revertedWithCustomError(
      w.vault,
      "InvalidSignature",
    );
  });

  it("refuses an expired, forged or altered revocation, and one for a different agent", async () => {
    const { w, agent } = await authorized();
    const deadline = (await nowSeconds()) + 3600n;
    const forged = await ethers.Wallet.createRandom().signTypedData(vaultDomain(w.vaultAddress), revokeTypes, {
      payer: w.payer.address, agent: agent.address, nonce: 0, deadline,
    });
    await expect(w.vault.revokeBySig(w.payer.address, agent.address, deadline, forged)).to.be.revertedWithCustomError(
      w.vault,
      "InvalidSignature",
    );
    const real = await w.payer.signTypedData(vaultDomain(w.vaultAddress), revokeTypes, {
      payer: w.payer.address, agent: agent.address, nonce: 0, deadline,
    });
    await expect(w.vault.revokeBySig(w.payer.address, w.other.address, deadline, real)).to.be.revertedWithCustomError(
      w.vault,
      "InvalidSignature",
    );
    await expect(w.vault.revokeBySig(w.payer.address, agent.address, (await nowSeconds()) - 1n, real)).to.be.revertedWithCustomError(
      w.vault,
      "Expired",
    );
    await w.vault.revokeBySig(w.payer.address, agent.address, deadline, real);
  });

  it("does not change an intent already settled when its session is later revoked", async () => {
    const { w, agent } = await authorized();
    const item = await agentPays(w, agent, USDC(1));
    await w.router.settle(item.intent, item.signature);
    await w.vault.connect(w.payer).revoke(agent.address);
    expect(await w.router.earnings(w.builder.address)).to.equal(USDC("0.99"));
    // And an unsettled intent signed before the revoke can no longer be settled.
    const late = await agentPays(w, agent, USDC(1));
    await expect(w.router.settle(late.intent, late.signature)).to.be.revertedWithCustomError(w.router, "SessionNotFound");
  });

  it("is unaffected by the payer cancelling an unrelated nonce", async () => {
    const { w, agent } = await authorized();
    await w.router.connect(w.payer).cancelNonce(randomNonce());
    const item = await agentPays(w, agent, USDC("0.1"));
    await w.router.settle(item.intent, item.signature);
    expect((await newIntent(w.payer.address, w.builder.address, 1n)).nonce).to.not.equal(item.intent.nonce);
  });
});

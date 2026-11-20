// Property tests: a seeded random walk over every state-changing function, with a shadow ledger kept in
// plain TypeScript. After every step the chain must agree with the shadow ledger and these must hold:
//
//   1. token held by the router == totalLiabilities == sum(payer balances) + sum(builder earnings)
//   2. feeBps never exceeds 200, and every settled fee == floor(amount * feeBps / 10000)
//      which is therefore never above floor(amount * 200 / 10000)
//   3. builder credit + fee == amount, and the payer is debited exactly the amount
//   4. no tokens appear or vanish: wallets + router == everything minted
//   5. an agent never spends more than its budget, nor more than its per-call cap in one call
//
// The seeds are fixed, so a failure is reproducible: the seed and step are in the failure message.
import { expect } from "chai";
import { ethers } from "hardhat";
import { deploy, nowSeconds, randomNonce, signedIntent, toolId, USDC } from "../helpers";
import type { Signer, TypedSigner, World } from "../helpers";

/** mulberry32: a small, well-known seeded generator. Good enough to drive tests, not for anything secret. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BPS = 10_000n;
const CAP_BPS = 200n;

type SessionModel = { budget: bigint; spent: bigint; cap: bigint; payee: string };

async function run(seed: number, steps: number) {
  const rng = prng(seed);
  const int = (n: number) => Math.floor(rng() * n);
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)]!;
  /** 1..max, with a third of draws tiny so that fee rounding is exercised. */
  const amount = (max: bigint): bigint => {
    if (max <= 0n) return 1n;
    if (rng() < 0.33) {
      const tiny = BigInt(1 + int(150));
      return tiny > max ? max : tiny;
    }
    return BigInt(Math.floor(rng() * Number(max))) + 1n;
  };

  const w = await deploy({ feeBps: 100 });
  const [owner, feeRecipient, ...rest] = w.all;
  const payers = rest.slice(0, 4);
  const builders = rest.slice(4, 8);
  const actors: Signer[] = [owner, feeRecipient, ...payers, ...builders];
  const addrs = actors.map((a) => a.address);

  // Shadow ledger.
  const pb = new Map<string, bigint>(addrs.map((a) => [a, 0n]));
  const earn = new Map<string, bigint>(addrs.map((a) => [a, 0n]));
  const wallet = new Map<string, bigint>(addrs.map((a) => [a, 0n]));
  let minted = 0n;
  let feeBps = 100n;
  let feeTo = feeRecipient.address;
  const sessions = new Map<string, SessionModel>(); // key: payer + agent
  const agents = new Map<string, ReturnType<typeof ethers.Wallet.createRandom>>(); // by payer
  const tag = (step: number, what: string) => `seed ${seed}, step ${step} (${what})`;

  const sum = (m: Map<string, bigint>) => [...m.values()].reduce((x, y) => x + y, 0n);
  const mint = async (who: Signer, amt: bigint) => {
    await w.token.mint(who.address, amt);
    await w.token.connect(who).approve(w.routerAddress, ethers.MaxUint256);
    wallet.set(who.address, wallet.get(who.address)! + amt);
    minted += amt;
  };
  for (const p of payers) await mint(p, USDC(30));

  async function checkInvariants(label: string) {
    const held: bigint = await w.token.balanceOf(w.routerAddress);
    const owed: bigint = await w.router.totalLiabilities();
    expect(held, `${label}: token held`).to.equal(owed);
    expect(owed, `${label}: liabilities vs shadow`).to.equal(sum(pb) + sum(earn));
    expect(BigInt(await w.router.feeBps()), `${label}: fee`).to.equal(feeBps);
    expect(feeBps <= CAP_BPS, `${label}: fee cap`).to.equal(true);
    let walletsOnChain = 0n;
    for (const a of addrs) {
      expect(await w.router.payerBalance(a), `${label}: prepaid ${a}`).to.equal(pb.get(a));
      expect(await w.router.earnings(a), `${label}: earnings ${a}`).to.equal(earn.get(a));
      const onChain: bigint = await w.token.balanceOf(a);
      expect(onChain, `${label}: wallet ${a}`).to.equal(wallet.get(a));
      walletsOnChain += onChain;
    }
    expect(walletsOnChain + held, `${label}: conservation`).to.equal(minted);
    for (const [key, s] of sessions) {
      const [payer, agent] = key.split("/") as [string, string];
      const remaining: bigint = await w.vault.remainingBudget(payer, agent);
      expect(remaining, `${label}: session remaining`).to.equal(s.budget - s.spent);
      expect(s.spent <= s.budget, `${label}: session never overspent`).to.equal(true);
    }
  }

  /** What settling should do to the shadow ledger, and the fee it should charge. */
  const credit = (payer: string, payee: string, amt: bigint) => {
    const fee = (amt * feeBps) / BPS;
    expect(fee <= (amt * CAP_BPS) / BPS, "fee above the cap").to.equal(true);
    pb.set(payer, pb.get(payer)! - amt);
    earn.set(payee, earn.get(payee)! + (amt - fee));
    if (fee !== 0n) earn.set(feeTo, earn.get(feeTo)! + fee);
    return fee;
  };

  const settledEvents = (receipt: { logs: ReadonlyArray<{ topics: ReadonlyArray<string>; data: string }> } | null) =>
    (receipt?.logs ?? [])
      .map((l) => {
        try {
          return w.router.interface.parseLog({ topics: [...l.topics], data: l.data });
        } catch {
          return null;
        }
      })
      .filter((e) => e?.name === "Settled");

  for (let step = 1; step <= steps; step++) {
    const op = int(100);
    const label = tag(step, `op ${op}`);
    const payer = pick(payers);
    const builder = pick([...builders, feeRecipient, payer]);

    if (op < 14) {
      // deposit, or deposit for someone else
      const amt = amount(wallet.get(payer.address)!);
      if (wallet.get(payer.address)! === 0n) {
        await mint(payer, USDC(5));
        continue;
      }
      if (rng() < 0.7) {
        await w.router.connect(payer).deposit(amt);
        pb.set(payer.address, pb.get(payer.address)! + amt);
      } else {
        const to = pick(payers);
        await w.router.connect(payer).depositFor(to.address, amt);
        pb.set(to.address, pb.get(to.address)! + amt);
      }
      wallet.set(payer.address, wallet.get(payer.address)! - amt);
    } else if (op < 50) {
      // a payer-signed settle; sometimes for more than the balance
      const bal = pb.get(payer.address)!;
      const amt = rng() < 0.15 ? bal + amount(5_000_000n) : amount(bal);
      const item = await signedIntent(w, payer, payer.address, builder.address, amt, { toolId: toolId(`t${int(5)}`) });
      if (amt <= bal) {
        const tx = await w.router.settle(item.intent, item.signature);
        const events = settledEvents(await tx.wait());
        expect(events.length, `${label}: one Settled event`).to.equal(1);
        const fee = credit(payer.address, builder.address, amt);
        const ev = events[0]!;
        expect(ev.args.fee, `${label}: event fee`).to.equal(fee);
        expect(ev.args.amount, `${label}: event amount`).to.equal(amt);
        // replay of the same intent must fail, whoever submits it
        if (rng() < 0.25) await expect(w.router.connect(pick(actors)).settle(item.intent, item.signature)).to.be.reverted;
      } else {
        await expect(w.router.settle(item.intent, item.signature), label).to.be.reverted;
      }
    } else if (op < 62) {
      // a batch with a mix of good and bad intents; the bad ones are skipped, the good ones settle
      const size = 1 + int(5);
      const items = [];
      const expectSettled: boolean[] = [];
      const running = new Map(pb);
      for (let i = 0; i < size; i++) {
        const p = pick(payers);
        const b = pick(builders);
        const bad = rng() < 0.3;
        const bal = running.get(p.address)!;
        const amt = bad ? bal + 1n : amount(bal);
        const item = await signedIntent(w, p, p.address, b.address, amt, {
          deadline: (await nowSeconds()) + 86_400n,
          nonce: randomNonce(),
        });
        items.push({ ...item, payer: p.address, payee: b.address, amt });
        const ok = !bad && amt >= 1n && amt <= bal;
        expectSettled.push(ok);
        if (ok) running.set(p.address, bal - amt);
      }
      const args = [items.map((x) => x.intent), items.map((x) => x.signature)];
      const returned: bigint = await w.router.batchSettle.staticCall(...args);
      expect(returned, `${label}: batch count`).to.equal(BigInt(expectSettled.filter(Boolean).length));
      await w.router.batchSettle(...args);
      items.forEach((x, i) => {
        if (expectSettled[i]) credit(x.payer, x.payee, x.amt);
      });
    } else if (op < 72) {
      // a builder (or the fee recipient) withdraws part of their earnings
      const who = pick([...builders, feeRecipient, payer]);
      const bal = earn.get(who.address)!;
      if (bal === 0n) {
        await expect(w.router.connect(who).withdraw(1, who.address), label).to.be.reverted;
      } else {
        const amt = amount(bal);
        await w.router.connect(who).withdraw(amt, who.address);
        earn.set(who.address, bal - amt);
        wallet.set(who.address, wallet.get(who.address)! + amt);
      }
    } else if (op < 82) {
      // a payer refunds part of the prepaid balance, whatever else is going on
      const bal = pb.get(payer.address)!;
      if (bal === 0n) {
        await expect(w.router.connect(payer).refund(1, payer.address), label).to.be.reverted;
      } else {
        const amt = rng() < 0.2 ? bal : amount(bal);
        await w.router.connect(payer).refund(amt, payer.address);
        pb.set(payer.address, bal - amt);
        wallet.set(payer.address, wallet.get(payer.address)! + amt);
      }
    } else if (op < 86) {
      // the owner changes the fee, within the cap or beyond it
      if (rng() < 0.3) {
        const tooHigh = 201 + int(5000);
        await expect(w.router.connect(owner).setFee(tooHigh), label).to.be.revertedWithCustomError(w.router, "FeeTooHigh");
      } else {
        const next = BigInt(int(201));
        await w.router.connect(owner).setFee(next);
        feeBps = next;
      }
    } else if (op < 88) {
      const next = pick([...builders, feeRecipient, owner]);
      await w.router.connect(owner).setFeeRecipient(next.address);
      feeTo = next.address;
    } else if (op < 90) {
      // someone who is not the owner tries the owner's powers
      const outsider = pick(payers);
      await expect(w.router.connect(outsider).setFee(1), label).to.be.revertedWithCustomError(w.router, "NotOwner");
      await expect(w.router.connect(outsider).setFeeRecipient(outsider.address), label).to.be.revertedWithCustomError(
        w.router,
        "NotOwner",
      );
    } else if (op < 93) {
      // authorise (or replace) an agent for this payer
      const agent = agents.get(payer.address) ?? ethers.Wallet.createRandom();
      agents.set(payer.address, agent);
      const b = pick(builders);
      const cap = amount(3_000_000n);
      const budget = cap + amount(6_000_000n);
      await w.vault.connect(payer).authorize(
        { agent: agent.address, budget, perCallCap: cap, expiry: (await nowSeconds()) + 86_400n },
        [{ payee: b.address, toolId: ethers.ZeroHash }],
      );
      sessions.set(`${payer.address}/${agent.address}`, { budget, spent: 0n, cap, payee: b.address });
    } else if (op < 98) {
      // an agent spends: inside its policy, over the cap, over the budget, or to the wrong builder
      const agent = agents.get(payer.address);
      const s = agent ? sessions.get(`${payer.address}/${agent.address}`) : undefined;
      if (!agent) continue;
      const bal = pb.get(payer.address)!;
      const roll = rng();
      const amt = roll < 0.5 ? amount(s ? s.cap : 1n) : roll < 0.7 ? (s ? s.cap : 0n) + amount(1_000_000n) : amount(bal + 1n);
      const wrongPayee = rng() < 0.15;
      const to = wrongPayee ? pick(builders.filter((b) => b.address !== s?.payee)) : s ? { address: s.payee } : builders[0]!;
      const item = await signedIntent(w, agent, payer.address, to.address, amt, { toolId: toolId(`t${int(5)}`) });
      const allowed = !!s && !wrongPayee && amt <= s.cap && s.spent + amt <= s.budget && amt <= bal;
      if (allowed) {
        await w.router.settle(item.intent, item.signature);
        s.spent += amt;
        credit(payer.address, to.address, amt);
      } else {
        await expect(w.router.settle(item.intent, item.signature), label).to.be.reverted;
      }
    } else {
      // revoke an agent, which takes effect at once
      const agent = agents.get(payer.address);
      if (!agent || !sessions.has(`${payer.address}/${agent.address}`)) continue;
      await w.vault.connect(payer).revoke(agent.address);
      sessions.delete(`${payer.address}/${agent.address}`);
      const s = await agentAttempt(w, payer, agent, builders[0]!, pb.get(payer.address)! >= 1n, label);
      expect(s, `${label}: revoked agent refused`).to.equal(true);
    }
    await checkInvariants(label);
  }

  // At the end everybody can take everything out, and the router is empty.
  for (const p of payers) {
    const bal: bigint = await w.router.payerBalance(p.address);
    if (bal > 0n) await w.router.connect(p).refund(bal, p.address);
  }
  for (const a of actors) {
    const bal: bigint = await w.router.earnings(a.address);
    if (bal > 0n) await w.router.connect(a).withdraw(bal, a.address);
  }
  expect(await w.token.balanceOf(w.routerAddress), `seed ${seed}: router empty at the end`).to.equal(0);
  expect(await w.router.totalLiabilities(), `seed ${seed}: nothing owed at the end`).to.equal(0);
}

/**
 * Tries a 1-unit spend by a revoked agent. The router checks the payer's balance before it asks the vault,
 * so with an empty balance the refusal is InsufficientBalance; otherwise it must be SessionNotFound.
 */
async function agentAttempt(
  w: World,
  payer: Signer,
  agent: TypedSigner,
  builder: Signer,
  payerHasBalance: boolean,
  label: string,
): Promise<boolean> {
  const item = await signedIntent(w, agent, payer.address, builder.address, 1n, { toolId: toolId("x") });
  const expected = payerHasBalance ? "SessionNotFound" : "InsufficientBalance";
  const selector = w.router.interface.getError(expected)!.selector;
  try {
    await w.router.settle.staticCall(item.intent, item.signature);
    return false;
  } catch (error) {
    const data = (error as { data?: string }).data ?? "";
    expect(data.startsWith(selector) || String(error).includes(expected), `${label}: expected ${expected}, got ${String(error)}`).to.equal(
      true,
    );
    return true;
  }
}

describe("Properties: random walks over every function", function () {
  this.timeout(600_000);
  for (const seed of [1, 2, 3, 4]) {
    it(`keeps the ledger solvent, the fee capped and the shadow ledger equal (seed ${seed})`, async () => {
      await run(seed, 110);
    });
  }
});

describe("Properties: the fee", () => {
  it("is exactly floor(amount * bps / 10000) and never above the 2% cap, for every bps and awkward amounts", async () => {
    const w = await deploy({ feeBps: 0 });
    const [, , payer, builder] = w.all;
    const amounts = [1n, 2n, 49n, 50n, 51n, 99n, 100n, 101n, 9_999n, 10_000n, 10_001n, 333_333n, USDC(1), USDC("1.000001"), USDC(7777)];
    const total = amounts.reduce((x, y) => x + y, 0n);
    const bpsList = [0, 1, 2, 3, 7, 50, 99, 100, 101, 150, 199, 200];
    const funds = total * BigInt(bpsList.length);
    await w.token.mint(payer.address, funds);
    await w.token.connect(payer).approve(w.routerAddress, funds);
    await w.router.connect(payer).deposit(funds);
    for (const bps of bpsList) {
      await w.router.connect(w.owner).setFee(bps);
      for (const amt of amounts) {
        const item = await signedIntent(w, payer, payer.address, builder.address, amt);
        const before = await w.router.earnings(w.feeRecipient.address);
        const builderBefore = await w.router.earnings(builder.address);
        await w.router.settle(item.intent, item.signature);
        const fee = (amt * BigInt(bps)) / BPS;
        expect(fee <= (amt * CAP_BPS) / BPS).to.equal(true);
        expect((await w.router.earnings(w.feeRecipient.address)) - before).to.equal(fee);
        expect((await w.router.earnings(builder.address)) - builderBefore).to.equal(amt - fee);
      }
    }
  });

  it("can never be set above the cap by anyone, at any value", async () => {
    const w = await deploy();
    for (const bad of [201, 202, 500, 10_000, 65_535]) {
      await expect(w.router.connect(w.owner).setFee(bad)).to.be.revertedWithCustomError(w.router, "FeeTooHigh");
    }
    expect(await w.router.feeBps()).to.equal(100);
    expect(await w.router.MAX_FEE_BPS()).to.equal(200);
  });

  it("rounds the fee down: a payment too small to carry a fee carries none, and the builder keeps it all", async () => {
    const w = await deploy({ feeBps: 100 });
    const [, , payer, builder] = w.all;
    await w.token.mint(payer.address, 1_000n);
    await w.token.connect(payer).approve(w.routerAddress, 1_000n);
    await w.router.connect(payer).deposit(1_000n);
    const item = await signedIntent(w, payer, payer.address, builder.address, 99n);
    await w.router.settle(item.intent, item.signature);
    expect(await w.router.earnings(builder.address)).to.equal(99);
    expect(await w.router.earnings(w.feeRecipient.address)).to.equal(0);
  });
});

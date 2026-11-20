// The facilitator service on a local chain: /verify, /settle (queue, then batchSettle with SettleSkipped),
// /status, idempotency, agent policy, the daily caps, and the relayer's hard limits.
import { expect } from "chai";
import { Wallet, getAddress, parseEther } from "ethers";
import { ERRORS, SCHEME, toolIdOf } from "@sluice/sdk";
import { Facilitator, HARD_CAPS, DEFAULT_CAPS, resolveCaps, Relayer, CapError } from "@sluice/facilitator";
import { deployContract, malleate, tamper, USDC } from "../../helpers";
import { rejectsWith } from "../../helpers/assert";
import { makePayment, requirementsFor, TOOL, verifyBody } from "../../helpers/payments";
import { depositFor, fundWallet, setQie, startStack, throwawayWallet } from "../../helpers/stack";
import type { Stack } from "../../helpers/stack";

const price = USDC("0.01");

describe("Facilitator: verify", function () {
  let s: Stack;
  let payer: Wallet;
  let builder: string;

  before(async () => {
    s = await startStack();
    payer = throwawayWallet();
    builder = throwawayWallet().address;
    await fundWallet(s, payer, USDC("5"), parseEther("1"));
    await depositFor(s, payer, USDC("5"));
  });
  after(async () => {
    await s.stop();
  });

  const reason = async (m: Awaited<ReturnType<typeof makePayment>>) => (await s.facilitator.verify(verifyBody(m))).invalidReason;

  it("accepts a well-formed payment from a payer with a balance", async () => {
    const req = requirementsFor(s, builder, price);
    const m = await makePayment(s, payer, payer.address, req);
    const v = await s.facilitator.verify(verifyBody(m));
    expect(v).to.include({ isValid: true, payer: payer.address });
    expect(v.extra?.id).to.equal(m.digest);
  });

  it("refuses the wrong x402 version, scheme and network", async () => {
    const req = requirementsFor(s, builder, price);
    const m = await makePayment(s, payer, payer.address, req);
    expect((await s.facilitator.verify({ ...verifyBody(m), x402Version: 1 })).invalidReason).to.equal(ERRORS.invalidVersion);
    const wrongScheme = { ...req, scheme: "exact" };
    expect(await reason({ ...m, requirements: wrongScheme, payload: { ...m.payload, accepted: wrongScheme } })).to.equal(ERRORS.invalidScheme);
    const wrongNet = { ...req, network: "eip155:8453" };
    expect(await reason({ ...m, requirements: wrongNet, payload: { ...m.payload, accepted: wrongNet } })).to.equal(ERRORS.invalidNetwork);
  });

  it("refuses a payment signed for a different chain id (wrong-chain signature)", async () => {
    // A signature made under another chain id recovers to an unrelated key, which is not the payer and holds no session.
    const req = requirementsFor(s, builder, price);
    const m = await makePayment(s, payer, payer.address, req, {}, 1);
    expect(await reason(m)).to.equal(ERRORS.sessionNotFound);
    const right = await makePayment(s, payer, payer.address, req, {}, 1990);
    expect(await reason(right)).to.equal(undefined);
  });

  it("refuses a payment signed for another router, and a requirement that names another router", async () => {
    const req = requirementsFor(s, builder, price);
    const other = await deployContract("PaymentRouter", [s.tokenAddress, s.owner.address, s.feeRecipient.address, 100]);
    const m = await makePayment(s, payer, payer.address, req, {}, 1990, await other.getAddress());
    expect(await reason(m)).to.equal(ERRORS.sessionNotFound);
    const elsewhere = { ...req, extra: { ...req.extra, router: getAddress(await other.getAddress()) } };
    const n = await makePayment(s, payer, payer.address, elsewhere);
    expect(await reason(n)).to.equal(ERRORS.invalidRouter);
  });

  it("refuses an expired intent, and one whose deadline is further away than the offer allows", async () => {
    const req = requirementsFor(s, builder, price);
    expect(await reason(await makePayment(s, payer, payer.address, req, { deadline: BigInt(s.clock() - 5) }))).to.equal(ERRORS.expired);
    expect(await reason(await makePayment(s, payer, payer.address, req, { deadline: BigInt(s.clock() + 5) }))).to.equal(ERRORS.expired);
    expect(await reason(await makePayment(s, payer, payer.address, req, { deadline: BigInt(s.clock() + 100_000) }))).to.equal(ERRORS.deadlineTooFar);
  });

  it("refuses a tampered price: an amount below the price, and a price the client edited in its own copy", async () => {
    const req = requirementsFor(s, builder, price);
    expect(await reason(await makePayment(s, payer, payer.address, req, { amount: price - 1n }))).to.equal(ERRORS.amountTooLow);
    const cheap = { ...req, amount: "1" };
    const m = await makePayment(s, payer, payer.address, cheap, { amount: 1n });
    // The facilitator is told the real requirements (what the server wants); the client's edited copy rides in `accepted`.
    expect(await reason({ ...m, requirements: req })).to.equal(ERRORS.acceptedMismatch);
    // And an intent that really is for the lower amount fails against the real requirements.
    const m2 = await makePayment(s, payer, payer.address, req, { amount: 1n });
    expect(await reason(m2)).to.equal(ERRORS.amountTooLow);
  });

  it("accepts an amount above the price, because the payer chose to pay more", async () => {
    const req = requirementsFor(s, builder, price);
    expect(await reason(await makePayment(s, payer, payer.address, req, { amount: price * 2n }))).to.equal(undefined);
  });

  it("refuses the wrong payee and the wrong tool", async () => {
    const req = requirementsFor(s, builder, price);
    expect(await reason(await makePayment(s, payer, payer.address, req, { payee: throwawayWallet().address }))).to.equal(ERRORS.payeeMismatch);
    expect(await reason(await makePayment(s, payer, payer.address, req, { toolId: toolIdOf("other") }))).to.equal(ERRORS.toolMismatch);
  });

  it("refuses a tampered, malleable, truncated or empty signature", async () => {
    const req = requirementsFor(s, builder, price);
    const m = await makePayment(s, payer, payer.address, req);
    const withSignature = (signature: string) => ({ ...m, payload: { ...m.payload, payload: { ...m.payload.payload, signature } } });
    // A signature with a changed byte either recovers to an unrelated key (not the payer, no session) or does not recover at all,
    // depending on whether the changed r is a point on the curve. Both are refusals, and nothing else is acceptable.
    expect(await reason(withSignature(tamper(m.signature)))).to.be.oneOf([ERRORS.sessionNotFound, ERRORS.invalidSignature]);
    // The high-s twin recovers to the payer, but the router refuses it, so the verifier does too.
    expect(await reason(withSignature(malleate(m.signature)))).to.equal(ERRORS.invalidSignature);
    expect(await reason(withSignature(m.signature.slice(0, -2)))).to.equal(ERRORS.invalidSignature);
    expect(await reason(withSignature("0x"))).to.equal(ERRORS.invalidSignature);
    expect(await reason(withSignature(m.signature.slice(0, -2) + "00"))).to.equal(ERRORS.invalidSignature); // v must be 27 or 28
  });

  it("refuses malformed bodies without throwing", async () => {
    for (const body of [null, 5, "x", {}, { x402Version: 2 }, { x402Version: 2, paymentPayload: {}, paymentRequirements: {} }]) {
      const v = await s.facilitator.verify(body);
      expect(v.isValid).to.equal(false);
      expect(v.invalidReason).to.be.a("string");
    }
  });

  it("refuses a payer with too little balance, counting what is already queued", async () => {
    const poor = throwawayWallet();
    await fundWallet(s, poor, USDC("1"), parseEther("1"));
    await depositFor(s, poor, USDC("1"));
    const req = requirementsFor(s, builder, USDC("0.7"));
    const first = await makePayment(s, poor, poor.address, req);
    expect((await s.facilitator.settle(verifyBody(first))).success).to.equal(true);
    const second = await makePayment(s, poor, poor.address, req);
    expect(await reason(second)).to.equal(ERRORS.insufficientFunds);
  });

  it("refuses a nonce the payer already used or cancelled on the chain", async () => {
    const req = requirementsFor(s, builder, price);
    const m = await makePayment(s, payer, payer.address, req);
    await (await s.router.connect(payer.connect(s.provider)).cancelNonce(m.intent.nonce)).wait();
    expect(await reason(m)).to.equal(ERRORS.nonceUsed);
  });
});

describe("Facilitator: settle, flush and status", function () {
  let s: Stack;
  let payer: Wallet;
  let builder: string;

  beforeEach(async () => {
    s = await startStack({ feeBps: 100 });
    payer = throwawayWallet();
    builder = throwawayWallet().address;
    await fundWallet(s, payer, USDC("5"), parseEther("1"));
    await depositFor(s, payer, USDC("5"));
  });
  afterEach(async () => {
    await s.stop();
  });

  it("queues a payment, settles it in a batch, and reports the chain's event", async () => {
    const req = requirementsFor(s, builder, price);
    const m = await makePayment(s, payer, payer.address, req);
    const queued = await s.facilitator.settle(verifyBody(m));
    expect(queued).to.deep.include({ success: true, payer: payer.address, transaction: "", network: "eip155:1990", amount: price.toString() });
    expect(queued.extensions?.sluice).to.deep.include({ id: m.digest, status: "queued" });
    expect(s.facilitator.status(m.digest)?.status).to.equal("queued");
    expect(await s.router.earnings(builder)).to.equal(0n); // nothing on chain yet

    const report = await s.facilitator.flush();
    expect(report).to.include({ submitted: 1, settled: 1, skipped: 0, failed: 0 });
    const done = s.facilitator.status(m.digest)!;
    expect(done.status).to.equal("settled");
    expect(done.transaction).to.match(/^0x[0-9a-f]{64}$/);
    expect(await s.router.earnings(builder)).to.equal(price - price / 100n);
    expect(await s.router.payerBalance(payer.address)).to.equal(USDC("5") - price);
  });

  it("is idempotent: the same intent is one record and settles once, however often it is sent", async () => {
    const req = requirementsFor(s, builder, price);
    const m = await makePayment(s, payer, payer.address, req);
    const [a, b, c] = await Promise.all([s.facilitator.settle(verifyBody(m)), s.facilitator.settle(verifyBody(m)), s.facilitator.settle(verifyBody(m))]);
    expect(a.extensions?.sluice?.id).to.equal(m.digest);
    expect(b.extensions?.sluice?.id).to.equal(m.digest);
    expect(c.extensions?.sluice?.id).to.equal(m.digest);
    expect(s.facilitator.store.size()).to.equal(1);
    expect(await s.facilitator.flush()).to.include({ submitted: 1, settled: 1 });
    // After it settled, sending it again returns the settled record and queues nothing.
    const again = await s.facilitator.settle(verifyBody(m));
    expect(again.success).to.equal(true);
    expect(again.extensions?.sluice?.status).to.equal("settled");
    expect(await s.facilitator.flush()).to.include({ submitted: 0 });
    expect(await s.router.earnings(builder)).to.equal(price - price / 100n);
  });

  it("refuses, at /verify, an intent that is already queued or settled", async () => {
    const m = await makePayment(s, payer, payer.address, requirementsFor(s, builder, price));
    expect((await s.facilitator.verify(verifyBody(m))).isValid).to.equal(true);
    await s.facilitator.settle(verifyBody(m));
    expect((await s.facilitator.verify(verifyBody(m))).invalidReason).to.equal(ERRORS.intentReplayed);
    await s.facilitator.flush();
    expect((await s.facilitator.verify(verifyBody(m))).invalidReason).to.equal(ERRORS.intentReplayed);
  });

  it("refuses a second intent that reuses a nonce with different content", async () => {
    const req = requirementsFor(s, builder, price);
    const a = await makePayment(s, payer, payer.address, req);
    const b = await makePayment(s, payer, payer.address, req, { nonce: a.intent.nonce, amount: price + 1n });
    expect((await s.facilitator.settle(verifyBody(a))).success).to.equal(true);
    const second = await s.facilitator.settle(verifyBody(b));
    expect(second).to.include({ success: false, errorReason: ERRORS.nonceUsed });
  });

  it("settles many in one transaction, and reports a skipped intent without losing the rest (SettleSkipped)", async () => {
    const req = requirementsFor(s, builder, USDC("1"));
    const a = await makePayment(s, payer, payer.address, req);
    const b = await makePayment(s, payer, payer.address, req);
    const c = await makePayment(s, payer, payer.address, req);
    for (const m of [a, b, c]) expect((await s.facilitator.settle(verifyBody(m))).success).to.equal(true);
    // Between queueing and submitting the payer takes most of the balance back, so only some can settle.
    await (await s.router.connect(payer.connect(s.provider)).refund(USDC("3"), payer.address)).wait();
    const report = await s.facilitator.flush();
    expect(report.submitted).to.equal(3);
    expect(report.settled).to.equal(2);
    expect(report.skipped).to.equal(1);
    const statuses = [a, b, c].map((m) => s.facilitator.status(m.digest)!);
    expect(statuses.filter((x) => x.status === "settled")).to.have.length(2);
    const skipped = statuses.find((x) => x.status === "skipped")!;
    expect(skipped.reason).to.equal("InsufficientBalance");
    expect(skipped.transaction).to.equal(statuses.find((x) => x.status === "settled")!.transaction); // one transaction
  });

  it("marks an intent expired, and does not submit it, if its deadline passes while it waits", async () => {
    const req = requirementsFor(s, builder, price);
    const m = await makePayment(s, payer, payer.address, req, { deadline: BigInt(s.clock() + 25) });
    expect((await s.facilitator.settle(verifyBody(m))).success).to.equal(true);
    const later = new LateFlusher(s, 60);
    expect(await later.flushLate()).to.include({ expired: 1, submitted: 0 });
    expect(s.facilitator.status(m.digest)?.status).to.equal("expired");
    expect(await s.router.earnings(builder)).to.equal(0n);
  });

  it("answers /status for an unknown id with nothing", () => {
    expect(s.facilitator.status(`0x${"00".repeat(32)}`)).to.equal(undefined);
  });

  it("never holds QUSDC, and is neither the owner nor the fee recipient", async () => {
    const req = requirementsFor(s, builder, price);
    for (let i = 0; i < 3; i++) await s.facilitator.settle(verifyBody(await makePayment(s, payer, payer.address, req)));
    await s.facilitator.flush();
    expect(await s.token.balanceOf(s.relayerAddress)).to.equal(0n);
    expect(await s.router.owner()).to.not.equal(s.relayerAddress);
    expect(await s.router.feeRecipient()).to.not.equal(s.relayerAddress);
    const health = await s.facilitator.health();
    expect(health.relayerQusdcUnits).to.equal("0");
    expect(JSON.stringify(health), "no 32-byte hex value, so no key").to.not.match(/0x[0-9a-f]{64}/i);
  });
});

/** Moves the facilitator's clock forward without touching the chain, to test deadline handling. */
class LateFlusher {
  constructor(
    private readonly s: Stack,
    private readonly seconds: number,
  ) {}
  async flushLate() {
    const shifted = await Facilitator.create({
      provider: this.s.provider,
      router: this.s.routerAddress,
      relayerKey: throwawayWallet().privateKey,
      now: () => this.s.clock() + this.seconds,
      store: this.s.facilitator.store,
    });
    await setQie(shifted.relayer.address, parseEther("1"));
    return shifted.flush();
  }
}

describe("Facilitator: agent session policy", function () {
  let s: Stack;
  let payer: Wallet;
  let agent: Wallet;
  let builder: string;

  before(async () => {
    s = await startStack();
    payer = throwawayWallet();
    agent = throwawayWallet();
    builder = throwawayWallet().address;
    await fundWallet(s, payer, USDC("5"), parseEther("1"));
    await depositFor(s, payer, USDC("5"));
    await (
      await s.vault.connect(payer.connect(s.provider)).authorize(
        { agent: agent.address, budget: USDC("0.05"), perCallCap: USDC("0.02"), expiry: BigInt(s.clock() + 3600) },
        [{ payee: builder, toolId: toolIdOf(TOOL) }],
      )
    ).wait();
  });
  after(async () => {
    await s.stop();
  });

  const verdict = async (signer: Wallet, req: ReturnType<typeof requirementsFor>, over = {}) =>
    (await s.facilitator.verify(verifyBody(await makePayment(s, signer, payer.address, req, over)))).invalidReason;

  it("accepts an agent inside its policy", async () => {
    expect(await verdict(agent, requirementsFor(s, builder, USDC("0.01")))).to.equal(undefined);
  });

  it("refuses a key with no session, an over-cap call, a tool or builder the owner did not name", async () => {
    expect(await verdict(throwawayWallet(), requirementsFor(s, builder, USDC("0.01")))).to.equal(ERRORS.sessionNotFound);
    expect(await verdict(agent, requirementsFor(s, builder, USDC("0.03")))).to.equal(ERRORS.perCallCap);
    expect(await verdict(agent, requirementsFor(s, builder, USDC("0.01"), "other_tool"))).to.equal(ERRORS.toolNotAllowed);
    expect(await verdict(agent, requirementsFor(s, throwawayWallet().address, USDC("0.01")))).to.equal(ERRORS.toolNotAllowed);
  });

  it("counts the agent's queued spend against its budget, then refuses the call that would pass it", async () => {
    const req = requirementsFor(s, builder, USDC("0.02"));
    for (let i = 0; i < 2; i++) {
      expect((await s.facilitator.settle(verifyBody(await makePayment(s, agent, payer.address, req)))).success).to.equal(true);
    }
    // 0.04 queued of a 0.05 budget: another 0.02 would pass it.
    expect(await verdict(agent, req)).to.equal(ERRORS.budgetExceeded);
    expect(await verdict(agent, requirementsFor(s, builder, USDC("0.01")))).to.equal(undefined);
  });

  it("refuses an agent after the owner revokes it", async () => {
    await (await s.vault.connect(payer.connect(s.provider)).revoke(agent.address)).wait();
    expect(await verdict(agent, requirementsFor(s, builder, USDC("0.01")))).to.equal(ERRORS.sessionNotFound);
  });
});

describe("Facilitator: caps in code", function () {
  it("keeps every default at or below its hard ceiling", () => {
    for (const key of Object.keys(HARD_CAPS) as Array<keyof typeof HARD_CAPS>) {
      expect(DEFAULT_CAPS[key] <= HARD_CAPS[key], key).to.equal(true);
    }
  });

  it("refuses any configuration above a ceiling, and any non-positive value", () => {
    for (const key of Object.keys(HARD_CAPS) as Array<keyof typeof HARD_CAPS>) {
      const ceiling = HARD_CAPS[key];
      const over = typeof ceiling === "bigint" ? ceiling + 1n : ceiling + 1;
      expect(() => resolveCaps({ [key]: over }), `${key} above the ceiling`).to.throw(/hard ceiling/);
      const zero = typeof ceiling === "bigint" ? 0n : 0;
      expect(() => resolveCaps({ [key]: zero }), `${key} at zero`).to.throw(/above zero/);
    }
    expect(() => resolveCaps({ dailyBudgetWei: HARD_CAPS.dailyBudgetWei })).to.not.throw();
  });

  it("states the numbers the design relies on", () => {
    expect(HARD_CAPS.gasLimitPerTx).to.equal(4_000_000n);
    expect(HARD_CAPS.maxGasPriceWei).to.equal(5_000_000_000n);
    expect(HARD_CAPS.dailyBudgetWei).to.equal(parseEther("2"));
    expect(HARD_CAPS.maxBatchSize).to.equal(50);
  });

  describe("the relayer", function () {
    let s: Stack;
    let payer: Wallet;
    let builder: string;

    beforeEach(async () => {
      payer = throwawayWallet();
      builder = throwawayWallet().address;
    });
    afterEach(async () => {
      await s?.stop();
    });

    const seed = async () => {
      await fundWallet(s, payer, USDC("5"), parseEther("1"));
      await depositFor(s, payer, USDC("5"));
    };

    it("will not call any contract but the router and the vault, nor exceed its gas limit", async () => {
      s = await startStack();
      const relayer = s.facilitator.relayer;
      const stranger = throwawayWallet().address;
      let err: unknown;
      try {
        await relayer.sendCall({ to: stranger, data: "0x", gasLimit: 21_000n });
      } catch (e) {
        err = e;
      }
      expect(err).to.be.instanceOf(CapError);
      expect((err as CapError).code).to.equal("destination_not_allowed");
      for (const to of [s.tokenAddress, s.owner.address]) {
        const e = await relayer.sendCall({ to, data: "0x", gasLimit: 21_000n }).catch((x: unknown) => x);
        expect((e as CapError).code, to).to.equal("destination_not_allowed");
      }
      const tooMuch = await relayer
        .sendCall({ to: s.routerAddress, data: "0x", gasLimit: HARD_CAPS.gasLimitPerTx + 1n })
        .catch((x: unknown) => x);
      expect((tooMuch as CapError).code).to.equal("gas_limit_not_allowed");
      expect(relayer.allowlist.sort()).to.deep.equal([s.routerAddress, s.vaultAddress].sort());
    });

    it("will not send a top-up above its cap, to the router, the vault or itself, and does send one inside the cap", async () => {
      s = await startStack();
      const relayer = s.facilitator.relayer;
      const dest = throwawayWallet().address;
      for (const value of [0n, DEFAULT_CAPS.maxTopUpWei + 1n]) {
        const e = await relayer.sendTopUp(dest, value).catch((x: unknown) => x);
        expect((e as CapError).code, String(value)).to.equal("top_up_not_allowed");
      }
      for (const to of [s.routerAddress, s.vaultAddress, s.relayerAddress]) {
        const e = await relayer.sendTopUp(to, 1000n).catch((x: unknown) => x);
        expect((e as CapError).code, to).to.equal("destination_not_allowed");
      }
      expect((await relayer.sendTopUp(dest, 1000n)).status).to.equal(1);
      expect(await s.provider.getBalance(dest)).to.equal(1000n);
    });

    it("holds the batch, and keeps the intents queued, when the gas price is above its ceiling", async () => {
      s = await startStack({ caps: { maxGasPriceWei: 1_000_000_000n } }); // the local chain's price is 1.125 gwei
      await seed();
      const m = await makePayment(s, payer, payer.address, requirementsFor(s, builder, price));
      await s.facilitator.settle(verifyBody(m));
      const report = await s.facilitator.flush();
      expect(report).to.include({ submitted: 0, held: ERRORS.capGasPrice });
      expect(s.facilitator.status(m.digest)?.status).to.equal("queued");
    });

    it("stops spending when the day's QIE budget is used up, and alerts at half of it", async () => {
      // One batch of one intent reserves gasLimit x price. A budget of 1.6x that reserve allows one batch.
      const alerts: string[] = [];
      s = await startStack({ caps: { dailyBudgetWei: 1_000_000_000_000_000n } }); // 0.001 QIE
      await seed();
      const make = () => makePayment(s, payer, payer.address, requirementsFor(s, builder, price));
      await s.facilitator.settle(verifyBody(await make()));
      expect(await s.facilitator.flush()).to.include({ settled: 1 });
      const afterOne = s.facilitator.relayer.budget();
      expect(afterOne.spentWei > 0n).to.equal(true);
      const firedInFlush: Record<string, number> = {};
      for (let i = 0; i < 40 && !alerts.includes("budget_exhausted"); i++) {
        await s.facilitator.settle(verifyBody(await make()));
        const r = await s.facilitator.flush();
        for (const a of s.facilitator.relayer.alerts) {
          if (!alerts.includes(a.kind)) {
            alerts.push(a.kind);
            firedInFlush[a.kind] = i;
          }
        }
        if (r.held) expect(r.held).to.equal(ERRORS.capBudget);
      }
      // The half-budget alert is raised in an earlier flush than the exhaustion alert: it is a warning while budget remains.
      expect(firedInFlush.budget_50, "the half-budget alert fired").to.be.a("number");
      expect(firedInFlush.budget_50!).to.be.lessThan(firedInFlush.budget_exhausted!);
      expect(alerts).to.include("budget_50");
      expect(alerts).to.include("budget_exhausted");
      expect(alerts.indexOf("budget_50")).to.be.lessThan(alerts.indexOf("budget_exhausted"));
      const b = s.facilitator.relayer.budget();
      expect(b.spentWei + b.reservedWei <= b.budgetWei).to.equal(true);
    });

    it("limits one payer and all payers per day", async () => {
      s = await startStack({ caps: { payerDailyIntents: 2, globalDailyIntents: 3 } });
      await seed();
      const req = requirementsFor(s, builder, price);
      const outcomes: Array<string | undefined> = [];
      for (let i = 0; i < 3; i++) outcomes.push((await s.facilitator.settle(verifyBody(await makePayment(s, payer, payer.address, req)))).errorReason);
      expect(outcomes).to.deep.equal([undefined, undefined, ERRORS.capPayerDaily]);
      const other = throwawayWallet();
      await fundWallet(s, other, USDC("1"), parseEther("1"));
      await depositFor(s, other, USDC("1"));
      const o1 = await s.facilitator.settle(verifyBody(await makePayment(s, other, other.address, req)));
      const o2 = await s.facilitator.settle(verifyBody(await makePayment(s, other, other.address, req)));
      expect([o1.errorReason, o2.errorReason]).to.deep.equal([undefined, ERRORS.capGlobalDaily]);
    });

    it("limits a payer's QUSDC per day", async () => {
      s = await startStack({ caps: { payerDailyAmount: USDC("0.025") } });
      await seed();
      const req = requirementsFor(s, builder, price);
      const r = [] as Array<string | undefined>;
      for (let i = 0; i < 3; i++) r.push((await s.facilitator.settle(verifyBody(await makePayment(s, payer, payer.address, req)))).errorReason);
      expect(r).to.deep.equal([undefined, undefined, ERRORS.capPayerDaily]);
    });

    it("refuses to start if the relayer key is the router's owner or its fee recipient", async () => {
      s = await startStack();
      const key = throwawayWallet();
      const asOwner = await deployContract("PaymentRouter", [s.tokenAddress, key.address, s.feeRecipient.address, 100]);
      await rejectsWith(Facilitator.create({ provider: s.provider, router: await asOwner.getAddress(), relayerKey: key.privateKey }), /owner/);
      const asFee = await deployContract("PaymentRouter", [s.tokenAddress, s.owner.address, key.address, 100]);
      await rejectsWith(Facilitator.create({ provider: s.provider, router: await asFee.getAddress(), relayerKey: key.privateKey }), /fee recipient/);
    });

    it("does not show its key when printed, logged or serialised", async () => {
      s = await startStack();
      const key = throwawayWallet();
      const relayer = new Relayer({ key: key.privateKey, provider: s.provider, caps: resolveCaps(), allowlist: [s.routerAddress] });
      const bare = key.privateKey.slice(2);
      const shown = [JSON.stringify(relayer), String(relayer), require("node:util").inspect(relayer, { showHidden: true, depth: 5 })].join("\n");
      expect(shown).to.not.contain(bare);
      expect(SCHEME).to.equal("sluice-intent");
    });
  });
});

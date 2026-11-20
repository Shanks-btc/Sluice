// The facilitator over HTTP, the zero-QIE start (a wallet with QUSDC and no QIE), and relayed exits.
import { expect } from "chai";
import { Transaction, Wallet, getAddress, parseEther } from "ethers";
import { ERRORS, FacilitatorClient, ONBOARD_APPROVE_GAS, ONBOARD_DEPOSIT_GAS, erc20Interface, routerInterface, signAuthorize, signOnboarding, signRevoke, toolIdOf } from "@sluice/sdk";
import { HARD_CAPS, corsHeaders, parseCorsOrigins } from "@sluice/facilitator";
import { USDC, withdrawTypes, refundTypes, routerDomain, randomNonce } from "../../helpers";
import { makePayment, requirementsFor, verifyBody } from "../../helpers/payments";
import { depositFor, fundWallet, setQie, startStack, throwawayWallet } from "../../helpers/stack";
import type { Stack } from "../../helpers/stack";

describe("Facilitator: HTTP", function () {
  let s: Stack;
  let payer: Wallet;
  let builder: string;
  const post = (path: string, body: unknown) =>
    fetch(`${s.facilitatorUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

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

  it("serves /verify, /settle and /status as the x402 facilitator interface", async () => {
    const m = await makePayment(s, payer, payer.address, requirementsFor(s, builder, USDC("0.01")));
    const v = (await (await post("/verify", verifyBody(m))).json()) as { isValid: boolean; payer: string };
    expect(v).to.include({ isValid: true, payer: payer.address });
    const res = await post("/settle", verifyBody(m));
    expect(res.status).to.equal(200);
    const settled = (await res.json()) as { success: boolean; transaction: string; network: string; extensions: { sluice: { id: string; status: string } } };
    expect(settled).to.include({ success: true, transaction: "", network: "eip155:1990" });
    expect(settled.extensions.sluice).to.deep.include({ id: m.digest, status: "queued" });
    await s.facilitator.flush();
    const status = (await (await fetch(`${s.facilitatorUrl}/status/${m.digest}`)).json()) as { status: string; transaction: string };
    expect(status.status).to.equal("settled");
    expect(status.transaction).to.match(/^0x[0-9a-f]{64}$/);
  });

  it("returns 404 for an unknown status id and an unknown route, and 400 for a body that is not JSON or is too large", async () => {
    expect((await fetch(`${s.facilitatorUrl}/status/0x${"11".repeat(32)}`)).status).to.equal(404);
    expect((await fetch(`${s.facilitatorUrl}/nothing`)).status).to.equal(404);
    expect((await fetch(`${s.facilitatorUrl}/verify`)).status).to.equal(404); // GET is not allowed on /verify
    const notJson = await fetch(`${s.facilitatorUrl}/verify`, { method: "POST", body: "{nope" });
    expect(notJson.status).to.equal(400);
    const big = await fetch(`${s.facilitatorUrl}/verify`, { method: "POST", body: "x".repeat(300 * 1024) }).catch(() => undefined);
    if (big) expect(big.status).to.equal(400); // or the connection is closed, which is also a refusal
  });

  it("answers an invalid body with isValid false, not an error status", async () => {
    const res = await post("/verify", { x402Version: 2 });
    expect(res.status).to.equal(200);
    expect(await res.json()).to.deep.include({ isValid: false, invalidReason: ERRORS.invalidPayload });
  });

  it("serves /health with the relayer's address and budget, and no key", async () => {
    const body = (await (await fetch(`${s.facilitatorUrl}/health`)).json()) as { relayer: string; budget: { budgetWei: string }; alerts: unknown[] };
    expect(body.relayer).to.equal(s.relayerAddress);
    expect(BigInt(body.budget.budgetWei) > 0n).to.equal(true);
    expect(JSON.stringify(body)).to.not.match(/0x[0-9a-f]{64}/i);
  });

  it("hides the text of an unexpected failure from the response", async () => {
    const real = s.facilitator.health.bind(s.facilitator);
    s.facilitator.health = async () => {
      throw new Error("boom: https://rpc.example/?key=SECRET-VALUE");
    };
    const res = await fetch(`${s.facilitatorUrl}/health`);
    s.facilitator.health = real;
    expect(res.status).to.equal(500);
    const text = await res.text();
    expect(text).to.equal('{"error":"unexpected_error"}');
  });

  it("is reachable through the SDK's client", async () => {
    const client = new FacilitatorClient({ url: s.facilitatorUrl });
    const m = await makePayment(s, payer, payer.address, requirementsFor(s, builder, USDC("0.01")));
    expect((await client.verify(m.payload, m.requirements)).isValid).to.equal(true);
    const settled = await client.settle(m.payload, m.requirements);
    expect(settled.success).to.equal(true);
    expect((await client.status(m.digest))?.status).to.equal("queued");
    expect(await client.status(`0x${"22".repeat(32)}`)).to.equal(undefined);
  });
});

describe("Facilitator: the zero-QIE start", function () {
  let s: Stack;
  let wallet: Wallet;
  let gasPrice: bigint;
  const amount = USDC("5");

  beforeEach(async () => {
    s = await startStack();
    wallet = throwawayWallet();
    await fundWallet(s, wallet, USDC("20")); // QUSDC and no QIE at all
    gasPrice = (await s.provider.getFeeData()).gasPrice as bigint;
  });
  afterEach(async () => {
    await s.stop();
  });

  const sign = async (over: Partial<{ amount: bigint; nonce: number; gasPrice: bigint; router: string }> = {}) =>
    signOnboarding(wallet, {
      router: over.router ?? s.routerAddress,
      asset: s.tokenAddress,
      amount: over.amount ?? amount,
      nonce: over.nonce ?? 0,
      gasPrice: over.gasPrice ?? gasPrice,
    });
  const onboard = (txs: { approveTx: string; depositTx: string }, payer = wallet.address) => s.facilitator.onboard({ payer, ...txs });

  it("starts a wallet that has QUSDC and zero QIE: it cannot send a transaction, but it can sign two", async () => {
    expect(await s.provider.getBalance(wallet.address)).to.equal(0n);
    const direct = await wallet.connect(s.provider).sendTransaction({ to: s.routerAddress, data: "0x", gasLimit: 21_000n, gasPrice }).catch((e: unknown) => e);
    expect((direct as Error).message, "with no QIE it cannot pay for any transaction").to.match(/insufficient funds|balance|sender doesn't have enough/i);

    const txs = await sign();
    const relayerBefore = await s.provider.getBalance(s.relayerAddress);
    const out = await onboard(txs);
    expect(out).to.deep.include({ ok: true });
    expect(out.topUpWei).to.equal(((ONBOARD_APPROVE_GAS + ONBOARD_DEPOSIT_GAS) * gasPrice).toString());

    // The deposit landed in the wallet's own prepaid balance, and the approval was used up exactly.
    expect(await s.router.payerBalance(wallet.address)).to.equal(amount);
    expect(await s.token.allowance(wallet.address, s.routerAddress)).to.equal(0n);
    expect(await s.token.balanceOf(wallet.address)).to.equal(USDC("20") - amount);

    // The wallet got exactly the gas its two transactions could use, and kept only what they did not.
    const left = await s.provider.getBalance(wallet.address);
    expect(left < BigInt(out.topUpWei as string)).to.equal(true);
    expect(left > 0n).to.equal(true); // the unused part of the gas limits comes back to the wallet
    // The relayer paid the top-up and its own transfer gas, and holds no QUSDC.
    const spent = relayerBefore - (await s.provider.getBalance(s.relayerAddress));
    expect(spent >= BigInt(out.topUpWei as string)).to.equal(true);
    expect(await s.token.balanceOf(s.relayerAddress)).to.equal(0n);
  });

  it("then pays for a tool call with no QIE ever held beyond that gas", async () => {
    await onboard(await sign());
    const builder = throwawayWallet().address;
    const m = await makePayment(s, wallet, wallet.address, requirementsFor(s, builder, USDC("0.01")));
    expect((await s.facilitator.settle(verifyBody(m))).success).to.equal(true);
    await s.facilitator.flush();
    expect(s.facilitator.status(m.digest)?.status).to.equal("settled");
  });

  it("tops up only the difference when the wallet already holds some QIE", async () => {
    const need = (ONBOARD_APPROVE_GAS + ONBOARD_DEPOSIT_GAS) * gasPrice;
    await setQie(wallet.address, need / 2n);
    const out = await onboard(await sign());
    expect(out.ok).to.equal(true);
    expect(BigInt(out.topUpWei as string)).to.equal(need - need / 2n);
  });

  it("sends no top-up at all when the wallet already has enough QIE", async () => {
    await setQie(wallet.address, parseEther("1"));
    const out = await onboard(await sign());
    expect(out).to.include({ ok: true });
    expect(out.topUpTx).to.equal(undefined);
  });

  describe("refuses what it should, before sending any QIE", () => {
    const refused = async (txs: { approveTx: string; depositTx: string }, why: RegExp, payer = wallet.address) => {
      const before = await s.provider.getBalance(wallet.address);
      const out = await onboard(txs, payer);
      expect(out.ok).to.equal(false);
      expect(out.error).to.equal(ERRORS.onboardRefused);
      expect(out.detail).to.match(why);
      expect(await s.provider.getBalance(wallet.address), "no QIE was sent").to.equal(before);
      expect(await s.router.payerBalance(wallet.address)).to.equal(0n);
    };

    it("an approval for a spender that is not the router", async () => {
      const txs = await sign();
      const evil = Transaction.from({
        type: 0, chainId: 1990, nonce: 0, gasPrice, gasLimit: ONBOARD_APPROVE_GAS, to: s.tokenAddress, value: 0n,
        data: erc20Interface.encodeFunctionData("approve", [throwawayWallet().address, amount]),
      });
      await refused({ ...txs, approveTx: await wallet.signTransaction(evil) }, /spender/);
    });

    it("a deposit that differs from the approval", async () => {
      const txs = await sign();
      const other = Transaction.from({
        type: 0, chainId: 1990, nonce: 1, gasPrice, gasLimit: ONBOARD_DEPOSIT_GAS, to: s.routerAddress, value: 0n,
        data: routerInterface.encodeFunctionData("deposit", [amount + 1n]),
      });
      await refused({ ...txs, depositTx: await wallet.signTransaction(other) }, /equal the approved amount/);
    });

    it("transactions signed by someone other than the stated payer", async () => {
      await refused(await sign(), /not signed by the payer/, throwawayWallet().address);
    });

    it("an amount above the cap, and a wallet that does not hold the QUSDC", async () => {
      await refused(await sign({ amount: USDC("11") }), /at most/);
      const poor = throwawayWallet();
      const txs = await signOnboarding(poor, { router: s.routerAddress, asset: s.tokenAddress, amount, nonce: 0, gasPrice });
      const out = await s.facilitator.onboard({ payer: poor.address, ...txs });
      expect(out.detail).to.match(/does not hold the QUSDC/);
    });

    it("a transaction for another chain, a type 2 transaction, or one that sends QIE", async () => {
      const base = await sign();
      const otherChain = Transaction.from({
        type: 0, chainId: 1, nonce: 0, gasPrice, gasLimit: ONBOARD_APPROVE_GAS, to: s.tokenAddress, value: 0n,
        data: erc20Interface.encodeFunctionData("approve", [s.routerAddress, amount]),
      });
      await refused({ ...base, approveTx: await wallet.signTransaction(otherChain) }, /another chain/);
      const type2 = Transaction.from({
        type: 2, chainId: 1990, nonce: 0, maxFeePerGas: gasPrice, maxPriorityFeePerGas: 0n, gasLimit: ONBOARD_APPROVE_GAS, to: s.tokenAddress, value: 0n,
        data: erc20Interface.encodeFunctionData("approve", [s.routerAddress, amount]),
      });
      await refused({ ...base, approveTx: await wallet.signTransaction(type2) }, /legacy/);
      const sendsQie = Transaction.from({
        type: 0, chainId: 1990, nonce: 0, gasPrice, gasLimit: ONBOARD_APPROVE_GAS, to: s.tokenAddress, value: 1n,
        data: erc20Interface.encodeFunctionData("approve", [s.routerAddress, amount]),
      });
      await refused({ ...base, approveTx: await wallet.signTransaction(sendsQie) }, /no QIE/);
    });

    it("the wrong destination, a gas limit above the bound, a gas price above the ceiling or below the network's", async () => {
      const base = await sign();
      const wrongTo = Transaction.from({
        type: 0, chainId: 1990, nonce: 0, gasPrice, gasLimit: ONBOARD_APPROVE_GAS, to: s.routerAddress, value: 0n,
        data: erc20Interface.encodeFunctionData("approve", [s.routerAddress, amount]),
      });
      await refused({ ...base, approveTx: await wallet.signTransaction(wrongTo) }, /sent to QUSDC|QUSDC/);
      const hugeGas = Transaction.from({
        type: 0, chainId: 1990, nonce: 0, gasPrice, gasLimit: 5_000_000n, to: s.tokenAddress, value: 0n,
        data: erc20Interface.encodeFunctionData("approve", [s.routerAddress, amount]),
      });
      await refused({ ...base, approveTx: await wallet.signTransaction(hugeGas) }, /gas limit/);
      await refused(await sign({ gasPrice: HARD_CAPS.maxGasPriceWei + 1n }), /ceiling/);
      await refused(await sign({ gasPrice: 1n }), /below the network/);
    });

    it("a nonce that is not the wallet's next, and a body that is not what it should be", async () => {
      await refused(await sign({ nonce: 3 }), /next nonce/);
      for (const body of [null, {}, { payer: wallet.address }, { payer: "nope", approveTx: "0x", depositTx: "0x" }]) {
        const out = await s.facilitator.onboard(body);
        expect(out.ok).to.equal(false);
      }
    });

    it("a second start in the same day, and a start by a wallet that needs more than the top-up cap", async () => {
      expect((await onboard(await sign({ amount: USDC("1") }))).ok).to.equal(true);
      const again = await signOnboarding(wallet, { router: s.routerAddress, asset: s.tokenAddress, amount: USDC("1"), nonce: 2, gasPrice });
      const out = await onboard(again);
      expect(out.ok).to.equal(false);
      expect(out.detail).to.match(/zero-QIE starts/);
    });
  });

  it("will not top up beyond its cap, so a signed gas price cannot make it pay more", async () => {
    const cheap = await startStack({ caps: { maxTopUpWei: 100_000_000_000_000n } }); // 0.0001 QIE: below what two transactions need
    try {
      const w = throwawayWallet();
      await fundWallet(cheap, w, USDC("20"));
      const txs = await signOnboarding(w, { router: cheap.routerAddress, asset: cheap.tokenAddress, amount, nonce: 0, gasPrice });
      const out = await cheap.facilitator.onboard({ payer: w.address, ...txs });
      expect(out.ok).to.equal(false);
      expect(out.detail).to.match(/above the cap/);
      expect(await cheap.provider.getBalance(w.address)).to.equal(0n);
    } finally {
      await cheap.stop();
    }
  });

  it("is reachable over HTTP and through the SDK client", async () => {
    const { approveTx, depositTx } = await sign();
    const out = await new FacilitatorClient({ url: s.facilitatorUrl }).onboard({ payer: wallet.address, approveTx, depositTx });
    expect(out.ok).to.equal(true);
    expect(await s.router.payerBalance(wallet.address)).to.equal(amount);
  });
});

describe("Facilitator: relayed withdrawals and refunds, with no QIE", function () {
  let s: Stack;
  let builder: Wallet;
  let payer: Wallet;
  const price = USDC("1");

  beforeEach(async () => {
    s = await startStack({ feeBps: 100 });
    builder = throwawayWallet();
    payer = throwawayWallet();
    await fundWallet(s, payer, USDC("5"), parseEther("1"));
    await depositFor(s, payer, USDC("5"));
    const m = await makePayment(s, payer, payer.address, requirementsFor(s, builder.address, price));
    await s.facilitator.settle(verifyBody(m));
    await s.facilitator.flush();
  });
  afterEach(async () => {
    await s.stop();
  });

  const signWithdraw = (who: Wallet, to: string, amount: bigint, relayerFee = 0n) => {
    const message = { account: who.address, to, amount, relayerFee, nonce: randomNonce(), deadline: BigInt(s.clock() + 600) };
    return who.signTypedData(routerDomain(s.routerAddress), withdrawTypes, message).then((signature) => ({ message, signature }));
  };
  const body = (kind: "withdraw" | "refund", who: string, m: { to: string; amount: bigint; nonce: string; deadline: bigint }, signature: string) => ({
    kind, account: who, to: m.to, amount: m.amount.toString(), nonce: m.nonce, deadline: m.deadline.toString(), signature,
  });

  it("lets a builder with no QIE withdraw, and the relayer takes no QUSDC", async () => {
    expect(await s.provider.getBalance(builder.address)).to.equal(0n);
    const earned = (await s.router.earnings(builder.address)) as bigint;
    const dest = throwawayWallet().address;
    const { message, signature } = await signWithdraw(builder, dest, earned);
    const out = await s.facilitator.relay(body("withdraw", builder.address, message, signature));
    expect(out.ok).to.equal(true);
    expect(await s.token.balanceOf(dest)).to.equal(earned);
    expect(await s.token.balanceOf(s.relayerAddress)).to.equal(0n);
    expect(await s.router.earnings(builder.address)).to.equal(0n);
  });

  it("lets a payer with no QIE refund", async () => {
    const poor = throwawayWallet();
    await fundWallet(s, poor, USDC("2"), parseEther("1"));
    await depositFor(s, poor, USDC("2"));
    await setQie(poor.address, 0n);
    const dest = throwawayWallet().address;
    const message = { payer: poor.address, to: dest, amount: USDC("2"), relayerFee: 0n, nonce: randomNonce(), deadline: BigInt(s.clock() + 600) };
    const signature = await poor.signTypedData(routerDomain(s.routerAddress), refundTypes, message);
    const out = await s.facilitator.relay(body("refund", poor.address, { ...message, to: dest }, signature));
    expect(out.ok).to.equal(true);
    expect(await s.token.balanceOf(dest)).to.equal(USDC("2"));
  });

  it("refuses a request whose signature includes a relayer fee, because this relayer never takes QUSDC", async () => {
    const earned = (await s.router.earnings(builder.address)) as bigint;
    const { message, signature } = await signWithdraw(builder, throwawayWallet().address, earned, 10n);
    const out = await s.facilitator.relay(body("withdraw", builder.address, message, signature));
    expect(out.ok).to.equal(false);
    expect(out.detail).to.match(/InvalidSignature/);
    expect(await s.token.balanceOf(s.relayerAddress)).to.equal(0n);
  });

  it("refuses an expired request, a replay, an over-withdrawal and a malformed request", async () => {
    const earned = (await s.router.earnings(builder.address)) as bigint;
    const dest = throwawayWallet().address;
    const good = await signWithdraw(builder, dest, earned / 2n);
    expect((await s.facilitator.relay(body("withdraw", builder.address, good.message, good.signature))).ok).to.equal(true);
    const replay = await s.facilitator.relay(body("withdraw", builder.address, good.message, good.signature));
    expect(replay.ok).to.equal(false);
    expect(replay.detail).to.match(/NonceAlreadyUsed/);
    const over = await signWithdraw(builder, dest, earned * 10n);
    expect((await s.facilitator.relay(body("withdraw", builder.address, over.message, over.signature))).detail).to.match(/InsufficientBalance/);
    for (const bad of [null, {}, { kind: "burn" }, { ...body("withdraw", builder.address, good.message, good.signature), amount: "-1" }]) {
      expect((await s.facilitator.relay(bad)).ok).to.equal(false);
    }
  });

  it("limits how many relayed exits one account gets per day", async () => {
    const limited = await startStack({ caps: { relayPerAccountPerDay: 1 } });
    try {
      const b = throwawayWallet();
      const p = throwawayWallet();
      await fundWallet(limited, p, USDC("5"), parseEther("1"));
      await depositFor(limited, p, USDC("5"));
      await limited.facilitator.settle(verifyBody(await makePayment(limited, p, p.address, requirementsFor(limited, b.address, USDC("2")))));
      await limited.facilitator.flush();
      const mk = async () => {
        const message = { account: b.address, to: throwawayWallet().address, amount: 1000n, relayerFee: 0n, nonce: randomNonce(), deadline: BigInt(limited.clock() + 600) };
        const signature = await b.signTypedData(routerDomain(limited.routerAddress), withdrawTypes, message);
        return body("withdraw", b.address, message, signature);
      };
      expect((await limited.facilitator.relay(await mk())).ok).to.equal(true);
      const second = await limited.facilitator.relay(await mk());
      expect(second.ok).to.equal(false);
      expect(second.detail).to.match(/relayed requests/);
    } finally {
      await limited.stop();
    }
  });

  it("is reachable over HTTP", async () => {
    const earned = (await s.router.earnings(builder.address)) as bigint;
    const { message, signature } = await signWithdraw(builder, throwawayWallet().address, earned);
    const out = await new FacilitatorClient({ url: s.facilitatorUrl }).relay({
      kind: "withdraw", account: builder.address, to: message.to, amount: earned.toString(), nonce: message.nonce, deadline: message.deadline.toString(), signature,
    });
    expect(out.ok).to.equal(true);
    expect(getAddress(builder.address)).to.equal(builder.address);
  });
});

describe("Facilitator: relayed agent sessions, with no QIE", function () {
  let s: Stack;
  let owner: Wallet;
  let agent: Wallet;
  let builder: string;

  beforeEach(async () => {
    s = await startStack();
    owner = throwawayWallet();
    agent = throwawayWallet();
    builder = throwawayWallet().address;
    await fundWallet(s, owner, USDC("5"));
  });
  afterEach(async () => {
    await s.stop();
  });

  const tools = () => [{ payee: builder, toolId: toolIdOf("echo") }];
  const grant = () => ({ agent: agent.address, budget: USDC("1"), perCallCap: USDC("0.05"), expiry: BigInt(s.clock() + 3600) });
  const authorizeRequest = async (signer: Wallet = owner, who: string = owner.address) => {
    const deadline = BigInt(s.clock() + 600);
    const nonce = (await s.vault.nonces(who)) as bigint;
    const g = grant();
    const signature = await signAuthorize(signer, s.vaultAddress, { payer: who, grant: g, tools: tools(), nonce, deadline });
    return {
      kind: "authorize" as const,
      payer: who,
      grant: { agent: g.agent, budget: g.budget.toString(), perCallCap: g.perCallCap.toString(), expiry: g.expiry.toString() },
      tools: tools(),
      deadline: deadline.toString(),
      signature,
    };
  };

  it("lets an owner who holds QUSDC and no QIE authorize an agent, and then revoke it, by signature", async () => {
    expect(await s.provider.getBalance(owner.address)).to.equal(0n);
    const out = await s.facilitator.relay(await authorizeRequest());
    expect(out.ok, out.detail).to.equal(true);
    const session = await s.vault.sessionOf(owner.address, agent.address);
    expect(session.budget).to.equal(USDC("1"));
    expect(session.perCallCap).to.equal(USDC("0.05"));
    expect(await s.vault.isToolAllowed(owner.address, agent.address, builder, toolIdOf("echo"))).to.equal(true);

    const deadline = BigInt(s.clock() + 600);
    const nonce = (await s.vault.nonces(owner.address)) as bigint;
    const signature = await signRevoke(owner, s.vaultAddress, { payer: owner.address, agent: agent.address, nonce, deadline });
    const revoked = await s.facilitator.relay({ kind: "revoke", payer: owner.address, agent: agent.address, deadline: deadline.toString(), signature });
    expect(revoked.ok, revoked.detail).to.equal(true);
    expect((await s.vault.sessionOf(owner.address, agent.address)).id).to.equal(0n);
    expect(await s.provider.getBalance(owner.address)).to.equal(0n);
  });

  it("refuses an authorisation signed by anyone but the owner, so an agent cannot raise its own budget", async () => {
    // The agent signs an authorisation that names itself, claiming to be the owner.
    const out = await s.facilitator.relay(await authorizeRequest(agent, owner.address));
    expect(out.ok).to.equal(false);
    expect(out.detail).to.match(/InvalidSignature/);
    expect((await s.vault.sessionOf(owner.address, agent.address)).id).to.equal(0n);
    // And the agent authorising itself as its own payer is refused by the vault.
    const self = await s.facilitator.relay(await authorizeRequest(agent, agent.address));
    expect(self.ok).to.equal(false);
    expect(self.detail).to.match(/InvalidSession/);
  });

  it("refuses an expired or replayed authorisation, an empty or oversized tool list, and a malformed request", async () => {
    const good = await authorizeRequest();
    expect((await s.facilitator.relay(good)).ok).to.equal(true);
    const replay = await s.facilitator.relay(good);
    expect(replay.ok).to.equal(false);
    expect(replay.detail).to.match(/InvalidSignature/); // the vault nonce moved on, so the signed nonce no longer matches
    const late = await authorizeRequest();
    expect((await s.facilitator.relay({ ...late, deadline: String(s.clock() - 10) })).detail).to.match(/Expired|InvalidSignature/);
    expect((await s.facilitator.relay({ ...(await authorizeRequest()), tools: [] })).detail).to.match(/between 1 and 32/);
    expect((await s.facilitator.relay({ ...(await authorizeRequest()), tools: Array(33).fill(tools()[0]) })).detail).to.match(/between 1 and 32/);
    for (const bad of [{ kind: "authorize" }, { kind: "authorize", payer: owner.address, grant: 5, tools: [] }, { kind: "revoke", payer: "x" }, { kind: "mint" }]) {
      expect((await s.facilitator.relay(bad)).ok).to.equal(false);
    }
  });

  it("sends the vault's calls only to the vault, and the relayer's allowlist is still the router and the vault", async () => {
    expect((await s.facilitator.relay(await authorizeRequest())).ok).to.equal(true);
    expect(s.facilitator.relayer.allowlist.sort()).to.deep.equal([s.routerAddress, s.vaultAddress].sort());
  });
});

describe("Facilitator: browser access (CORS)", function () {
  const PAGE = "http://127.0.0.1:3211";
  let s: Stack;
  before(async () => {
    s = await startStack({ corsOrigins: [PAGE] });
  });
  after(async () => {
    await s.stop();
  });

  it("allows no browser origin unless the operator names it: the default server sends no CORS header", async () => {
    const plain = await startStack();
    try {
      const res = await fetch(`${plain.facilitatorUrl}/health`, { headers: { origin: PAGE } });
      expect(res.status).to.equal(200);
      expect(res.headers.get("access-control-allow-origin")).to.equal(null);
      const preflight = await fetch(`${plain.facilitatorUrl}/relay`, { method: "OPTIONS", headers: { origin: PAGE, "access-control-request-method": "POST" } });
      expect(preflight.status).to.equal(404);
      expect(preflight.headers.get("access-control-allow-origin")).to.equal(null);
    } finally {
      await plain.stop();
    }
  });

  it("answers a named origin with exactly that origin, never a wildcard", async () => {
    const res = await fetch(`${s.facilitatorUrl}/health`, { headers: { origin: PAGE } });
    expect(res.headers.get("access-control-allow-origin")).to.equal(PAGE);
    expect(res.headers.get("vary")).to.equal("Origin");
    expect(res.headers.get("access-control-allow-origin")).to.not.equal("*");
  });

  it("gives another origin nothing, so its page cannot read the answer", async () => {
    for (const origin of ["http://127.0.0.1:3999", "https://evil.example", "null", PAGE + ".evil.example"]) {
      const res = await fetch(`${s.facilitatorUrl}/health`, { headers: { origin } });
      expect(res.headers.get("access-control-allow-origin"), origin).to.equal(null);
    }
  });

  it("answers a preflight for a named origin with 204 and the allowed methods and headers, and refuses one for another", async () => {
    const ok = await fetch(`${s.facilitatorUrl}/relay`, { method: "OPTIONS", headers: { origin: PAGE, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
    expect(ok.status).to.equal(204);
    expect(ok.headers.get("access-control-allow-origin")).to.equal(PAGE);
    expect(ok.headers.get("access-control-allow-methods")).to.equal("GET, POST, OPTIONS");
    expect(ok.headers.get("access-control-allow-headers")).to.equal("content-type");
    const no = await fetch(`${s.facilitatorUrl}/relay`, { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    expect(no.status).to.equal(404);
  });

  it("adds the headers to error answers too, so the page can read why", async () => {
    const res = await fetch(`${s.facilitatorUrl}/nothing`, { headers: { origin: PAGE } });
    expect(res.status).to.equal(404);
    expect(res.headers.get("access-control-allow-origin")).to.equal(PAGE);
  });

  it("builds the headers from an exact list only", () => {
    expect(corsHeaders(undefined, { origins: [PAGE] })).to.deep.equal({});
    expect(corsHeaders(PAGE, {})).to.deep.equal({});
    expect(corsHeaders(PAGE, { origins: [] })).to.deep.equal({});
    expect(corsHeaders("http://127.0.0.1:3211/", { origins: [PAGE] })).to.deep.equal({});
    expect(corsHeaders(PAGE, { origins: ["*"] })).to.deep.equal({});
  });

  it("reads the operator's list strictly and refuses to start on a bad entry", () => {
    expect(parseCorsOrigins(undefined)).to.deep.equal([]);
    expect(parseCorsOrigins("")).to.deep.equal([]);
    expect(parseCorsOrigins(" https://app.example , http://localhost:3000, https://app.example")).to.deep.equal(["https://app.example", "http://localhost:3000"]);
    for (const bad of ["*", "https://app.example/path", "http://app.example", "ftp://x.example", "app.example", "https://user:pw@app.example", "https://app.example?x=1", "https://*.example"]) {
      expect(() => parseCorsOrigins(bad), bad).to.throw(/refusing to start/);
    }
  });
});

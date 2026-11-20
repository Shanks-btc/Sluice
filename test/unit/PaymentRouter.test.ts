import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import {
  balances,
  deploy,
  deployContract,
  fundBalance,
  malleate,
  MAX_FEE_BPS,
  newIntent,
  nowSeconds,
  paymentTypes,
  randomNonce,
  routerDomain,
  signedIntent,
  signIntent,
  tamper,
  toolId,
  USDC,
  withdrawTypes,
  refundTypes,
} from "../helpers";

describe("PaymentRouter: deployment", () => {
  it("records its token, owner, fee recipient and fee, and creates its own vault", async () => {
    const w = await deploy({ feeBps: 150 });
    expect(await w.router.token()).to.equal(w.tokenAddress);
    expect(await w.router.owner()).to.equal(w.owner.address);
    expect(await w.router.feeRecipient()).to.equal(w.feeRecipient.address);
    expect(await w.router.feeBps()).to.equal(150);
    expect(await w.router.MAX_FEE_BPS()).to.equal(MAX_FEE_BPS);
    expect(await w.router.totalLiabilities()).to.equal(0);
    expect(await w.vault.router()).to.equal(w.routerAddress);
    expect(await ethers.provider.getCode(w.vaultAddress)).to.not.equal("0x");
  });

  it("accepts a fee of 0 and of exactly the cap", async () => {
    const w = await deploy({ feeBps: 0 });
    expect(await w.router.feeBps()).to.equal(0);
    const atCap = await deploy({ feeBps: MAX_FEE_BPS });
    expect(await atCap.router.feeBps()).to.equal(MAX_FEE_BPS);
  });

  it("refuses a fee above the cap, and zero addresses", async () => {
    const w = await deploy();
    const factory = await ethers.getContractFactory("PaymentRouter");
    await expect(factory.deploy(w.tokenAddress, w.owner.address, w.feeRecipient.address, MAX_FEE_BPS + 1))
      .to.be.revertedWithCustomError(w.router, "FeeTooHigh");
    for (const args of [
      [ethers.ZeroAddress, w.owner.address, w.feeRecipient.address, 100],
      [w.tokenAddress, ethers.ZeroAddress, w.feeRecipient.address, 100],
      [w.tokenAddress, w.owner.address, ethers.ZeroAddress, 100],
    ]) {
      await expect(factory.deploy(...args)).to.be.revertedWithCustomError(w.router, "ZeroAddress");
    }
  });

  it("builds an EIP-712 domain with the chain id and the contract address", async () => {
    const w = await deploy();
    const expected = ethers.TypedDataEncoder.hashDomain(routerDomain(w.routerAddress));
    expect(await w.router.domainSeparator()).to.equal(expected);
    expect(await w.router.domainSeparator()).to.not.equal(
      ethers.TypedDataEncoder.hashDomain(routerDomain(w.routerAddress, 1)),
    );
    // A second router has a different domain, even with the same token and owner.
    const other = await deploy();
    expect(await other.router.domainSeparator()).to.not.equal(await w.router.domainSeparator());
  });

  it("hashes a payment exactly as ethers does", async () => {
    const w = await deploy();
    const intent = await newIntent(w.payer.address, w.builder.address, USDC("0.25"));
    expect(await w.router.hashPayment(intent)).to.equal(
      ethers.TypedDataEncoder.hash(routerDomain(w.routerAddress), paymentTypes, intent),
    );
  });
});

describe("PaymentRouter: deposit", () => {
  it("pulls tokens with approve and transferFrom and credits the prepaid balance", async () => {
    const w = await deploy();
    await w.token.mint(w.payer.address, USDC(5));
    await w.token.connect(w.payer).approve(w.routerAddress, USDC(5));
    await expect(w.router.connect(w.payer).deposit(USDC(3)))
      .to.emit(w.router, "Deposited")
      .withArgs(w.payer.address, w.payer.address, USDC(3));
    expect(await w.router.payerBalance(w.payer.address)).to.equal(USDC(3));
    expect(await w.token.balanceOf(w.routerAddress)).to.equal(USDC(3));
    expect(await w.token.balanceOf(w.payer.address)).to.equal(USDC(2));
    expect(await w.router.totalLiabilities()).to.equal(USDC(3));
  });

  it("refuses zero, and refuses without allowance or without tokens", async () => {
    const w = await deploy();
    await expect(w.router.connect(w.payer).deposit(0)).to.be.revertedWithCustomError(w.router, "ZeroAmount");
    await w.token.mint(w.payer.address, USDC(1));
    await expect(w.router.connect(w.payer).deposit(USDC(1))).to.be.revertedWithCustomError(w.router, "TransferFailed");
    await w.token.connect(w.payer).approve(w.routerAddress, USDC(10));
    await expect(w.router.connect(w.payer).deposit(USDC(2))).to.be.revertedWithCustomError(w.router, "TransferFailed");
    expect(await w.router.payerBalance(w.payer.address)).to.equal(0);
  });

  it("depositFor credits someone else's balance from the caller's wallet", async () => {
    const w = await deploy();
    await w.token.mint(w.stranger.address, USDC(4));
    await w.token.connect(w.stranger).approve(w.routerAddress, USDC(4));
    await expect(w.router.connect(w.stranger).depositFor(w.payer.address, USDC(4)))
      .to.emit(w.router, "Deposited")
      .withArgs(w.payer.address, w.stranger.address, USDC(4));
    expect(await w.router.payerBalance(w.payer.address)).to.equal(USDC(4));
    expect(await w.router.payerBalance(w.stranger.address)).to.equal(0);
    await expect(w.router.connect(w.stranger).depositFor(ethers.ZeroAddress, 1)).to.be.revertedWithCustomError(
      w.router,
      "ZeroAddress",
    );
  });

  it("refuses a token that delivers less than was asked", async () => {
    const w = await deploy();
    const taxed = await deployContract("FeeOnTransferToken");
    const router = await deployContract("PaymentRouter", [
      await taxed.getAddress(),
      w.owner.address,
      w.feeRecipient.address,
      100,
    ]);
    await taxed.mint(w.payer.address, USDC(10));
    await taxed.connect(w.payer).approve(await router.getAddress(), USDC(10));
    await expect(router.connect(w.payer).deposit(USDC(10))).to.be.revertedWithCustomError(
      router,
      "UnexpectedTransferAmount",
    );
  });
});

describe("PaymentRouter: settle", () => {
  it("moves exactly the amount from the payer, pays the builder minus the fee, and credits the fee", async () => {
    const w = await deploy({ feeBps: 100 });
    await fundBalance(w, w.payer, USDC(10));
    const { intent, signature } = await signedIntent(w, w.payer, w.payer.address, w.builder.address, USDC(2));
    await expect(w.router.connect(w.relayer).settle(intent, signature))
      .to.emit(w.router, "Settled")
      .withArgs(w.payer.address, w.builder.address, intent.toolId, USDC(2), USDC("0.02"), intent.nonce, w.payer.address);
    expect(await w.router.payerBalance(w.payer.address)).to.equal(USDC(8));
    expect(await w.router.earnings(w.builder.address)).to.equal(USDC("1.98"));
    expect(await w.router.earnings(w.feeRecipient.address)).to.equal(USDC("0.02"));
    expect(await w.router.nonceUsed(w.payer.address, intent.nonce)).to.equal(true);
    // Nothing left the router: it still holds everything it owes.
    expect(await w.router.totalLiabilities()).to.equal(USDC(10));
    expect(await w.token.balanceOf(w.routerAddress)).to.equal(USDC(10));
  });

  it("can be submitted by anyone, because the signature, not the caller, authorises it", async () => {
    const w = await deploy();
    await fundBalance(w, w.payer, USDC(1));
    const { intent, signature } = await signedIntent(w, w.payer, w.payer.address, w.builder.address, USDC("0.5"));
    await w.router.connect(w.stranger).settle(intent, signature);
    expect(await w.router.payerBalance(w.payer.address)).to.equal(USDC("0.5"));
  });

  it("allows a payment to oneself and treats it like any other", async () => {
    const w = await deploy({ feeBps: 100 });
    await fundBalance(w, w.payer, USDC(1));
    const { intent, signature } = await signedIntent(w, w.payer, w.payer.address, w.payer.address, USDC(1));
    await w.router.settle(intent, signature);
    expect(await w.router.payerBalance(w.payer.address)).to.equal(0);
    expect(await w.router.earnings(w.payer.address)).to.equal(USDC("0.99"));
  });

  it("refuses a zero amount, a zero payee and the router as payee", async () => {
    const w = await deploy();
    await fundBalance(w, w.payer, USDC(1));
    const zero = await signedIntent(w, w.payer, w.payer.address, w.builder.address, 0n);
    await expect(w.router.settle(zero.intent, zero.signature)).to.be.revertedWithCustomError(w.router, "ZeroAmount");
    const noPayee = await signedIntent(w, w.payer, w.payer.address, ethers.ZeroAddress, USDC(1));
    await expect(w.router.settle(noPayee.intent, noPayee.signature)).to.be.revertedWithCustomError(
      w.router,
      "InvalidPayee",
    );
    const toRouter = await signedIntent(w, w.payer, w.payer.address, w.routerAddress, USDC(1));
    await expect(w.router.settle(toRouter.intent, toRouter.signature)).to.be.revertedWithCustomError(
      w.router,
      "InvalidPayee",
    );
  });

  it("refuses an expired intent, and accepts one at its exact deadline", async () => {
    const w = await deploy();
    await fundBalance(w, w.payer, USDC(2));
    const now = await nowSeconds();
    const onTime = await signedIntent(w, w.payer, w.payer.address, w.builder.address, USDC(1), { deadline: now + 100n });
    await time.setNextBlockTimestamp(now + 100n);
    await w.router.settle(onTime.intent, onTime.signature); // block.timestamp == deadline
    const late = await signedIntent(w, w.payer, w.payer.address, w.builder.address, USDC(1), { deadline: now + 100n });
    await time.setNextBlockTimestamp(now + 101n);
    await expect(w.router.settle(late.intent, late.signature)).to.be.revertedWithCustomError(w.router, "Expired");
  });

  it("refuses to settle the same intent twice (replay)", async () => {
    const w = await deploy();
    await fundBalance(w, w.payer, USDC(5));
    const { intent, signature } = await signedIntent(w, w.payer, w.payer.address, w.builder.address, USDC(1));
    await w.router.settle(intent, signature);
    await expect(w.router.settle(intent, signature)).to.be.revertedWithCustomError(w.router, "NonceAlreadyUsed");
    expect(await w.router.payerBalance(w.payer.address)).to.equal(USDC(4));
  });

  it("refuses an intent the prepaid balance cannot cover, and changes nothing", async () => {
    const w = await deploy();
    await fundBalance(w, w.payer, USDC(1));
    const { intent, signature } = await signedIntent(w, w.payer, w.payer.address, w.builder.address, USDC("1.000001"));
    await expect(w.router.settle(intent, signature)).to.be.revertedWithCustomError(w.router, "InsufficientBalance");
    expect(await w.router.payerBalance(w.payer.address)).to.equal(USDC(1));
    expect(await w.router.nonceUsed(w.payer.address, intent.nonce)).to.equal(false);
  });

  it("refuses an intent signed by someone who is neither the payer nor the payer's agent", async () => {
    const w = await deploy();
    await fundBalance(w, w.payer, USDC(1));
    const { intent, signature } = await signedIntent(w, w.stranger, w.payer.address, w.builder.address, USDC(1));
    await expect(w.router.settle(intent, signature)).to.be.revertedWithCustomError(w.router, "SessionNotFound");
  });

  it("refuses an intent changed after it was signed, in any field", async () => {
    const w = await deploy();
    await fundBalance(w, w.payer, USDC(10));
    const { intent, signature } = await signedIntent(w, w.payer, w.payer.address, w.builder.address, USDC(1));
    const changes = [
      { amount: USDC(2) },
      { payee: w.other.address },
      { toolId: toolId("another") },
      { nonce: randomNonce() },
      { deadline: intent.deadline + 1n },
    ];
    for (const change of changes) {
      await expect(w.router.settle({ ...intent, ...change }, signature)).to.be.revertedWithCustomError(
        w.router,
        "SessionNotFound",
      );
    }
    // The original still works: none of the attempts burned its nonce.
    await w.router.settle(intent, signature);
  });

  it("refuses malformed signatures: wrong length, bad v, a high-s twin", async () => {
    const w = await deploy();
    await fundBalance(w, w.payer, USDC(5));
    const { intent, signature } = await signedIntent(w, w.payer, w.payer.address, w.builder.address, USDC(1));
    await expect(w.router.settle(intent, signature.slice(0, -2))).to.be.revertedWithCustomError(
      w.router,
      "InvalidSignature",
    );
    await expect(w.router.settle(intent, `${signature}00`)).to.be.revertedWithCustomError(w.router, "InvalidSignature");
    const badV = `${signature.slice(0, -2)}1d`; // v = 29
    await expect(w.router.settle(intent, badV)).to.be.revertedWithCustomError(w.router, "InvalidSignature");
    await expect(w.router.settle(intent, malleate(signature))).to.be.revertedWithCustomError(w.router, "InvalidSignature");
    await expect(w.router.settle(intent, "0x")).to.be.revertedWithCustomError(w.router, "InvalidSignature");
    await w.router.settle(intent, signature);
  });

  it("refuses a signature that recovers to nobody useful", async () => {
    const w = await deploy();
    await fundBalance(w, w.payer, USDC(1));
    const { intent, signature } = await signedIntent(w, w.payer, w.payer.address, w.builder.address, USDC(1));
    await expect(w.router.settle(intent, tamper(signature))).to.be.reverted;
  });

  it("refuses a signature made for another chain, another contract or another domain name", async () => {
    const w = await deploy();
    const other = await deploy();
    await fundBalance(w, w.payer, USDC(5));
    const intent = await newIntent(w.payer.address, w.builder.address, USDC(1));
    const wrongChain = await w.payer.signTypedData(routerDomain(w.routerAddress, 1), paymentTypes, intent);
    const wrongContract = await w.payer.signTypedData(routerDomain(other.routerAddress), paymentTypes, intent);
    const wrongName = await w.payer.signTypedData(
      { name: "SomethingElse", version: "1", chainId: 1990, verifyingContract: w.routerAddress },
      paymentTypes,
      intent,
    );
    const wrongVersion = await w.payer.signTypedData(
      { name: "SluiceRouter", version: "2", chainId: 1990, verifyingContract: w.routerAddress },
      paymentTypes,
      intent,
    );
    for (const bad of [wrongChain, wrongContract, wrongName, wrongVersion]) {
      await expect(w.router.settle(intent, bad)).to.be.revertedWithCustomError(w.router, "SessionNotFound");
    }
    await w.router.settle(intent, await signIntent(w.payer, w.routerAddress, intent));
  });

  it("does not let a signature for one router settle on another router with the same token", async () => {
    const a = await deploy();
    const b = await deploy();
    await fundBalance(a, a.payer, USDC(2));
    await b.token.mint(a.payer.address, USDC(2));
    await b.token.connect(a.payer).approve(b.routerAddress, USDC(2));
    await b.router.connect(a.payer).deposit(USDC(2));
    const { intent, signature } = await signedIntent(a, a.payer, a.payer.address, a.builder.address, USDC(1));
    await expect(b.router.settle(intent, signature)).to.be.revertedWithCustomError(b.router, "SessionNotFound");
    await a.router.settle(intent, signature);
  });

  it("lets a signer cancel a nonce they have not used, and only their own", async () => {
    const w = await deploy();
    await fundBalance(w, w.payer, USDC(3));
    const { intent, signature } = await signedIntent(w, w.payer, w.payer.address, w.builder.address, USDC(1));
    await expect(w.router.connect(w.stranger).cancelNonce(intent.nonce))
      .to.emit(w.router, "NonceCancelled")
      .withArgs(w.stranger.address, intent.nonce);
    await w.router.settle(intent, signature); // the stranger's cancel did not touch the payer's nonce
    const second = await signedIntent(w, w.payer, w.payer.address, w.builder.address, USDC(1));
    await w.router.connect(w.payer).cancelNonce(second.intent.nonce);
    await expect(w.router.settle(second.intent, second.signature)).to.be.revertedWithCustomError(
      w.router,
      "NonceAlreadyUsed",
    );
  });
});

describe("PaymentRouter: fee, rounding and the owner", () => {
  const cases: Array<[number, bigint, bigint]> = [
    // feeBps, amount in units, expected fee in units
    [100, 99n, 0n],
    [100, 100n, 1n],
    [100, 199n, 1n],
    [100, 10_000n, 100n],
    [200, 1n, 0n],
    [200, 50n, 1n],
    [200, 12_345_678n, 246_913n],
    [1, 10_000n, 1n],
    [1, 9_999n, 0n],
    [0, 1_000_000n, 0n],
  ];
  for (const [bps, amount, fee] of cases) {
    it(`at ${bps} bps, ${amount} units pays a fee of ${fee} and the builder keeps the rest`, async () => {
      const w = await deploy({ feeBps: bps });
      await fundBalance(w, w.payer, amount);
      const { intent, signature } = await signedIntent(w, w.payer, w.payer.address, w.builder.address, amount);
      await w.router.settle(intent, signature);
      expect(await w.router.earnings(w.builder.address)).to.equal(amount - fee);
      expect(await w.router.earnings(w.feeRecipient.address)).to.equal(fee);
      expect(fee).to.be.lte((amount * BigInt(MAX_FEE_BPS)) / 10_000n);
    });
  }

  it("lets the owner change the fee within the cap, with an event, and applies it to later settlements", async () => {
    const w = await deploy({ feeBps: 100 });
    await fundBalance(w, w.payer, USDC(10));
    await expect(w.router.connect(w.owner).setFee(MAX_FEE_BPS)).to.emit(w.router, "FeeChanged").withArgs(100, MAX_FEE_BPS);
    const a = await signedIntent(w, w.payer, w.payer.address, w.builder.address, USDC(1));
    await w.router.settle(a.intent, a.signature);
    expect(await w.router.earnings(w.feeRecipient.address)).to.equal(USDC("0.02"));
    await w.router.connect(w.owner).setFee(0);
    const b = await signedIntent(w, w.payer, w.payer.address, w.builder.address, USDC(1));
    await w.router.settle(b.intent, b.signature);
    expect(await w.router.earnings(w.feeRecipient.address)).to.equal(USDC("0.02"));
  });

  it("never changes what a payer pays when the fee changes", async () => {
    const w = await deploy({ feeBps: 0 });
    await fundBalance(w, w.payer, USDC(10));
    await w.router.connect(w.owner).setFee(MAX_FEE_BPS);
    const { intent, signature } = await signedIntent(w, w.payer, w.payer.address, w.builder.address, USDC(3));
    await w.router.settle(intent, signature);
    expect(await w.router.payerBalance(w.payer.address)).to.equal(USDC(7));
  });

  it("refuses a fee above the cap, and refuses anyone but the owner", async () => {
    const w = await deploy();
    await expect(w.router.connect(w.owner).setFee(MAX_FEE_BPS + 1)).to.be.revertedWithCustomError(w.router, "FeeTooHigh");
    await expect(w.router.connect(w.owner).setFee(65_535)).to.be.revertedWithCustomError(w.router, "FeeTooHigh");
    await expect(w.router.connect(w.stranger).setFee(1)).to.be.revertedWithCustomError(w.router, "NotOwner");
    await expect(w.router.connect(w.feeRecipient).setFee(1)).to.be.revertedWithCustomError(w.router, "NotOwner");
    await expect(w.router.connect(w.stranger).setFeeRecipient(w.stranger.address)).to.be.revertedWithCustomError(
      w.router,
      "NotOwner",
    );
  });

  it("lets the owner change the fee recipient, and fees already credited stay with the old one", async () => {
    const w = await deploy({ feeBps: 100 });
    await fundBalance(w, w.payer, USDC(10));
    const first = await signedIntent(w, w.payer, w.payer.address, w.builder.address, USDC(1));
    await w.router.settle(first.intent, first.signature);
    await expect(w.router.connect(w.owner).setFeeRecipient(w.other.address))
      .to.emit(w.router, "FeeRecipientChanged")
      .withArgs(w.feeRecipient.address, w.other.address);
    const second = await signedIntent(w, w.payer, w.payer.address, w.builder.address, USDC(1));
    await w.router.settle(second.intent, second.signature);
    expect(await w.router.earnings(w.feeRecipient.address)).to.equal(USDC("0.01"));
    expect(await w.router.earnings(w.other.address)).to.equal(USDC("0.01"));
    await expect(w.router.connect(w.owner).setFeeRecipient(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      w.router,
      "ZeroAddress",
    );
  });
});

describe("PaymentRouter: batchSettle", () => {
  it("settles many intents from many payers in one transaction and counts them", async () => {
    const w = await deploy({ feeBps: 100 });
    await fundBalance(w, w.payer, USDC(5));
    await fundBalance(w, w.other, USDC(5));
    const items = [
      await signedIntent(w, w.payer, w.payer.address, w.builder.address, USDC(1)),
      await signedIntent(w, w.other, w.other.address, w.builder.address, USDC(2)),
      await signedIntent(w, w.payer, w.payer.address, w.stranger.address, USDC(1)),
    ];
    const args = [items.map((i) => i.intent), items.map((i) => i.signature)];
    expect(await w.router.connect(w.relayer).batchSettle.staticCall(...args)).to.equal(3);
    await expect(w.router.connect(w.relayer).batchSettle(...args)).to.emit(w.router, "Settled");
    expect(await w.router.payerBalance(w.payer.address)).to.equal(USDC(3));
    expect(await w.router.payerBalance(w.other.address)).to.equal(USDC(3));
    expect(await w.router.earnings(w.builder.address)).to.equal(USDC("2.97"));
    expect(await w.router.earnings(w.stranger.address)).to.equal(USDC("0.99"));
  });

  it("skips an intent that cannot be settled, reports why, and settles the others", async () => {
    const w = await deploy();
    await fundBalance(w, w.payer, USDC(2));
    const now = await nowSeconds();
    const good = await signedIntent(w, w.payer, w.payer.address, w.builder.address, USDC(1));
    const expired = await signedIntent(w, w.payer, w.payer.address, w.builder.address, USDC(1), { deadline: now - 1n });
    const tooBig = await signedIntent(w, w.payer, w.payer.address, w.builder.address, USDC(99));
    const forged = await signedIntent(w, w.stranger, w.payer.address, w.builder.address, USDC(1));
    const items = [expired, good, tooBig, forged];
    const args = [items.map((i) => i.intent), items.map((i) => i.signature)];
    const tx = await w.router.batchSettle(...args);
    const selector = (name: string) => w.router.interface.getError(name)!.selector;
    await expect(tx).to.emit(w.router, "SettleSkipped").withArgs(0, w.payer.address, expired.intent.nonce, selector("Expired"));
    await expect(tx).to.emit(w.router, "SettleSkipped").withArgs(2, w.payer.address, tooBig.intent.nonce, selector("InsufficientBalance"));
    await expect(tx).to.emit(w.router, "SettleSkipped").withArgs(3, w.payer.address, forged.intent.nonce, selector("SessionNotFound"));
    expect(await w.router.payerBalance(w.payer.address)).to.equal(USDC(1));
    // The skipped intents did not burn their nonces.
    expect(await w.router.nonceUsed(w.payer.address, tooBig.intent.nonce)).to.equal(false);
    expect(await w.router.nonceUsed(w.payer.address, good.intent.nonce)).to.equal(true);
  });

  it("skips a repeat of an intent already in the same batch", async () => {
    const w = await deploy();
    await fundBalance(w, w.payer, USDC(5));
    const one = await signedIntent(w, w.payer, w.payer.address, w.builder.address, USDC(1));
    const args = [[one.intent, one.intent], [one.signature, one.signature]];
    expect(await w.router.batchSettle.staticCall(...args)).to.equal(1);
    await w.router.batchSettle(...args);
    expect(await w.router.payerBalance(w.payer.address)).to.equal(USDC(4));
  });

  it("stops spending when the balance runs out part-way through a batch", async () => {
    const w = await deploy();
    await fundBalance(w, w.payer, USDC(2));
    const items = [];
    for (let i = 0; i < 4; i++) items.push(await signedIntent(w, w.payer, w.payer.address, w.builder.address, USDC(1)));
    const args = [items.map((i) => i.intent), items.map((i) => i.signature)];
    expect(await w.router.batchSettle.staticCall(...args)).to.equal(2);
    await w.router.batchSettle(...args);
    expect(await w.router.payerBalance(w.payer.address)).to.equal(0);
  });

  it("refuses an empty batch and mismatched arrays", async () => {
    const w = await deploy();
    await expect(w.router.batchSettle([], [])).to.be.revertedWithCustomError(w.router, "EmptyBatch");
    const one = await signedIntent(w, w.payer, w.payer.address, w.builder.address, USDC(1));
    await expect(w.router.batchSettle([one.intent], [])).to.be.revertedWithCustomError(w.router, "ArrayLengthMismatch");
    await expect(w.router.batchSettle([one.intent], [one.signature, one.signature])).to.be.revertedWithCustomError(
      w.router,
      "ArrayLengthMismatch",
    );
  });
});

describe("PaymentRouter: builder withdrawals", () => {
  async function earned() {
    const w = await deploy({ feeBps: 100 });
    await fundBalance(w, w.payer, USDC(10));
    const { intent, signature } = await signedIntent(w, w.payer, w.payer.address, w.builder.address, USDC(10));
    await w.router.settle(intent, signature);
    return w; // the builder has 9.90 earned
  }

  it("lets a builder withdraw part or all of their earnings to any address, with no delay", async () => {
    const w = await earned();
    await expect(w.router.connect(w.builder).withdraw(USDC(4), w.builder.address))
      .to.emit(w.router, "Withdrawn")
      .withArgs(w.builder.address, w.builder.address, USDC(4), ethers.ZeroAddress, 0);
    await w.router.connect(w.builder).withdraw(USDC("5.9"), w.stranger.address);
    expect(await w.token.balanceOf(w.builder.address)).to.equal(USDC(4));
    expect(await w.token.balanceOf(w.stranger.address)).to.equal(USDC("5.9"));
    expect(await w.router.earnings(w.builder.address)).to.equal(0);
    expect(await w.router.totalLiabilities()).to.equal(USDC("0.1")); // only the fee is left
  });

  it("refuses zero, more than earned, someone else's earnings and a zero destination", async () => {
    const w = await earned();
    await expect(w.router.connect(w.builder).withdraw(0, w.builder.address)).to.be.revertedWithCustomError(w.router, "ZeroAmount");
    await expect(w.router.connect(w.builder).withdraw(USDC("9.900001"), w.builder.address)).to.be.revertedWithCustomError(
      w.router,
      "InsufficientBalance",
    );
    await expect(w.router.connect(w.stranger).withdraw(1, w.stranger.address)).to.be.revertedWithCustomError(
      w.router,
      "InsufficientBalance",
    );
    await expect(w.router.connect(w.builder).withdraw(1, ethers.ZeroAddress)).to.be.revertedWithCustomError(w.router, "ZeroAddress");
  });

  it("does not let a payer's prepaid balance be withdrawn as earnings", async () => {
    const w = await deploy();
    await fundBalance(w, w.payer, USDC(3));
    await expect(w.router.connect(w.payer).withdraw(USDC(1), w.payer.address)).to.be.revertedWithCustomError(
      w.router,
      "InsufficientBalance",
    );
  });

  describe("withdrawBySig, for a builder who holds no QIE", () => {
    async function builderWithNoQie() {
      const w = await deploy({ feeBps: 100 });
      const builder = ethers.Wallet.createRandom(); // never funded: it only signs
      await fundBalance(w, w.payer, USDC(10));
      const { intent, signature } = await signedIntent(w, w.payer, w.payer.address, builder.address, USDC(10));
      await w.router.settle(intent, signature);
      expect(await ethers.provider.getBalance(builder.address)).to.equal(0);
      return { w, builder };
    }
    const sign = async (
      w: Awaited<ReturnType<typeof deploy>>,
      builder: { address: string; signTypedData: (...a: never[]) => Promise<string> },
      over: Record<string, unknown> = {},
    ) => {
      const request = {
        account: builder.address,
        to: builder.address,
        amount: USDC(9),
        relayerFee: USDC("0.01"),
        nonce: randomNonce(),
        deadline: (await nowSeconds()) + 3600n,
        ...over,
      };
      const signature = await (builder as unknown as { signTypedData: (d: unknown, t: unknown, v: unknown) => Promise<string> }).signTypedData(
        routerDomain(w.routerAddress),
        withdrawTypes,
        request,
      );
      return { request, signature };
    };
    const submit = (w: Awaited<ReturnType<typeof deploy>>, r: Record<string, unknown>, signature: string) =>
      w.router
        .connect(w.relayer)
        .withdrawBySig(r.account, r.to, r.amount, r.relayerFee, r.nonce, r.deadline, signature);

    it("pays the builder, and pays the relayer the fee the builder chose, out of the withdrawal", async () => {
      const { w, builder } = await builderWithNoQie();
      const { request, signature } = await sign(w, builder);
      await expect(submit(w, request, signature))
        .to.emit(w.router, "Withdrawn")
        .withArgs(builder.address, builder.address, USDC(9), w.relayer.address, USDC("0.01"));
      expect(await w.token.balanceOf(builder.address)).to.equal(USDC("8.99"));
      expect(await w.token.balanceOf(w.relayer.address)).to.equal(USDC("0.01"));
      expect(await w.router.earnings(builder.address)).to.equal(USDC("0.9"));
      expect(await ethers.provider.getBalance(builder.address)).to.equal(0);
    });

    it("works with no relayer fee, and with a fee equal to the whole amount", async () => {
      const { w, builder } = await builderWithNoQie();
      const none = await sign(w, builder, { relayerFee: 0n });
      await submit(w, none.request, none.signature);
      expect(await w.token.balanceOf(builder.address)).to.equal(USDC(9));
      const all = await sign(w, builder, { amount: USDC("0.9"), relayerFee: USDC("0.9") });
      await submit(w, all.request, all.signature);
      expect(await w.token.balanceOf(w.relayer.address)).to.equal(USDC("0.9"));
    });

    it("refuses a replay, an expired request, a wrong signer and a fee above the amount", async () => {
      const { w, builder } = await builderWithNoQie();
      const ok = await sign(w, builder);
      await submit(w, ok.request, ok.signature);
      await expect(submit(w, ok.request, ok.signature)).to.be.revertedWithCustomError(w.router, "NonceAlreadyUsed");
      const expired = await sign(w, builder, { deadline: (await nowSeconds()) - 1n });
      await expect(submit(w, expired.request, expired.signature)).to.be.revertedWithCustomError(w.router, "Expired");
      const stranger = ethers.Wallet.createRandom();
      const forged = await sign(w, stranger, { account: builder.address });
      await expect(submit(w, forged.request, forged.signature)).to.be.revertedWithCustomError(w.router, "InvalidSignature");
      const greedy = await sign(w, builder, { amount: USDC(1), relayerFee: USDC(2) });
      await expect(submit(w, greedy.request, greedy.signature)).to.be.revertedWithCustomError(w.router, "RelayerFeeTooHigh");
    });

    it("refuses a request changed after signing: destination, amount or fee", async () => {
      const { w, builder } = await builderWithNoQie();
      const { request, signature } = await sign(w, builder);
      for (const change of [{ to: w.stranger.address }, { amount: USDC(5) }, { relayerFee: USDC(1) }]) {
        await expect(submit(w, { ...request, ...change }, signature)).to.be.revertedWithCustomError(w.router, "InvalidSignature");
      }
      await submit(w, request, signature);
    });

    it("refuses a withdrawal larger than the earnings, and a request signed for refund", async () => {
      const { w, builder } = await builderWithNoQie();
      const big = await sign(w, builder, { amount: USDC(50), relayerFee: 0n });
      await expect(submit(w, big.request, big.signature)).to.be.revertedWithCustomError(w.router, "InsufficientBalance");
      // A signature for the Refund type has different typed data, so it cannot be used as a withdrawal.
      const request = {
        payer: builder.address,
        to: builder.address,
        amount: USDC(1),
        relayerFee: 0n,
        nonce: randomNonce(),
        deadline: (await nowSeconds()) + 3600n,
      };
      const asRefund = await builder.signTypedData(routerDomain(w.routerAddress), refundTypes, request);
      await expect(
        w.router.withdrawBySig(request.payer, request.to, request.amount, request.relayerFee, request.nonce, request.deadline, asRefund),
      ).to.be.revertedWithCustomError(w.router, "InvalidSignature");
    });
  });
});

describe("PaymentRouter: payer refunds", () => {
  it("lets a payer take back any part of the unspent balance at any time", async () => {
    const w = await deploy();
    await fundBalance(w, w.payer, USDC(10));
    await expect(w.router.connect(w.payer).refund(USDC(4), w.payer.address))
      .to.emit(w.router, "Refunded")
      .withArgs(w.payer.address, w.payer.address, USDC(4), ethers.ZeroAddress, 0);
    await w.router.connect(w.payer).refund(USDC(6), w.stranger.address);
    expect(await w.token.balanceOf(w.payer.address)).to.equal(USDC(4));
    expect(await w.token.balanceOf(w.stranger.address)).to.equal(USDC(6));
    expect(await w.router.payerBalance(w.payer.address)).to.equal(0);
    expect(await w.router.totalLiabilities()).to.equal(0);
  });

  it("works while signed intents are outstanding: they then fail for lack of balance", async () => {
    const w = await deploy();
    await fundBalance(w, w.payer, USDC(5));
    const pending = await signedIntent(w, w.payer, w.payer.address, w.builder.address, USDC(5));
    await w.router.connect(w.payer).refund(USDC(5), w.payer.address);
    await expect(w.router.settle(pending.intent, pending.signature)).to.be.revertedWithCustomError(w.router, "InsufficientBalance");
  });

  it("refuses zero, more than the balance, and a zero destination", async () => {
    const w = await deploy();
    await fundBalance(w, w.payer, USDC(1));
    await expect(w.router.connect(w.payer).refund(0, w.payer.address)).to.be.revertedWithCustomError(w.router, "ZeroAmount");
    await expect(w.router.connect(w.payer).refund(USDC("1.000001"), w.payer.address)).to.be.revertedWithCustomError(
      w.router,
      "InsufficientBalance",
    );
    await expect(w.router.connect(w.payer).refund(1, ethers.ZeroAddress)).to.be.revertedWithCustomError(w.router, "ZeroAddress");
  });

  it("refundBySig lets a payer with no QIE take their balance back through a relayer", async () => {
    const w = await deploy();
    const payer = ethers.Wallet.createRandom();
    await w.token.mint(w.other.address, USDC(5));
    await w.token.connect(w.other).approve(w.routerAddress, USDC(5));
    await w.router.connect(w.other).depositFor(payer.address, USDC(5));
    const request = {
      payer: payer.address,
      to: payer.address,
      amount: USDC(5),
      relayerFee: USDC("0.05"),
      nonce: randomNonce(),
      deadline: (await nowSeconds()) + 3600n,
    };
    const signature = await payer.signTypedData(routerDomain(w.routerAddress), refundTypes, request);
    await expect(
      w.router
        .connect(w.relayer)
        .refundBySig(request.payer, request.to, request.amount, request.relayerFee, request.nonce, request.deadline, signature),
    )
      .to.emit(w.router, "Refunded")
      .withArgs(payer.address, payer.address, USDC(5), w.relayer.address, USDC("0.05"));
    expect(await w.token.balanceOf(payer.address)).to.equal(USDC("4.95"));
    expect(await w.token.balanceOf(w.relayer.address)).to.equal(USDC("0.05"));
    // Replay, and a request signed by another key.
    await expect(
      w.router
        .connect(w.relayer)
        .refundBySig(request.payer, request.to, request.amount, request.relayerFee, request.nonce, request.deadline, signature),
    ).to.be.revertedWithCustomError(w.router, "NonceAlreadyUsed");
    const other = { ...request, nonce: randomNonce() };
    const forged = await ethers.Wallet.createRandom().signTypedData(routerDomain(w.routerAddress), refundTypes, other);
    await expect(
      w.router.refundBySig(other.payer, other.to, other.amount, other.relayerFee, other.nonce, other.deadline, forged),
    ).to.be.revertedWithCustomError(w.router, "InvalidSignature");
  });
});

describe("PaymentRouter: reentrancy", () => {
  async function withReentrantToken() {
    const w = await deploy();
    const token = await deployContract("ReentrantToken");
    const router = await deployContract("PaymentRouter", [
      await token.getAddress(),
      w.owner.address,
      w.feeRecipient.address,
      100,
    ]);
    return { w, token, router, routerAddress: await router.getAddress() };
  }
  const reentrancy = (router: { interface: { getError(n: string): { selector: string } | null } }) =>
    router.interface.getError("Reentrancy")!.selector;

  it("refuses a call back into the router while a deposit is moving tokens", async () => {
    const { w, token, router, routerAddress } = await withReentrantToken();
    await token.mint(w.payer.address, USDC(2));
    await token.connect(w.payer).approve(routerAddress, USDC(2));
    await token.arm(routerAddress, router.interface.encodeFunctionData("withdraw", [1, w.payer.address]));
    await router.connect(w.payer).deposit(USDC(2));
    expect(await token.attempted()).to.equal(true);
    expect(await token.lastRefusal()).to.equal(reentrancy(router));
  });

  it("refuses a call back into the router while a withdrawal is moving tokens", async () => {
    const { w, token, router, routerAddress } = await withReentrantToken();
    await token.mint(w.payer.address, USDC(2));
    await token.connect(w.payer).approve(routerAddress, USDC(2));
    await router.connect(w.payer).deposit(USDC(2));
    const intent = await newIntent(w.payer.address, w.builder.address, USDC(1), {});
    await router.settle(intent, await signIntent(w.payer, routerAddress, intent));
    await token.arm(routerAddress, router.interface.encodeFunctionData("refund", [1, w.payer.address]));
    await router.connect(w.builder).withdraw(USDC("0.99"), w.builder.address);
    expect(await token.attempted()).to.equal(true);
    expect(await token.lastRefusal()).to.equal(reentrancy(router));
  });

  it("refuses a call back into the router while a refund is moving tokens", async () => {
    const { w, token, router, routerAddress } = await withReentrantToken();
    await token.mint(w.payer.address, USDC(2));
    await token.connect(w.payer).approve(routerAddress, USDC(2));
    await router.connect(w.payer).deposit(USDC(2));
    await token.arm(routerAddress, router.interface.encodeFunctionData("deposit", [1]));
    await router.connect(w.payer).refund(USDC(1), w.payer.address);
    expect(await token.attempted()).to.equal(true);
    expect(await token.lastRefusal()).to.equal(reentrancy(router));
  });
});

describe("PaymentRouter: solvency", () => {
  it("holds exactly what it owes after deposits, settlements, withdrawals and refunds", async () => {
    const w = await deploy({ feeBps: 100 });
    await fundBalance(w, w.payer, USDC(10));
    await fundBalance(w, w.other, USDC(5));
    const a = await signedIntent(w, w.payer, w.payer.address, w.builder.address, USDC(3));
    await w.router.settle(a.intent, a.signature);
    await w.router.connect(w.builder).withdraw(USDC(1), w.builder.address);
    await w.router.connect(w.other).refund(USDC(2), w.other.address);
    const [held, owed] = await w.router.solvency();
    expect(held).to.equal(owed);
    expect(owed).to.equal(await w.router.totalLiabilities());
    const sum =
      (await w.router.payerBalance(w.payer.address)) +
      (await w.router.payerBalance(w.other.address)) +
      (await w.router.earnings(w.builder.address)) +
      (await w.router.earnings(w.feeRecipient.address));
    expect(sum).to.equal(owed);
  });

  it("does not count tokens sent straight to it as owed to anyone, and nobody can take them", async () => {
    const w = await deploy();
    await w.token.mint(w.stranger.address, USDC(7));
    await w.token.connect(w.stranger).transfer(w.routerAddress, USDC(7));
    const [held, owed] = await w.router.solvency();
    expect(held).to.equal(USDC(7));
    expect(owed).to.equal(0);
    await expect(w.router.connect(w.stranger).withdraw(1, w.stranger.address)).to.be.revertedWithCustomError(w.router, "InsufficientBalance");
    await expect(w.router.connect(w.owner).withdraw(1, w.owner.address)).to.be.revertedWithCustomError(w.router, "InsufficientBalance");
  });

  it("shows a shortfall when the token itself removes the router's tokens, and withdrawals then fail loudly", async () => {
    const w = await deploy();
    await fundBalance(w, w.payer, USDC(10));
    await w.token.burnFrom(w.routerAddress, USDC(4)); // what a token admin with a burn role could do
    const [held, owed] = await w.router.solvency();
    expect(owed - held).to.equal(USDC(4));
    await expect(w.router.connect(w.payer).refund(USDC(10), w.payer.address)).to.be.revertedWithCustomError(w.router, "TransferFailed");
    await w.router.connect(w.payer).refund(USDC(6), w.payer.address); // the part that is still there
    expect(await w.token.balanceOf(w.payer.address)).to.equal(USDC(6));
  });

  it("reads balances through one helper the same way the ledger does", async () => {
    const w = await deploy();
    await fundBalance(w, w.payer, USDC(1));
    const b = await balances(w.router, w.token, w.payer.address);
    expect(b).to.deep.equal({ prepaid: USDC(1), earned: 0n, wallet: 0n });
  });
});

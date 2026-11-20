// Tests against a local fork of QIE mainnet (pnpm test:fork). The fork is held in memory: nothing is sent to
// QIE, no key is used, and accounts that need QUSDC get it by impersonating QUSDC's own vault locally.
import { expect } from "chai";
import { ethers } from "hardhat";
import {
  authorizeTypes,
  fundBalance,
  nowSeconds,
  randomNonce,
  refundTypes,
  revokeTypes,
  routerDomain,
  signedIntent,
  toolId,
  USDC,
  vaultDomain,
  withdrawTypes,
} from "../helpers";
import {
  asAccount,
  deployOnFork,
  MISSING_ON_QIE,
  mintQusdc,
  QUSDC,
  QUSDC_ADMIN,
  QUSDC_VAULT,
  realQusdc,
} from "../helpers/fork";

const EIP1967_SLOTS = [
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc", // implementation
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103", // admin
  "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50", // beacon
];

describe("Fork: QUSDC as it is on QIE mainnet", function () {
  this.timeout(600_000);

  it("is QUSDC, with 6 decimals", async () => {
    const token = await realQusdc();
    expect(await token.name()).to.equal("QUSDC");
    expect(await token.symbol()).to.equal("QUSDC");
    expect(Number(await token.decimals())).to.equal(6);
    expect(await token.totalSupply()).to.be.greaterThan(0n);
    expect((await ethers.provider.getCode(QUSDC)).length).to.be.greaterThan(2);
  });

  it("has no permit, no EIP-2612 domain and no EIP-3009: so deposits must be approve then transferFrom", async () => {
    const calls: Array<[string, string]> = [
      ["DOMAIN_SEPARATOR()", "0x3644e515"],
      ["nonces(address)", "0x7ecebe00" + "00".repeat(32)],
      ["permit(address,address,uint256,uint256,uint8,bytes32,bytes32)", "0xd505accf" + "00".repeat(32 * 7)],
      ["transferWithAuthorization(...)", "0xe3ee160e" + "00".repeat(32 * 9)],
      ["receiveWithAuthorization(...)", "0xef55bec6" + "00".repeat(32 * 9)],
    ];
    for (const [name, data] of calls) {
      let reverted = false;
      try {
        await ethers.provider.call({ to: QUSDC, data });
      } catch {
        reverted = true;
      }
      expect(reverted, `${name} should not exist on QUSDC`).to.equal(true);
    }
  });

  it("is not an upgradeable proxy: the EIP-1967 slots are empty", async () => {
    for (const slot of EIP1967_SLOTS) {
      expect(await ethers.provider.getStorage(QUSDC, slot)).to.equal(ethers.ZeroHash);
    }
  });

  it("lets its vault mint and burn, and its admin grant that power: the admin can burn any holder's balance", async () => {
    const token = await realQusdc();
    const vaultRole: string = await token.VAULT_ROLE();
    const adminRole: string = await token.DEFAULT_ADMIN_ROLE();
    expect(vaultRole).to.equal("0x31e0210044b4f6757ce6aa31f9c6e8d4896d24a755014887391a926c5224d959");
    expect(await token.hasRole(vaultRole, QUSDC_VAULT)).to.equal(true);
    expect(await token.hasRole(adminRole, QUSDC_ADMIN)).to.equal(true);
    expect(await token.hasRole(vaultRole, QUSDC_ADMIN), "the admin does not hold the vault role yet").to.equal(false);
    // Without the role nobody can mint.
    const [, , , , , stranger] = await ethers.getSigners();
    await expect(token.connect(stranger!).mint(stranger!.address, 1n)).to.be.reverted;
    await asAccount(QUSDC_ADMIN, async (admin) => {
      await expect(token.connect(admin).mint(admin.address, 1n), "the admin cannot mint without the role").to.be.reverted;
    });
  });

  it("is missing the shared infrastructure Sluice therefore does not rely on", async () => {
    for (const [name, address] of MISSING_ON_QIE) {
      expect(await ethers.provider.getCode(address), `${name} at ${address}`).to.equal("0x");
    }
  });

  it("costs about 35,000 gas to transfer to an existing holder and about 52,000 to a new one", async () => {
    const token = await realQusdc();
    const [, , payer, builder, relayer] = await ethers.getSigners();
    await mintQusdc(payer!.address, USDC(10));
    const fresh = await (await token.connect(payer!).transfer(ethers.Wallet.createRandom().address, USDC(1))).wait();
    await mintQusdc(builder!.address, USDC(1));
    const existing = await (await token.connect(payer!).transfer(builder!.address, USDC(1))).wait();
    await token.connect(payer!).approve(relayer!.address, USDC(2));
    const pulled = await (await token.connect(relayer!).transferFrom(payer!.address, relayer!.address, USDC(1))).wait();
    // Measured 2026-11-18: 35,074 to an existing holder and 52,174 to a new one. The bands leave a little slack.
    expect(Number(existing!.gasUsed), "to an existing holder").to.be.within(33_000, 37_000);
    expect(Number(fresh!.gasUsed), "to a new holder").to.be.within(50_000, 54_000);
    expect(Number(pulled!.gasUsed), "transferFrom").to.be.within(35_000, 60_000);
  });
});

describe("Fork: the router with the real QUSDC", function () {
  this.timeout(600_000);

  it("takes a deposit by approve then transferFrom, and holds exactly what was deposited", async () => {
    const w = await deployOnFork();
    await w.mint(w.payer.address, USDC(20));
    await expect(w.router.connect(w.payer).deposit(USDC(5)), "no allowance yet").to.be.reverted;
    await w.token.connect(w.payer).approve(w.routerAddress, USDC(5));
    await expect(w.router.connect(w.payer).deposit(USDC(5)))
      .to.emit(w.router, "Deposited")
      .withArgs(w.payer.address, w.payer.address, USDC(5));
    expect(await w.token.balanceOf(w.routerAddress)).to.equal(USDC(5));
    expect(await w.router.payerBalance(w.payer.address)).to.equal(USDC(5));
    await expect(w.router.connect(w.payer).deposit(USDC(1)), "the allowance is used up").to.be.reverted;
    await expect(w.router.connect(w.payer).deposit(0n)).to.be.revertedWithCustomError(w.router, "ZeroAmount");
  });

  it("settles a payer-signed intent, splitting the fee, with the real token's balances unchanged until withdrawal", async () => {
    const w = await deployOnFork(100);
    await fundBalance(w, w.payer, USDC(10));
    const item = await signedIntent(w, w.payer, w.payer.address, w.builder.address, USDC(2), { toolId: toolId("weather") });
    const before: bigint = await w.token.balanceOf(w.routerAddress);
    await expect(w.router.connect(w.relayer).settle(item.intent, item.signature))
      .to.emit(w.router, "Settled")
      .withArgs(w.payer.address, w.builder.address, toolId("weather"), USDC(2), USDC("0.02"), item.intent.nonce, w.payer.address);
    expect(await w.token.balanceOf(w.routerAddress), "settling moves no token").to.equal(before);
    expect(await w.router.payerBalance(w.payer.address)).to.equal(USDC(8));
    expect(await w.router.earnings(w.builder.address)).to.equal(USDC("1.98"));
    expect(await w.router.earnings(w.feeRecipient.address)).to.equal(USDC("0.02"));
  });

  it("settles a batch, skipping the bad intents and charging for none of them", async () => {
    const w = await deployOnFork(100);
    await fundBalance(w, w.payer, USDC(10));
    const good1 = await signedIntent(w, w.payer, w.payer.address, w.builder.address, USDC(1));
    const good2 = await signedIntent(w, w.payer, w.payer.address, w.other.address, USDC(2));
    const tooMuch = await signedIntent(w, w.payer, w.payer.address, w.builder.address, USDC(100));
    const replay = { intent: good1.intent, signature: good1.signature };
    const items = [good1, tooMuch, good2, replay];
    const args = [items.map((i) => i.intent), items.map((i) => i.signature)];
    expect(await w.router.batchSettle.staticCall(...args)).to.equal(2);
    await w.router.connect(w.relayer).batchSettle(...args);
    expect(await w.router.payerBalance(w.payer.address)).to.equal(USDC(7));
    expect(await w.router.earnings(w.builder.address)).to.equal(USDC("0.99"));
    expect(await w.router.earnings(w.other.address)).to.equal(USDC("1.98"));
  });

  it("lets a builder withdraw to a wallet and pays out real QUSDC", async () => {
    const w = await deployOnFork(100);
    await fundBalance(w, w.payer, USDC(10));
    const item = await signedIntent(w, w.payer, w.payer.address, w.builder.address, USDC(4));
    await w.router.settle(item.intent, item.signature);
    const before: bigint = await w.token.balanceOf(w.builder.address);
    await expect(w.router.connect(w.builder).withdraw(USDC("3.96"), w.builder.address))
      .to.emit(w.router, "Withdrawn")
      .withArgs(w.builder.address, w.builder.address, USDC("3.96"), ethers.ZeroAddress, 0);
    expect((await w.token.balanceOf(w.builder.address)) - before).to.equal(USDC("3.96"));
    expect(await w.router.earnings(w.builder.address)).to.equal(0);
  });

  it("lets a builder with no QIE withdraw by signature through a relayer", async () => {
    const w = await deployOnFork(100);
    await fundBalance(w, w.payer, USDC(10));
    const builder = ethers.Wallet.createRandom(); // never funded with QIE
    const item = await signedIntent(w, w.payer, w.payer.address, builder.address, USDC(5));
    await w.router.settle(item.intent, item.signature);
    expect(await ethers.provider.getBalance(builder.address)).to.equal(0);

    const nonce = randomNonce();
    const deadline = (await nowSeconds()) + 3600n;
    const request = { account: builder.address, to: builder.address, amount: USDC("4.95"), relayerFee: USDC("0.05"), nonce, deadline };
    const signature = await builder.signTypedData(routerDomain(w.routerAddress), withdrawTypes, request);
    const relayerBefore: bigint = await w.token.balanceOf(w.relayer.address);
    await expect(
      w.router.connect(w.relayer).withdrawBySig(builder.address, builder.address, USDC("4.95"), USDC("0.05"), nonce, deadline, signature),
    )
      .to.emit(w.router, "Withdrawn")
      .withArgs(builder.address, builder.address, USDC("4.95"), w.relayer.address, USDC("0.05"));
    expect(await w.token.balanceOf(builder.address)).to.equal(USDC("4.90"));
    expect((await w.token.balanceOf(w.relayer.address)) - relayerBefore).to.equal(USDC("0.05"));
    expect(await ethers.provider.getBalance(builder.address), "the builder still holds no QIE").to.equal(0);
    expect(await w.router.earnings(builder.address)).to.equal(0);
    await expect(
      w.router.connect(w.relayer).withdrawBySig(builder.address, builder.address, USDC("4.95"), USDC("0.05"), nonce, deadline, signature),
      "a used signature cannot be replayed",
    ).to.be.reverted;
  });

  it("lets a payer refund the unspent balance, directly or by signature with no QIE", async () => {
    const w = await deployOnFork(100);
    await fundBalance(w, w.payer, USDC(10));
    // Hardhat's default accounts already hold real QUSDC on mainnet, so compare changes, not totals.
    const walletBefore: bigint = await w.token.balanceOf(w.payer.address);
    await w.router.connect(w.payer).refund(USDC(3), w.payer.address);
    expect((await w.token.balanceOf(w.payer.address)) - walletBefore).to.equal(USDC(3));

    const payer = ethers.Wallet.createRandom();
    await w.mint(w.other.address, USDC(6));
    await w.token.connect(w.other).approve(w.routerAddress, USDC(6));
    await w.router.connect(w.other).depositFor(payer.address, USDC(6));
    const nonce = randomNonce();
    const deadline = (await nowSeconds()) + 3600n;
    const signature = await payer.signTypedData(routerDomain(w.routerAddress), refundTypes, {
      payer: payer.address, to: payer.address, amount: USDC(6), relayerFee: USDC("0.1"), nonce, deadline,
    });
    await w.router.connect(w.relayer).refundBySig(payer.address, payer.address, USDC(6), USDC("0.1"), nonce, deadline, signature);
    expect(await w.token.balanceOf(payer.address)).to.equal(USDC("5.9"));
    expect(await w.router.payerBalance(payer.address)).to.equal(0);
  });

  it("lets a payer who holds no QIE authorise an agent by signature, and the agent spend within its policy", async () => {
    const w = await deployOnFork(100);
    const payer = ethers.Wallet.createRandom();
    await w.mint(w.other.address, USDC(20));
    await w.token.connect(w.other).approve(w.routerAddress, USDC(20));
    await w.router.connect(w.other).depositFor(payer.address, USDC(20));
    const agent = ethers.Wallet.createRandom();
    const grant = { agent: agent.address, budget: USDC(3), perCallCap: USDC(2), expiry: (await nowSeconds()) + 3600n };
    const tools = [{ payee: w.builder.address, toolId: toolId("search") }];
    const deadline = (await nowSeconds()) + 3600n;
    const authSig = await payer.signTypedData(vaultDomain(w.vaultAddress), authorizeTypes, {
      payer: payer.address, ...grant, tools, nonce: 0, deadline,
    });
    await w.vault.connect(w.relayer).authorizeBySig(payer.address, grant, tools, deadline, authSig);

    const ok = await signedIntent(w, agent, payer.address, w.builder.address, USDC(2), { toolId: toolId("search") });
    await w.router.settle(ok.intent, ok.signature);
    const overCap = await signedIntent(w, agent, payer.address, w.builder.address, USDC("2.5"), { toolId: toolId("search") });
    await expect(w.router.settle(overCap.intent, overCap.signature)).to.be.revertedWithCustomError(w.router, "PerCallCapExceeded");
    const overBudget = await signedIntent(w, agent, payer.address, w.builder.address, USDC("1.5"), { toolId: toolId("search") });
    await expect(w.router.settle(overBudget.intent, overBudget.signature)).to.be.revertedWithCustomError(w.router, "BudgetExceeded");
    const wrongTool = await signedIntent(w, agent, payer.address, w.builder.address, USDC(1), { toolId: toolId("other") });
    await expect(w.router.settle(wrongTool.intent, wrongTool.signature)).to.be.revertedWithCustomError(w.router, "ToolNotAllowed");

    const revokeSig = await payer.signTypedData(vaultDomain(w.vaultAddress), revokeTypes, {
      payer: payer.address, agent: agent.address, nonce: 1, deadline,
    });
    await w.vault.connect(w.relayer).revokeBySig(payer.address, agent.address, deadline, revokeSig);
    const afterRevoke = await signedIntent(w, agent, payer.address, w.builder.address, USDC(1), { toolId: toolId("search") });
    await expect(w.router.settle(afterRevoke.intent, afterRevoke.signature)).to.be.revertedWithCustomError(w.router, "SessionNotFound");
    expect(await w.router.payerBalance(payer.address)).to.equal(USDC(18));
  });

  it("stays solvent through a full lifecycle: the router holds exactly what it owes, and empties out", async () => {
    const w = await deployOnFork(150);
    await fundBalance(w, w.payer, USDC(30));
    await fundBalance(w, w.other, USDC(20));
    for (const [signer, payee, amount] of [
      [w.payer, w.builder, USDC("1.234567")],
      [w.other, w.builder, USDC("0.000001")],
      [w.payer, w.stranger, USDC(7)],
    ] as const) {
      const item = await signedIntent(w, signer, signer.address, payee.address, amount);
      await w.router.settle(item.intent, item.signature);
      const [held, owed] = await w.router.solvency();
      expect(held).to.equal(owed);
    }
    for (const who of [w.payer, w.other]) await w.router.connect(who).refund(await w.router.payerBalance(who.address), who.address);
    for (const who of [w.builder, w.stranger, w.feeRecipient]) {
      await w.router.connect(who).withdraw(await w.router.earnings(who.address), who.address);
    }
    expect(await w.token.balanceOf(w.routerAddress)).to.equal(0);
    expect(await w.router.totalLiabilities()).to.equal(0);
  });
});

describe("Fork: what QUSDC's admin could do to the router (local demonstration only)", function () {
  this.timeout(600_000);

  it("an admin who grants itself the vault role can burn the router's QUSDC, and then the router cannot pay everyone", async () => {
    const w = await deployOnFork(100);
    const token = await realQusdc();
    await fundBalance(w, w.payer, USDC(10));
    const walletBefore: bigint = await w.token.balanceOf(w.payer.address);
    const [heldBefore, owedBefore] = await w.router.solvency();
    expect(heldBefore).to.equal(owedBefore);

    // Local fork only: impersonate the real admin, give it the vault role, burn 4 QUSDC held by the router.
    const vaultRole: string = await token.VAULT_ROLE();
    await asAccount(QUSDC_ADMIN, async (admin) => {
      await (await token.connect(admin).grantRole(vaultRole, QUSDC_ADMIN)).wait();
      await (await token.connect(admin).burn(w.routerAddress, USDC(4))).wait();
    });

    const [held, owed] = await w.router.solvency();
    expect(owed).to.equal(USDC(10));
    expect(held).to.equal(USDC(6));
    expect(held < owed, "the router is now short, and solvency() says so").to.equal(true);
    // The payer can still take back what is there, but not all of what they are owed.
    await expect(w.router.connect(w.payer).refund(USDC(10), w.payer.address)).to.be.reverted;
    await w.router.connect(w.payer).refund(USDC(6), w.payer.address);
    expect((await w.token.balanceOf(w.payer.address)) - walletBefore).to.equal(USDC(6));
    expect(await w.router.payerBalance(w.payer.address)).to.equal(USDC(4));
  });

  it("the same admin power reaches any holder's own wallet: it is a property of QUSDC, not of the router", async () => {
    const w = await deployOnFork();
    const token = await realQusdc();
    const holder = ethers.Wallet.createRandom().address; // a fresh holder, so its balance starts at zero
    await w.mint(holder, USDC(5));
    expect(await w.token.balanceOf(holder)).to.equal(USDC(5));
    const vaultRole: string = await token.VAULT_ROLE();
    await asAccount(QUSDC_ADMIN, async (admin) => {
      await (await token.connect(admin).grantRole(vaultRole, QUSDC_ADMIN)).wait();
      await (await token.connect(admin).burn(holder, USDC(5))).wait();
    });
    expect(await w.token.balanceOf(holder)).to.equal(0);
  });

  it("without that admin acting, a user can always withdraw everything: deposit, settle, refund, withdraw all succeed in full", async () => {
    const w = await deployOnFork(200);
    await fundBalance(w, w.payer, USDC(10));
    const item = await signedIntent(w, w.payer, w.payer.address, w.builder.address, USDC(10));
    await w.router.settle(item.intent, item.signature);
    await w.router.connect(w.builder).withdraw(USDC("9.8"), w.builder.address);
    await w.router.connect(w.feeRecipient).withdraw(USDC("0.2"), w.feeRecipient.address);
    expect(await w.token.balanceOf(w.routerAddress)).to.equal(0);
  });
});

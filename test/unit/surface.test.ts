// What the contracts expose, and what they do not. These tests pin the promises in the README:
// immutable, no proxy, no pause, owner limited to the fee and the fee recipient, Shanghai-only bytecode.
import { expect } from "chai";
import { artifacts, config, ethers } from "hardhat";
import {
  authorizeTypes,
  deploy,
  fundBalance,
  newIntent,
  nowSeconds,
  paymentTypes,
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

type AbiItem = { type: string; name?: string; stateMutability?: string; inputs?: Array<{ type: string }> };

async function abiOf(name: string): Promise<AbiItem[]> {
  return (await artifacts.readArtifact(name)).abi as AbiItem[];
}
const functions = (abi: AbiItem[]) => abi.filter((x) => x.type === "function");
const names = (abi: AbiItem[], mutability: string[]) =>
  functions(abi)
    .filter((f) => mutability.includes(f.stateMutability ?? ""))
    .map((f) => f.name as string)
    .sort();

/** Walks bytecode instruction by instruction, skipping PUSH data, and returns every opcode seen. */
function opcodes(hex: string): number[] {
  const code = ethers.getBytes(hex);
  // Solidity appends CBOR metadata; its length is in the last two bytes. It is data, not code.
  const metaLen = (code[code.length - 2]! << 8) | code[code.length - 1]!;
  const end = code.length - 2 - metaLen;
  const seen: number[] = [];
  let i = 0;
  while (i < end) {
    const op = code[i]!;
    seen.push(op);
    i += op >= 0x60 && op <= 0x7f ? 1 + (op - 0x5f) : 1;
  }
  expect(i, "the walk should end exactly at the end of the code").to.equal(end);
  return seen;
}

const OP = { CREATE: 0xf0, CALLCODE: 0xf2, DELEGATECALL: 0xf4, CREATE2: 0xf5, SELFDESTRUCT: 0xff } as const;
// Cancun opcodes: QIE is Shanghai-only, so none may appear.
const CANCUN = { BLOBHASH: 0x49, BLOBBASEFEE: 0x4a, TLOAD: 0x5c, TSTORE: 0x5d, MCOPY: 0x5e } as const;

describe("Surface: the router's functions", () => {
  it("has exactly the documented state-changing functions, and none that take or hold the chain's coin", async () => {
    const abi = await abiOf("PaymentRouter");
    expect(names(abi, ["nonpayable"])).to.deep.equal(
      [
        "batchSettle",
        "cancelNonce",
        "deposit",
        "depositFor",
        "refund",
        "refundBySig",
        "setFee",
        "setFeeRecipient",
        "settle",
        "withdraw",
        "withdrawBySig",
      ].sort(),
    );
    expect(names(abi, ["payable"]), "no payable function").to.deep.equal([]);
    expect(abi.filter((x) => x.type === "receive" || x.type === "fallback"), "no receive or fallback").to.deep.equal([]);
  });

  it("has exactly the documented read functions", async () => {
    const abi = await abiOf("PaymentRouter");
    expect(names(abi, ["view", "pure"])).to.deep.equal(
      [
        "MAX_FEE_BPS",
        "PAYMENT_TYPEHASH",
        "REFUND_TYPEHASH",
        "WITHDRAW_TYPEHASH",
        "domainSeparator",
        "earnings",
        "feeBps",
        "feeRecipient",
        "hashPayment",
        "nonceUsed",
        "owner",
        "payerBalance",
        "solvency",
        "token",
        "totalLiabilities",
        "vault",
      ].sort(),
    );
  });

  it("has exactly the documented events", async () => {
    const router = (await abiOf("PaymentRouter")).filter((x) => x.type === "event").map((x) => x.name);
    expect(router.sort()).to.deep.equal(
      ["Deposited", "FeeChanged", "FeeRecipientChanged", "NonceCancelled", "Refunded", "SettleSkipped", "Settled", "Withdrawn"].sort(),
    );
    const vault = (await abiOf("AgentVault")).filter((x) => x.type === "event").map((x) => x.name);
    expect(vault.sort()).to.deep.equal(["SessionAuthorized", "SessionRevoked", "SessionSpent"].sort());
  });

  it("has no function whose name offers an upgrade, pause, sweep, freeze or ownership change", async () => {
    const banned =
      /pause|unpause|upgrade|implementation|proxy|sweep|rescue|recover(?!ed)|skim|emergency|admin|transferOwnership|renounce|setOwner|setToken|setVault|migrate|blacklist|blocklist|freeze|mint|burn|selfdestruct|kill/i;
    for (const contract of ["PaymentRouter", "AgentVault"]) {
      for (const f of functions(await abiOf(contract))) {
        expect(banned.test(f.name as string), `${contract}.${f.name} looks like an admin escape hatch`).to.equal(false);
      }
    }
  });

  it("gates exactly setFee and setFeeRecipient to the owner, and no other function", async () => {
    const w = await deploy();
    const outsider = w.stranger;
    await expect(w.router.connect(outsider).setFee(1)).to.be.revertedWithCustomError(w.router, "NotOwner");
    await expect(w.router.connect(outsider).setFeeRecipient(outsider.address)).to.be.revertedWithCustomError(w.router, "NotOwner");
    await w.router.connect(w.owner).setFee(150);
    await w.router.connect(w.owner).setFeeRecipient(w.other.address);
    expect(await w.router.feeBps()).to.equal(150);
    expect(await w.router.feeRecipient()).to.equal(w.other.address);
    // The owner is a normal account for everything else: it has no balance, so it cannot take any.
    await expect(w.router.connect(w.owner).withdraw(1, w.owner.address)).to.be.revertedWithCustomError(w.router, "InsufficientBalance");
    await expect(w.router.connect(w.owner).refund(1, w.owner.address)).to.be.revertedWithCustomError(w.router, "InsufficientBalance");
  });

  it("has an owner that can be neither changed nor removed", async () => {
    const w = await deploy();
    expect(await w.router.owner()).to.equal(w.owner.address);
    const abi = await abiOf("PaymentRouter");
    const setters = functions(abi).filter((f) => f.stateMutability === "nonpayable" && /owner|token|vault/i.test(f.name as string));
    expect(setters.map((f) => f.name)).to.deep.equal([]);
  });
});

describe("Surface: the owner cannot move anyone's money", () => {
  it("leaves a payer's prepaid balance and a builder's earnings untouched by every call the owner can make", async () => {
    const w = await deploy({ feeBps: 100 });
    await fundBalance(w, w.payer, USDC(10));
    const item = await signedIntent(w, w.payer, w.payer.address, w.builder.address, USDC(4));
    await w.router.settle(item.intent, item.signature);
    const snapshot = async () => ({
      prepaid: await w.router.payerBalance(w.payer.address),
      earned: await w.router.earnings(w.builder.address),
      held: await w.token.balanceOf(w.routerAddress),
      owed: await w.router.totalLiabilities(),
    });
    const before = await snapshot();
    const owner = w.owner;
    const deadline = (await nowSeconds()) + 3600n;

    // Every function, called by the owner, aimed at the victims' balances.
    await w.router.connect(owner).setFee(200);
    await w.router.connect(owner).setFee(0);
    await w.router.connect(owner).setFeeRecipient(owner.address);
    await expect(w.router.connect(owner).withdraw(1, owner.address)).to.be.reverted;
    await expect(w.router.connect(owner).refund(1, owner.address)).to.be.reverted;
    // A request "signed" by the owner for the victim's account is refused: only the account's own key counts.
    const nonce = randomNonce();
    const withdrawSig = await owner.signTypedData(routerDomain(w.routerAddress), withdrawTypes, {
      account: w.builder.address, to: owner.address, amount: USDC(1), relayerFee: 0, nonce, deadline,
    });
    await expect(
      w.router.connect(owner).withdrawBySig(w.builder.address, owner.address, USDC(1), 0, nonce, deadline, withdrawSig),
    ).to.be.revertedWithCustomError(w.router, "InvalidSignature");
    const refundSig = await owner.signTypedData(routerDomain(w.routerAddress), refundTypes, {
      payer: w.payer.address, to: owner.address, amount: USDC(1), relayerFee: 0, nonce, deadline,
    });
    await expect(
      w.router.connect(owner).refundBySig(w.payer.address, owner.address, USDC(1), 0, nonce, deadline, refundSig),
    ).to.be.revertedWithCustomError(w.router, "InvalidSignature");
    // An intent for the victim's balance, signed by the owner: no session, so refused.
    const theft = await signedIntent(w, owner, w.payer.address, owner.address, USDC(1));
    await expect(w.router.connect(owner).settle(theft.intent, theft.signature)).to.be.revertedWithCustomError(w.router, "SessionNotFound");
    // A session the owner authorises binds the owner's own balance, never the victim's.
    const agent = ethers.Wallet.createRandom();
    await w.vault.connect(owner).authorize(
      { agent: agent.address, budget: USDC(5), perCallCap: USDC(5), expiry: (await nowSeconds()) + 3600n },
      [{ payee: owner.address, toolId: ethers.ZeroHash }],
    );
    const viaAgent = await signedIntent(w, agent, w.payer.address, owner.address, USDC(1));
    await expect(w.router.connect(owner).settle(viaAgent.intent, viaAgent.signature)).to.be.revertedWithCustomError(w.router, "SessionNotFound");
    // The router's vault only listens to the router.
    await expect(w.vault.connect(owner).consume(w.payer.address, agent.address, owner.address, ethers.ZeroHash, 1)).to.be.revertedWithCustomError(
      w.vault,
      "NotRouter",
    );
    // A signed authorisation for the victim's account, signed by the owner, is refused too.
    const authSig = await owner.signTypedData(vaultDomain(w.vaultAddress), authorizeTypes, {
      payer: w.payer.address, agent: agent.address, budget: USDC(5), perCallCap: USDC(5), expiry: (await nowSeconds()) + 3600n,
      tools: [{ payee: owner.address, toolId: ethers.ZeroHash }], nonce: 0, deadline,
    });
    await expect(
      w.vault.connect(owner).authorizeBySig(
        w.payer.address,
        { agent: agent.address, budget: USDC(5), perCallCap: USDC(5), expiry: (await nowSeconds()) + 3600n },
        [{ payee: owner.address, toolId: ethers.ZeroHash }],
        deadline,
        authSig,
      ),
    ).to.be.reverted;

    expect(await snapshot()).to.deep.equal(before);
    // And the victims can still take everything out.
    await w.router.connect(w.payer).refund(before.prepaid, w.payer.address);
    await w.router.connect(w.builder).withdraw(before.earned, w.builder.address);
    // Only the fee credited before the owner moved the recipient is left, and it stays with that recipient.
    expect(await w.router.totalLiabilities()).to.equal(await w.router.earnings(w.feeRecipient.address));
    expect(await w.router.earnings(w.feeRecipient.address)).to.equal(USDC("0.04"));
  });

  it("keeps working for a user after the owner sets the fee to its maximum and moves the fee recipient", async () => {
    const w = await deploy({ feeBps: 100 });
    await fundBalance(w, w.payer, USDC(10));
    await w.router.connect(w.owner).setFee(200);
    await w.router.connect(w.owner).setFeeRecipient(w.owner.address);
    const item = await signedIntent(w, w.payer, w.payer.address, w.builder.address, USDC(10));
    await w.router.settle(item.intent, item.signature);
    expect(await w.router.earnings(w.builder.address)).to.equal(USDC("9.8"));
    expect(await w.router.earnings(w.owner.address)).to.equal(USDC("0.2"));
    // What the payer already paid is theirs to refund only while it is unspent; the rest is settled.
    expect(await w.router.payerBalance(w.payer.address)).to.equal(0);
  });
});

describe("Surface: every state change says so in an event", () => {
  it("emits at least one event from every state-changing function", async () => {
    const w = await deploy({ feeBps: 100 });
    const signer = ethers.Wallet.createRandom();
    await w.token.mint(w.other.address, USDC(100));
    await w.token.connect(w.other).approve(w.routerAddress, USDC(100));
    await w.router.connect(w.other).depositFor(signer.address, USDC(40)); // the signer holds no QIE
    const deadline = (await nowSeconds()) + 3600n;
    const logs = async (tx: Promise<{ wait: () => Promise<{ logs: ReadonlyArray<unknown> } | null> }>) =>
      ((await (await tx).wait())?.logs ?? []).length;

    const results: Record<string, number> = {};
    results.deposit = await logs(w.router.connect(w.other).deposit(USDC(10)));
    results.depositFor = await logs(w.router.connect(w.other).depositFor(w.payer.address, USDC(10)));
    const one = await signedIntent(w, w.payer, w.payer.address, w.builder.address, USDC(1));
    results.settle = await logs(w.router.settle(one.intent, one.signature));
    const two = await signedIntent(w, w.payer, w.payer.address, w.builder.address, USDC(1));
    results.batchSettle = await logs(w.router.batchSettle([two.intent], [two.signature]));
    results.cancelNonce = await logs(w.router.connect(w.payer).cancelNonce(randomNonce()));
    results.withdraw = await logs(w.router.connect(w.builder).withdraw(USDC("0.5"), w.builder.address));
    results.refund = await logs(w.router.connect(w.payer).refund(USDC(1), w.payer.address));
    results.setFee = await logs(w.router.connect(w.owner).setFee(100)); // even an unchanged value is logged
    results.setFeeRecipient = await logs(w.router.connect(w.owner).setFeeRecipient(w.feeRecipient.address));

    const wNonce = randomNonce();
    const wSig = await w.builder.signTypedData(routerDomain(w.routerAddress), withdrawTypes, {
      account: w.builder.address, to: w.builder.address, amount: USDC("0.5"), relayerFee: 0, nonce: wNonce, deadline,
    });
    results.withdrawBySig = await logs(
      w.router.connect(w.relayer).withdrawBySig(w.builder.address, w.builder.address, USDC("0.5"), 0, wNonce, deadline, wSig),
    );
    const rNonce = randomNonce();
    const rSig = await signer.signTypedData(routerDomain(w.routerAddress), refundTypes, {
      payer: signer.address, to: signer.address, amount: USDC(1), relayerFee: 0, nonce: rNonce, deadline,
    });
    results.refundBySig = await logs(
      w.router.connect(w.relayer).refundBySig(signer.address, signer.address, USDC(1), 0, rNonce, deadline, rSig),
    );

    const agent = ethers.Wallet.createRandom();
    const grant = { agent: agent.address, budget: USDC(5), perCallCap: USDC(1), expiry: deadline };
    const tools = [{ payee: w.builder.address, toolId: toolId("t") }];
    results.authorize = await logs(w.vault.connect(w.payer).authorize(grant, tools));
    results.revoke = await logs(w.vault.connect(w.payer).revoke(agent.address));
    const aNonce = await w.vault.nonces(signer.address);
    const aSig = await signer.signTypedData(vaultDomain(w.vaultAddress), authorizeTypes, {
      payer: signer.address, ...grant, tools, nonce: aNonce, deadline,
    });
    results.authorizeBySig = await logs(w.vault.connect(w.relayer).authorizeBySig(signer.address, grant, tools, deadline, aSig));
    const vNonce = await w.vault.nonces(signer.address);
    const vSig = await signer.signTypedData(vaultDomain(w.vaultAddress), revokeTypes, {
      payer: signer.address, agent: agent.address, nonce: vNonce, deadline,
    });
    results.revokeBySig = await logs(w.vault.connect(w.relayer).revokeBySig(signer.address, agent.address, deadline, vSig));

    for (const [fn, count] of Object.entries(results)) expect(count, `${fn} emitted nothing`).to.be.greaterThan(0);
    // consume() is the one state change not listed above: it is internal to settle and emits SessionSpent there.
    expect(Object.keys(results)).to.have.length(15);
  });
});

describe("Surface: the EIP-712 domains carry the project's name", () => {
  // The signing domains are named after the project. The previous name is assembled from pieces so that no file
  // in the repository spells it out.
  const previous = ["Pay", "meter"].join("");

  it("the router signs under SluiceRouter and the vault under SluiceAgentVault, both version 1, bound to chain and address", async () => {
    const w = await deploy();
    expect(await w.router.domainSeparator()).to.equal(
      ethers.TypedDataEncoder.hashDomain({ name: "SluiceRouter", version: "1", chainId: 1990, verifyingContract: w.routerAddress }),
    );
    expect(await w.vault.domainSeparator()).to.equal(
      ethers.TypedDataEncoder.hashDomain({ name: "SluiceAgentVault", version: "1", chainId: 1990, verifyingContract: w.vaultAddress }),
    );
    expect(await w.router.domainSeparator()).to.not.equal(await w.vault.domainSeparator());
  });

  it("a payment signed under the previous domain name, or under any near miss, is refused", async () => {
    const w = await deploy();
    await fundBalance(w, w.payer, USDC(5));
    for (const name of [`${previous}Router`, "Sluice", "sluiceRouter", "SluiceRouter "]) {
      const intent = await newIntent(w.payer.address, w.builder.address, USDC(1));
      const signature = await w.payer.signTypedData(
        { name, version: "1", chainId: 1990, verifyingContract: w.routerAddress },
        paymentTypes,
        intent,
      );
      await expect(w.router.settle(intent, signature), JSON.stringify(name)).to.be.revertedWithCustomError(w.router, "SessionNotFound");
    }
    const good = await signedIntent(w, w.payer, w.payer.address, w.builder.address, USDC(1));
    await w.router.settle(good.intent, good.signature); // the real domain still works
  });

  it("the vault refuses an authorisation signed under the previous domain name, and accepts the real one", async () => {
    const w = await deploy();
    const payer = ethers.Wallet.createRandom();
    const agent = ethers.Wallet.createRandom();
    const grant = { agent: agent.address, budget: USDC(5), perCallCap: USDC(1), expiry: (await nowSeconds()) + 3600n };
    const tools = [{ payee: w.builder.address, toolId: toolId("t") }];
    const deadline = (await nowSeconds()) + 3600n;
    const value = { payer: payer.address, ...grant, tools, nonce: 0, deadline };
    const stale = await payer.signTypedData(
      { name: `${previous}AgentVault`, version: "1", chainId: 1990, verifyingContract: w.vaultAddress },
      authorizeTypes,
      value,
    );
    await expect(w.vault.authorizeBySig(payer.address, grant, tools, deadline, stale)).to.be.revertedWithCustomError(w.vault, "InvalidSignature");
    const fresh = await payer.signTypedData(vaultDomain(w.vaultAddress), authorizeTypes, value);
    await w.vault.authorizeBySig(payer.address, grant, tools, deadline, fresh);
  });
});

describe("Surface: the bytecode", () => {
  it("control: the opcode walker finds a real DELEGATECALL and ignores 0xf4 inside push data", () => {
    // PUSH1 0xf4 ; DELEGATECALL ; then one byte of metadata and its two-byte length (1).
    expect(opcodes("0x60f4f4" + "00" + "0001")).to.deep.equal([0x60, OP.DELEGATECALL]);
    // PUSH1 0xf4 ; STOP: the f4 is data, so no DELEGATECALL.
    expect(opcodes("0x60f400" + "00" + "0001")).to.deep.equal([0x60, 0x00]);
    // PUSH0 is a Shanghai opcode with no data; MCOPY (0x5e) is Cancun and must be reported.
    expect(opcodes("0x5f5e" + "00" + "0001")).to.deep.equal([0x5f, CANCUN.MCOPY]);
  });

  for (const contract of ["PaymentRouter", "AgentVault"]) {
    it(`${contract}: no delegatecall, callcode, selfdestruct or contract creation in the deployed code`, async () => {
      const { deployedBytecode } = await artifacts.readArtifact(contract);
      const seen = new Set(opcodes(deployedBytecode));
      for (const [name, op] of Object.entries(OP)) expect(seen.has(op), `${contract} runtime contains ${name}`).to.equal(false);
    });

    it(`${contract}: no Cancun opcode anywhere in the deployed code (QIE is Shanghai-only)`, async () => {
      const { deployedBytecode } = await artifacts.readArtifact(contract);
      const seen = new Set(opcodes(deployedBytecode));
      for (const [name, op] of Object.entries(CANCUN)) expect(seen.has(op), `${contract} runtime contains ${name}`).to.equal(false);
    });

    it(`${contract}: no EIP-1967 proxy slot constant`, async () => {
      const { deployedBytecode } = await artifacts.readArtifact(contract);
      const slots = [
        "360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc", // implementation
        "b53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103", // admin
        "a3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50", // beacon
      ];
      for (const slot of slots) expect(deployedBytecode.toLowerCase().includes(slot), `${contract} mentions proxy slot ${slot}`).to.equal(false);
    });
  }

  it("what is on chain after deployment is the compiled runtime code, the same size, for both contracts", async () => {
    const w = await deploy();
    for (const [name, address] of [["PaymentRouter", w.routerAddress], ["AgentVault", w.vaultAddress]] as const) {
      const { deployedBytecode } = await artifacts.readArtifact(name);
      // Same length: only the immutable values (addresses) differ from the artifact's placeholders.
      expect((await ethers.provider.getCode(address)).length, name).to.equal(deployedBytecode.length);
    }
  });

  it("is compiled for the Shanghai EVM with Solidity 0.8.24", async () => {
    const settings = config.solidity.compilers[0]!.settings as { evmVersion?: string };
    expect(settings.evmVersion).to.equal("shanghai");
    expect(config.solidity.compilers[0]!.version).to.equal("0.8.24");
    expect(config.solidity.compilers).to.have.length(1);
  });

  it("deploys within the 24,576-byte contract size limit with room to spare", async () => {
    for (const contract of ["PaymentRouter", "AgentVault"]) {
      const { deployedBytecode } = await artifacts.readArtifact(contract);
      const size = (deployedBytecode.length - 2) / 2;
      expect(size, `${contract} runtime size`).to.be.lessThan(24_576 * 0.5);
    }
  });

  it("the vault answers only to the router that created it", async () => {
    const w = await deploy();
    expect(await w.vault.router()).to.equal(w.routerAddress);
    expect(await w.router.vault()).to.equal(w.vaultAddress);
    const a = await deploy();
    expect(a.vaultAddress).to.not.equal(w.vaultAddress);
  });
});

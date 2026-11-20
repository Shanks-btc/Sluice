// docs/spec-vectors.json, verified. Every hash is recomputed here by hand, from the formulas in docs/SPEC.md and nothing
// else (plain keccak256 and ABI encoding, no Sluice code), every signature is recovered to the address the file names, and
// the SDK's checks must give each vector the verdict the file states. The hand-computed digests are then compared with what
// the compiled PaymentRouter and AgentVault compute, so the spec, the SDK and the contracts cannot drift apart.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";
import { AbiCoder, concat, getAddress, keccak256, recoverAddress, toUtf8Bytes } from "ethers";
import { checkPayment, parsePayload, parseRequirements } from "@sluice/sdk";
import { ethers } from "hardhat";
import { attach, deployContract } from "../../helpers";

const vectors = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "docs", "spec-vectors.json"), "utf8"));
const coder = AbiCoder.defaultAbiCoder();
const k = (text: string) => keccak256(toUtf8Bytes(text));
const T = vectors.typeStrings as Record<string, string>;

// ---- the spec's formulas, written out by hand ---------------------------------------------------------
type Domain = { name: string; version: string; chainId: number; verifyingContract: string };
const domainSeparator = (d: Domain) =>
  keccak256(coder.encode(["bytes32", "bytes32", "bytes32", "uint256", "address"], [k(T.EIP712Domain!), k(d.name), k(d.version), d.chainId, d.verifyingContract]));
const digestOf = (separator: string, structHash: string) => keccak256(concat(["0x1901", separator, structHash]));

const paymentStruct = (m: Record<string, string>) =>
  keccak256(coder.encode(["bytes32", "address", "address", "uint256", "bytes32", "bytes32", "uint256"], [k(T.Payment!), m.payer, m.payee, m.amount, m.toolId, m.nonce, m.deadline]));
const exitStruct = (type: "Withdraw" | "Refund", m: Record<string, string>) =>
  keccak256(coder.encode(["bytes32", "address", "address", "uint256", "uint256", "bytes32", "uint256"], [k(T[type]!), m.account ?? m.payer, m.to, m.amount, m.relayerFee, m.nonce, m.deadline]));
const toolHash = (t: { payee: string; toolId: string }) =>
  keccak256(coder.encode(["bytes32", "address", "bytes32"], [k("Tool(address payee,bytes32 toolId)"), t.payee, t.toolId]));
const authorizeStruct = (m: any) =>
  keccak256(
    coder.encode(
      ["bytes32", "address", "address", "uint256", "uint256", "uint256", "bytes32", "uint256", "uint256"],
      [k(T.Authorize!), m.payer, m.agent, m.budget, m.perCallCap, m.expiry, keccak256(concat(m.tools.map(toolHash))), m.nonce, m.deadline],
    ),
  );
const revokeStruct = (m: any) => keccak256(coder.encode(["bytes32", "address", "address", "uint256", "uint256"], [k(T.Revoke!), m.payer, m.agent, m.nonce, m.deadline]));

const HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/** What a verifier must refuse about a signature before any recovery: its form. */
function badForm(signature: string): string | undefined {
  if (!/^0x[0-9a-f]+$/i.test(signature) || signature.length !== 132) return "a signature is exactly 65 bytes";
  const v = parseInt(signature.slice(130, 132), 16);
  if (v !== 27 && v !== 28) return "v is 27 or 28";
  if (BigInt(`0x${signature.slice(66, 130)}`) > HALF_ORDER) return "s is at most half the group order";
  return undefined;
}

describe("Spec vectors: the file", () => {
  it("has no private key, mnemonic or secret in it", () => {
    const text = JSON.stringify(vectors);
    expect(text).to.not.match(/privateKey|mnemonic|secret|seed phrase/i);
    expect(text).to.not.match(/"0x[0-9a-f]{64}"\s*:\s*"/i);
    // A 32-byte value is a nonce, a hash or a tool id, never a key: each appears under a field that says so.
    for (const m of text.matchAll(/"(\w+)":\s*"0x[0-9a-f]{64}"/gi)) {
      expect(["toolId", "nonce", "digest", "separator", "structHash"], `${m[1]} holds a 32-byte value`).to.include(m[1]);
    }
  });

  it("states its version, scheme, network and the clock a verifier checks deadlines against", () => {
    expect(vectors.version).to.equal(1);
    expect(vectors.scheme).to.equal("sluice-intent");
    expect(vectors.network).to.equal("eip155:1990");
    expect(vectors.verifierNow).to.equal(1_800_000_000);
  });

  it("names each tool id as the keccak256 of the tool's name", () => {
    for (const t of vectors.toolIds) expect(t.toolId).to.equal(k(t.toolName));
  });

  it("has the domain separators the formula gives", () => {
    expect(vectors.domains.router.separator).to.equal(domainSeparator(vectors.domains.router));
    expect(vectors.domains.vault.separator).to.equal(domainSeparator(vectors.domains.vault));
    expect(vectors.domains.router.name).to.equal("SluiceRouter");
    expect(vectors.domains.vault.name).to.equal("SluiceAgentVault");
  });
});

describe("Spec vectors: payments", () => {
  const ctx = { chainId: 1990, router: vectors.addresses.router, asset: vectors.addresses.asset, now: vectors.verifierNow };
  const requirements = parseRequirements(vectors.paymentRequired.accepts[0])!;

  it("the payment-required example is well formed", () => {
    expect(requirements).to.not.equal(undefined);
    expect(vectors.paymentRequired.x402Version).to.equal(2);
    expect(requirements.scheme).to.equal("sluice-intent");
    expect(requirements.extra.toolId).to.equal(k("echo"));
  });

  const all = [...vectors.paymentVectors.valid, ...vectors.paymentVectors.invalid, ...vectors.paymentVectors.recoversToAnotherKey];
  for (const v of all) {
    it(`recomputes the digest and recovers the signer: ${v.name}`, () => {
      const handDigest = digestOf(domainSeparator(v.domain), paymentStruct(v.message));
      if (badForm(v.signature)) return; // a malformed signature has no signer to recover
      const recovered = recoverAddress(handDigest, v.signature);
      expect(recovered).to.equal(getAddress(v.signer));
    });
  }

  for (const v of vectors.paymentVectors.valid) {
    it(`a verifier accepts: ${v.name}`, () => {
      const payload = parsePayload(v.payload)!;
      const check = checkPayment(payload, requirements, ctx);
      expect(check.ok).to.equal(true);
      if (check.ok) {
        expect(check.signer).to.equal(v.expect.signer);
        expect(check.digest).to.equal(digestOf(vectors.domains.router.separator, paymentStruct(v.message)));
      }
      expect(v.digest).to.equal(digestOf(vectors.domains.router.separator, paymentStruct(v.message)));
    });
  }

  for (const v of vectors.paymentVectors.invalid) {
    it(`a verifier refuses with ${v.expect.error}: ${v.name}`, () => {
      const payload = parsePayload(v.payload);
      expect(payload, "the payload is well formed enough to read").to.not.equal(undefined);
      const check = checkPayment(payload!, requirements, ctx);
      expect(check.ok).to.equal(false);
      if (!check.ok) expect(check.code).to.equal(v.expect.error);
    });
  }

  it("refuses by form, before recovery, each signature the contract would refuse", () => {
    const forms = vectors.paymentVectors.invalid.filter((v: { name: string }) => /high-s|v is 0|64 bytes/.test(v.name));
    expect(forms).to.have.length(3);
    for (const v of forms) expect(badForm(v.payload.payload.signature), v.name).to.be.a("string");
  });

  for (const v of vectors.paymentVectors.recoversToAnotherKey) {
    it(`passes the stateless checks but recovers to a key that is not the payer: ${v.name}`, () => {
      const check = checkPayment(parsePayload(v.payload)!, requirements, ctx);
      expect(check.ok).to.equal(true);
      if (check.ok) expect(check.signer).to.not.equal(getAddress(v.message.payer));
      expect(v.expect).to.deep.include({ signerIsPayer: false, facilitatorError: "sluice_session_not_found" });
    });
  }
});

describe("Spec vectors: withdraw, refund, authorize and revoke", () => {
  const rows: Array<[string, any, (m: any) => string]> = [
    ["withdraw", vectors.withdraw, (m) => exitStruct("Withdraw", m)],
    ["refund", vectors.refund, (m) => exitStruct("Refund", m)],
    ["authorize", vectors.authorize, authorizeStruct],
    ["revoke", vectors.revoke, revokeStruct],
  ];
  for (const [name, v, struct] of rows) {
    it(`${name}: the digest is recomputed and the signature recovers to the signer`, () => {
      const digest = digestOf(domainSeparator(v.domain), struct(v.message));
      expect(digest).to.equal(v.digest);
      expect(recoverAddress(digest, v.signature)).to.equal(getAddress(v.signer));
      expect(badForm(v.signature)).to.equal(undefined);
    });
  }
});

describe("Spec vectors: the compiled contracts agree with the hand-computed digests", function () {
  this.timeout(120_000);

  it("PaymentRouter: type hashes, domain separator and hashPayment", async () => {
    const [owner, fee] = await ethers.getSigners();
    const token = await deployContract("MockQUSDC");
    const router = await deployContract("PaymentRouter", [await token.getAddress(), owner!.address, fee!.address, 100]);
    const routerAddress = await router.getAddress();
    expect(await router.PAYMENT_TYPEHASH()).to.equal(k(T.Payment!));
    expect(await router.WITHDRAW_TYPEHASH()).to.equal(k(T.Withdraw!));
    expect(await router.REFUND_TYPEHASH()).to.equal(k(T.Refund!));
    const domain = { name: "SluiceRouter", version: "1", chainId: 1990, verifyingContract: routerAddress };
    expect(await router.domainSeparator()).to.equal(domainSeparator(domain));
    for (const v of vectors.paymentVectors.valid) {
      const m = v.message;
      const onChain = await router.hashPayment({ payer: m.payer, payee: m.payee, amount: m.amount, toolId: m.toolId, nonce: m.nonce, deadline: m.deadline });
      expect(onChain, v.name).to.equal(digestOf(domainSeparator(domain), paymentStruct(m)));
    }
  });

  it("AgentVault: the authorize digest the contract computes is the one the formula gives", async () => {
    const [owner, fee] = await ethers.getSigners();
    const token = await deployContract("MockQUSDC");
    const router = await deployContract("PaymentRouter", [await token.getAddress(), owner!.address, fee!.address, 100]);
    const vault = await attach("AgentVault", await router.vault());
    const vaultAddress = await vault.getAddress();
    const m = vectors.authorize.message;
    const grant = { agent: m.agent, budget: m.budget, perCallCap: m.perCallCap, expiry: m.expiry };
    const onChain = await vault.hashAuthorization(m.payer, grant, m.tools, m.deadline); // the payer's nonce is 0 on a fresh vault
    const domain = { name: "SluiceAgentVault", version: "1", chainId: 1990, verifyingContract: vaultAddress };
    expect(onChain).to.equal(digestOf(domainSeparator(domain), authorizeStruct(m)));
    expect(await vault.hashTools(m.tools)).to.equal(keccak256(concat(m.tools.map(toolHash))));
  });
});

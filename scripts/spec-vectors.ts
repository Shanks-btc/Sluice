// pnpm spec:vectors
//
// Writes docs/spec-vectors.json: example intents with their hashes and signatures, for anyone implementing docs/SPEC.md.
//
// The signing keys are generated here, used once and dropped. They are never written anywhere: the file holds the address
// each signature must recover to, and a verifier checks that, so a reader needs no key. Because the keys are random, running
// this again produces a different file. It refuses to overwrite one unless given --overwrite, and the committed file is
// what test/unit/spec/vectors.test.ts verifies. That test recomputes every hash by hand, from the spec's own formulas.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Signature, TypedDataEncoder, Wallet, concat, getAddress, hexlify, id, randomBytes, zeroPadValue } from "ethers";
import {
  AUTHORIZE_TYPES, DOMAIN_NAME, DOMAIN_VERSION, PAYMENT_TYPES, REVOKE_TYPES, VAULT_DOMAIN_NAME, buildPaymentRequired, buildRequirements,
  resourceFor, toWire, toolIdOf, vaultDomain, routerDomain,
} from "@sluice/sdk";
import type { Intent, PaymentPayload, PaymentRequirements } from "@sluice/sdk";

const ROUTER = getAddress("0x51ce000000000000000000000000000000000001");
const OTHER_ROUTER = getAddress("0x51ce000000000000000000000000000000000002");
const VAULT = getAddress("0x51ce0000000000000000000000000000000000a1");
const ASSET = getAddress("0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5");
const BUILDER = getAddress("0xb01d000000000000000000000000000000000001");
const NOW = 1_800_000_000;

/** A nonce derived from a label, so the file's contents are easy to follow. Real nonces are random. */
const nonce = (label: string) => id(`sluice vector nonce: ${label}`);

const withdrawTypes = {
  Withdraw: [
    { name: "account", type: "address" },
    { name: "to", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "relayerFee", type: "uint256" },
    { name: "nonce", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
};
const refundTypes = {
  Refund: [
    { name: "payer", type: "address" },
    { name: "to", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "relayerFee", type: "uint256" },
    { name: "nonce", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
};

async function main(): Promise<void> {
  const path = join(__dirname, "..", "docs", "spec-vectors.json");
  if (existsSync(path) && !process.argv.includes("--overwrite")) {
    console.error("docs/spec-vectors.json exists. Run with --overwrite to replace it. The committed file is the one the tests verify.");
    process.exitCode = 1;
    return;
  }
  const payer = new Wallet(hexlify(randomBytes(32)));
  const agent = new Wallet(hexlify(randomBytes(32)));
  const domain = routerDomain(ROUTER, 1990);
  const types = PAYMENT_TYPES;
  const price = 10_000n; // 0.01 QUSDC
  const requirements: PaymentRequirements = buildRequirements({ toolName: "echo", amount: price, payTo: BUILDER, router: ROUTER, vault: VAULT, asset: ASSET });

  const make = async (
    name: string,
    signer: Wallet,
    over: Partial<Intent> = {},
    opts: { chainId?: number; router?: string; req?: PaymentRequirements; mutate?: (p: PaymentPayload) => void } = {},
  ) => {
    const intent: Intent = {
      payer: payer.address, payee: BUILDER, amount: price, toolId: toolIdOf("echo"), nonce: nonce(name), deadline: BigInt(NOW + 300), ...over,
    };
    const signedDomain = routerDomain(opts.router ?? ROUTER, opts.chainId ?? 1990);
    const signature = await signer.signTypedData(signedDomain, types, intent);
    const req = opts.req ?? requirements;
    const payload: PaymentPayload = { x402Version: 2, resource: resourceFor("echo", "Echoes text."), accepted: req, payload: { signature, authorization: toWire(intent) } };
    opts.mutate?.(payload);
    return { name, signer: signer.address, domain: signedDomain, message: toWire(intent), digest: TypedDataEncoder.hash(domain, types, intent), signature, payload };
  };

  const valid = [
    { ...(await make("payer signs for itself", payer)), expect: { ok: true, signer: payer.address } },
    { ...(await make("an agent session key signs for the payer", agent)), expect: { ok: true, signer: agent.address } },
    { ...(await make("the payer pays more than the price", payer, { amount: 20_000n })), expect: { ok: true, signer: payer.address } },
  ];

  const base = await make("base for the malformed forms", payer);
  const sig = Signature.from(base.signature);
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const highS = concat([sig.r, zeroPadValue(`0x${(N - BigInt(sig.s)).toString(16)}`, 32), hexlify(sig.v === 27 ? "0x1c" : "0x1b")]);
  const withSignature = (s: string) => (p: PaymentPayload) => void (p.payload.signature = s);
  const invalid = [
    { ...(await make("high-s twin of a valid signature", payer, {}, { mutate: withSignature(highS) })), expect: { error: "invalid_sluice_signature" } },
    { ...(await make("v is 0 or 1 instead of 27 or 28", payer, {}, { mutate: withSignature(concat([sig.r, sig.s, sig.v === 27 ? "0x00" : "0x01"])) })), expect: { error: "invalid_sluice_signature" } },
    { ...(await make("signature is 64 bytes", payer, {}, { mutate: withSignature(base.signature.slice(0, 130)) })), expect: { error: "invalid_sluice_signature" } },
    { ...(await make("expired", payer, { deadline: BigInt(NOW + 5) })), expect: { error: "sluice_intent_expired" } },
    { ...(await make("deadline too far away", payer, { deadline: BigInt(NOW + 100_000) })), expect: { error: "sluice_deadline_too_far" } },
    { ...(await make("amount below the price", payer, { amount: price - 1n })), expect: { error: "sluice_amount_too_low" } },
    { ...(await make("payee is not the payTo address", payer, { payee: getAddress("0xb01d000000000000000000000000000000000002") })), expect: { error: "sluice_payee_mismatch" } },
    { ...(await make("tool id is for another tool", payer, { toolId: toolIdOf("other") })), expect: { error: "sluice_tool_mismatch" } },
    { ...(await make("the client edited the price in its copy of the terms", payer, {}, { mutate: (p) => void (p.accepted = { ...p.accepted, amount: "1" }) })), expect: { error: "sluice_accepted_mismatch" } },
    { ...(await make("scheme is not sluice-intent", payer, {}, { mutate: (p) => void (p.accepted = { ...p.accepted, scheme: "exact" }) })), expect: { error: "invalid_scheme" } },
    { ...(await make("network is not eip155:1990", payer, {}, { mutate: (p) => void (p.accepted = { ...p.accepted, network: "eip155:8453" }) })), expect: { error: "invalid_network" } },
    { ...(await make("the terms name another router", payer, {}, { mutate: (p) => void (p.accepted = { ...p.accepted, extra: { ...p.accepted.extra, router: OTHER_ROUTER } }) })), expect: { error: "invalid_sluice_router" } },
  ];
  // A signature made under another chain id or another router is well formed, so the stateless checks pass it. It recovers
  // to an unrelated key, which is not the payer and holds no session, so the facilitator refuses it.
  const wrongChain = await make("signed for chain id 1", payer, {}, { chainId: 1 });
  const wrongRouter = await make("signed for another router", payer, {}, { router: OTHER_ROUTER });
  const recoversElsewhere = [
    { ...wrongChain, expect: { ok: true, signerIsPayer: false, facilitatorError: "sluice_session_not_found" } },
    { ...wrongRouter, expect: { ok: true, signerIsPayer: false, facilitatorError: "sluice_session_not_found" } },
  ];

  // Other signed messages
  const withdrawMsg = { account: payer.address, to: BUILDER, amount: 5_000n, relayerFee: 0n, nonce: nonce("withdraw"), deadline: BigInt(NOW + 600) };
  const refundMsg = { payer: payer.address, to: BUILDER, amount: 7_000n, relayerFee: 0n, nonce: nonce("refund"), deadline: BigInt(NOW + 600) };
  const tools = [
    { payee: BUILDER, toolId: toolIdOf("echo") },
    { payee: BUILDER, toolId: toolIdOf("token_risk_check") },
  ];
  const authorizeMsg = {
    payer: payer.address, agent: agent.address, budget: 500_000n, perCallCap: 20_000n, expiry: BigInt(NOW + 86_400), tools, nonce: 0n, deadline: BigInt(NOW + 600),
  };
  const revokeMsg = { payer: payer.address, agent: agent.address, nonce: 1n, deadline: BigInt(NOW + 600) };
  const vdomain = vaultDomain(VAULT, 1990);
  const str = (o: object) => JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) as Record<string, unknown>;

  const out = {
    name: "Sluice payment scheme: test vectors",
    specification: "docs/SPEC.md",
    version: 1,
    generated: new Date(Date.UTC(2026, 10, 19)).toISOString().slice(0, 10),
    note: "Signed with throwaway keys that were generated for this file and then discarded. No private key is published. Each vector gives the address its signature must recover to. docs/SPEC.md says how to recompute every hash.",
    verifierNow: NOW,
    scheme: "sluice-intent",
    network: "eip155:1990",
    addresses: { router: ROUTER, vault: VAULT, asset: ASSET, builder: BUILDER, payer: payer.address, agent: agent.address },
    toolIds: [
      { toolName: "echo", toolId: toolIdOf("echo") },
      { toolName: "other", toolId: toolIdOf("other") },
      { toolName: "token_risk_check", toolId: toolIdOf("token_risk_check") },
    ],
    typeStrings: {
      EIP712Domain: "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
      Payment: "Payment(address payer,address payee,uint256 amount,bytes32 toolId,bytes32 nonce,uint256 deadline)",
      Withdraw: "Withdraw(address account,address to,uint256 amount,uint256 relayerFee,bytes32 nonce,uint256 deadline)",
      Refund: "Refund(address payer,address to,uint256 amount,uint256 relayerFee,bytes32 nonce,uint256 deadline)",
      Authorize: "Authorize(address payer,address agent,uint256 budget,uint256 perCallCap,uint256 expiry,Tool[] tools,uint256 nonce,uint256 deadline)Tool(address payee,bytes32 toolId)",
      Revoke: "Revoke(address payer,address agent,uint256 nonce,uint256 deadline)",
    },
    domains: {
      router: { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId: 1990, verifyingContract: ROUTER, separator: TypedDataEncoder.hashDomain(domain) },
      vault: { name: VAULT_DOMAIN_NAME, version: DOMAIN_VERSION, chainId: 1990, verifyingContract: VAULT, separator: TypedDataEncoder.hashDomain(vdomain) },
    },
    paymentRequired: buildPaymentRequired(resourceFor("echo", "Echoes text."), [requirements]),
    paymentVectors: { valid, invalid, recoversToAnotherKey: recoversElsewhere },
    withdraw: { domain: str(domain), message: str(withdrawMsg), digest: TypedDataEncoder.hash(domain, withdrawTypes, withdrawMsg), signer: payer.address, signature: await payer.signTypedData(domain, withdrawTypes, withdrawMsg) },
    refund: { domain: str(domain), message: str(refundMsg), digest: TypedDataEncoder.hash(domain, refundTypes, refundMsg), signer: payer.address, signature: await payer.signTypedData(domain, refundTypes, refundMsg) },
    authorize: { domain: str(vdomain), message: str(authorizeMsg), digest: TypedDataEncoder.hash(vdomain, AUTHORIZE_TYPES, authorizeMsg), signer: payer.address, signature: await payer.signTypedData(vdomain, AUTHORIZE_TYPES, authorizeMsg) },
    revoke: { domain: str(vdomain), message: str(revokeMsg), digest: TypedDataEncoder.hash(vdomain, REVOKE_TYPES, revokeMsg), signer: payer.address, signature: await payer.signTypedData(vdomain, REVOKE_TYPES, revokeMsg) },
  };
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`wrote docs/spec-vectors.json: ${valid.length} valid, ${invalid.length} invalid and ${recoversElsewhere.length} recover-elsewhere payment vectors, plus withdraw, refund, authorize and revoke`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : "failed");
  process.exitCode = 1;
});

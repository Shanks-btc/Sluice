// The Sluice payment scheme: types, EIP-712 hashing and signing, and the checks a verifier must run.
// docs/SPEC.md is the written form of this file. Everything here is pure: no network, no clock unless one is
// passed in, so the same checks can run in a tool server, in a facilitator and in a test.
//
// Wire format: x402 v2 over MCP (specs/transports-v2/mcp.md in the x402 repository), with one new scheme name,
// "sluice-intent", whose payload is an EIP-712 signed intent for the PaymentRouter. See docs/SPEC.md for where
// this differs from the x402 "exact" scheme.
import { Signature, TypedDataEncoder, getAddress, hexlify, id, isHexString, randomBytes, verifyTypedData } from "ethers";
import type { TypedDataDomain } from "ethers";

// ---------------------------------------------------------------------------------------------- constants

export const X402_VERSION = 2;
export const SCHEME = "sluice-intent";
export const CHAIN_ID = 1990;
export const NETWORK = `eip155:${CHAIN_ID}`;
export const QUSDC_ADDRESS = "0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5";
export const QUSDC_DECIMALS = 6;
export const DOMAIN_NAME = "SluiceRouter";
export const DOMAIN_VERSION = "1";
/** `params._meta` key a client puts its PaymentPayload under (x402 MCP transport). */
export const PAYMENT_META_KEY = "x402/payment";
/** `result._meta` key a server puts its SettleResponse under (x402 MCP transport). */
export const PAYMENT_RESPONSE_META_KEY = "x402/payment-response";
/** `tools/list` `_meta` key under which a server may advertise a tool's price. Advisory only. */
export const PRICING_META_KEY = "sluice/pricing";
/** The longest a signed intent may stay valid, from the verifier's clock. */
export const MAX_INTENT_LIFETIME_SECONDS = 3600;
export const DEFAULT_TIMEOUT_SECONDS = 300;
/** A verifier accepts an intent whose deadline is at most this far past `now + maxTimeoutSeconds`. */
export const CLOCK_SLACK_SECONDS = 30;
/** An intent must have at least this long left when it is checked, so a batch has time to be submitted. */
export const MIN_REMAINING_SECONDS = 20;

export const PAYMENT_TYPES: Record<string, Array<{ name: string; type: string }>> = {
  Payment: [
    { name: "payer", type: "address" },
    { name: "payee", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "toolId", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
};

/** Every error code a Sluice verifier or facilitator returns. x402's own names are reused where one exists. */
export const ERRORS = {
  // x402 names
  invalidVersion: "invalid_x402_version",
  invalidScheme: "invalid_scheme",
  invalidNetwork: "invalid_network",
  invalidPayload: "invalid_payload",
  invalidRequirements: "invalid_payment_requirements",
  insufficientFunds: "insufficient_funds",
  unexpectedVerify: "unexpected_verify_error",
  unexpectedSettle: "unexpected_settle_error",
  // Sluice names
  invalidAsset: "invalid_sluice_asset",
  invalidRouter: "invalid_sluice_router",
  invalidSignature: "invalid_sluice_signature",
  payeeMismatch: "sluice_payee_mismatch",
  toolMismatch: "sluice_tool_mismatch",
  amountTooLow: "sluice_amount_too_low",
  acceptedMismatch: "sluice_accepted_mismatch",
  expired: "sluice_intent_expired",
  deadlineTooFar: "sluice_deadline_too_far",
  nonceUsed: "sluice_nonce_used",
  intentReplayed: "sluice_intent_already_used",
  sessionNotFound: "sluice_session_not_found",
  sessionExpired: "sluice_session_expired",
  perCallCap: "sluice_per_call_cap_exceeded",
  budgetExceeded: "sluice_budget_exceeded",
  toolNotAllowed: "sluice_tool_not_allowed",
  capPayerDaily: "sluice_cap_payer_daily",
  capGlobalDaily: "sluice_cap_global_daily",
  capBudget: "sluice_relayer_budget_exhausted",
  capGasPrice: "sluice_relayer_gas_price_too_high",
  facilitatorUnavailable: "sluice_facilitator_unavailable",
  storeUnavailable: "sluice_store_unavailable",
  killSwitch: "sluice_kill_switch",
  rateLimited: "sluice_rate_limited",
  notFound: "sluice_not_found",
  onboardRefused: "sluice_onboard_refused",
  relayRefused: "sluice_relay_refused",
} as const;
export type ErrorCode = (typeof ERRORS)[keyof typeof ERRORS];

// -------------------------------------------------------------------------------------------------- types

export type Intent = {
  payer: string;
  payee: string;
  amount: bigint;
  toolId: string;
  nonce: string;
  deadline: bigint;
};

/** The same fields as strings, as they travel in JSON. */
export type WireIntent = {
  payer: string;
  payee: string;
  amount: string;
  toolId: string;
  nonce: string;
  deadline: string;
};

export type ResourceInfo = {
  url: string;
  description?: string;
  mimeType?: string;
};

export type PaymentRequirements = {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: {
    name: string;
    version: string;
    router: string;
    toolId: string;
    vault?: string;
    facilitator?: string;
    [key: string]: unknown;
  };
};

export type PaymentRequired = {
  x402Version: number;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
};

export type PaymentPayload = {
  x402Version: number;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: { signature: string; authorization: WireIntent };
  extensions?: Record<string, unknown>;
};

export type SettleExtension = { id: string; status: string; statusUrl?: string };

export type SettleResponse = {
  success: boolean;
  errorReason?: string;
  payer?: string;
  transaction: string;
  network: string;
  amount?: string;
  extensions?: { sluice?: SettleExtension; [key: string]: unknown };
};

export type VerifyResponse = {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
  extra?: Record<string, unknown>;
};

// --------------------------------------------------------------------------------- amounts and identifiers

const SCALE = 10n ** BigInt(QUSDC_DECIMALS);
/** Half of the secp256k1 group order, the largest s the router accepts. */
const HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/** "0.01" -> 10000n. Accepts a decimal with at most six places, or a bigint of units. */
export function parseQusdc(price: string | bigint): bigint {
  if (typeof price === "bigint") {
    if (price <= 0n) throw new Error("a price must be above zero");
    return price;
  }
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(price.trim());
  if (!match) throw new Error(`not a QUSDC amount with at most six decimals: ${JSON.stringify(price)}`);
  const units = BigInt(match[1] as string) * SCALE + BigInt((match[2] ?? "").padEnd(QUSDC_DECIMALS, "0") || "0");
  if (units <= 0n) throw new Error("a price must be above zero");
  return units;
}

/** 10000n -> "0.010000". */
export function formatQusdc(units: bigint): string {
  const whole = units / SCALE;
  const frac = (units % SCALE).toString().padStart(QUSDC_DECIMALS, "0");
  return `${whole}.${frac}`;
}

/** A tool id is the keccak256 of the tool's name, so a payment is bound to one tool. */
export function toolIdOf(toolName: string): string {
  return id(toolName);
}

export function newNonce(): string {
  return hexlify(randomBytes(32));
}

export function routerDomain(router: string, chainId: number = CHAIN_ID): TypedDataDomain {
  return { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId, verifyingContract: getAddress(router) };
}

export function toWire(intent: Intent): WireIntent {
  return {
    payer: getAddress(intent.payer),
    payee: getAddress(intent.payee),
    amount: intent.amount.toString(),
    toolId: intent.toolId.toLowerCase(),
    nonce: intent.nonce.toLowerCase(),
    deadline: intent.deadline.toString(),
  };
}

const DECIMAL = /^(0|[1-9]\d*)$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

/** Reads a WireIntent from untrusted JSON. Returns undefined for anything malformed. */
export function fromWire(value: unknown): Intent | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  try {
    if (typeof v.amount !== "string" || !DECIMAL.test(v.amount)) return undefined;
    if (typeof v.deadline !== "string" || !DECIMAL.test(v.deadline)) return undefined;
    if (typeof v.toolId !== "string" || !BYTES32.test(v.toolId)) return undefined;
    if (typeof v.nonce !== "string" || !BYTES32.test(v.nonce)) return undefined;
    if (typeof v.payer !== "string" || typeof v.payee !== "string") return undefined;
    const amount = BigInt(v.amount);
    const deadline = BigInt(v.deadline);
    if (amount >= 2n ** 256n || deadline >= 2n ** 256n) return undefined;
    return {
      payer: getAddress(v.payer),
      payee: getAddress(v.payee),
      amount,
      toolId: v.toolId.toLowerCase(),
      nonce: v.nonce.toLowerCase(),
      deadline,
    };
  } catch {
    return undefined;
  }
}

// -------------------------------------------------------------------------------- hashing and signatures

/** The EIP-712 digest the router computes for an intent. It is also the intent's id everywhere in Sluice. */
export function intentDigest(router: string, intent: Intent, chainId: number = CHAIN_ID): string {
  return TypedDataEncoder.hash(routerDomain(router, chainId), PAYMENT_TYPES, intent);
}

/** Anything that can sign EIP-712 typed data: an ethers Wallet, or a Hardhat signer. */
export type TypedSigner = {
  address: string;
  signTypedData: (
    domain: TypedDataDomain,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ) => Promise<string>;
};

export async function signIntent(
  signer: TypedSigner,
  router: string,
  intent: Intent,
  chainId: number = CHAIN_ID,
): Promise<string> {
  return signer.signTypedData(routerDomain(router, chainId), PAYMENT_TYPES, intent);
}

/**
 * Recovers the signer of an intent, or undefined if the signature is not exactly what the router accepts:
 * 65 bytes, v of 27 or 28, and a low s. The router rejects every other form, so a verifier must too.
 */
export function recoverSigner(
  router: string,
  intent: Intent,
  signature: string,
  chainId: number = CHAIN_ID,
): string | undefined {
  if (typeof signature !== "string" || !isHexString(signature, 65)) return undefined;
  const v = Number.parseInt(signature.slice(130, 132), 16);
  if (v !== 27 && v !== 28) return undefined;
  try {
    // The router refuses an s above half the group order (EIP-2). ethers only refuses one with the top bit set,
    // which is a wider range, so the exact bound is checked here.
    if (BigInt(`0x${signature.slice(66, 130)}`) > HALF_ORDER) return undefined;
    Signature.from(signature);
    return verifyTypedData(routerDomain(router, chainId), PAYMENT_TYPES, intent, signature);
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------------------------- the pure checks

export type PaymentCheck =
  | { ok: true; intent: Intent; signer: string; digest: string; signature: string }
  | { ok: false; code: ErrorCode; detail: string };

export type CheckContext = {
  /** The chain the verifier serves. */
  chainId: number;
  /** The router the verifier serves. A payload naming another router is refused. */
  router: string;
  /** The asset the verifier serves. Defaults to QUSDC. */
  asset?: string;
  /** Unix seconds. */
  now: number;
};

const fail = (code: ErrorCode, detail: string): PaymentCheck => ({ ok: false, code, detail });

function sameAddress(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
}

/** The fields of the requirements that a payment must have been made for, compared as the server sees them. */
function sameRequirements(a: PaymentRequirements, b: PaymentRequirements): boolean {
  return (
    a.scheme === b.scheme &&
    a.network === b.network &&
    a.amount === b.amount &&
    sameAddress(a.asset, b.asset) &&
    sameAddress(a.payTo, b.payTo) &&
    a.maxTimeoutSeconds === b.maxTimeoutSeconds &&
    sameAddress(a.extra?.router, b.extra?.router) &&
    String(a.extra?.toolId).toLowerCase() === String(b.extra?.toolId).toLowerCase() &&
    a.extra?.name === b.extra?.name &&
    a.extra?.version === b.extra?.version
  );
}

/** Reads the requirements from untrusted JSON into the strict shape, or returns undefined. */
export function parseRequirements(value: unknown): PaymentRequirements | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const extra = v.extra;
  if (typeof v.scheme !== "string" || typeof v.network !== "string") return undefined;
  if (typeof v.amount !== "string" || !DECIMAL.test(v.amount)) return undefined;
  if (typeof v.asset !== "string" || typeof v.payTo !== "string") return undefined;
  if (typeof v.maxTimeoutSeconds !== "number" || !Number.isInteger(v.maxTimeoutSeconds) || v.maxTimeoutSeconds <= 0) return undefined;
  if (typeof extra !== "object" || extra === null) return undefined;
  const e = extra as Record<string, unknown>;
  if (typeof e.name !== "string" || typeof e.version !== "string") return undefined;
  if (typeof e.router !== "string" || typeof e.toolId !== "string" || !BYTES32.test(e.toolId)) return undefined;
  try {
    getAddress(v.asset);
    getAddress(v.payTo);
    getAddress(e.router);
  } catch {
    return undefined;
  }
  return value as PaymentRequirements;
}

export function parsePayload(value: unknown): PaymentPayload | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.x402Version !== "number") return undefined;
  const accepted = parseRequirements(v.accepted);
  if (!accepted) return undefined;
  const inner = v.payload;
  if (typeof inner !== "object" || inner === null) return undefined;
  const p = inner as Record<string, unknown>;
  if (typeof p.signature !== "string") return undefined;
  if (!fromWire(p.authorization)) return undefined;
  return value as PaymentPayload;
}

/**
 * Everything that can be checked without the chain. `requirements` is what the resource server said it wants;
 * the payload's own copy (`accepted`) is checked against it and never trusted for the price.
 *
 * Order matters only for which code a bad payment gets. Every check must pass for the payment to pass.
 */
export function checkPayment(payload: PaymentPayload, requirements: PaymentRequirements, ctx: CheckContext): PaymentCheck {
  if (payload.x402Version !== X402_VERSION) return fail(ERRORS.invalidVersion, `x402Version must be ${X402_VERSION}`);
  if (requirements.scheme !== SCHEME || payload.accepted.scheme !== SCHEME) {
    return fail(ERRORS.invalidScheme, `scheme must be ${SCHEME}`);
  }
  const network = `eip155:${ctx.chainId}`;
  if (requirements.network !== network || payload.accepted.network !== network) {
    return fail(ERRORS.invalidNetwork, `network must be ${network}`);
  }
  const asset = ctx.asset ?? QUSDC_ADDRESS;
  if (!sameAddress(requirements.asset, asset)) return fail(ERRORS.invalidAsset, `asset must be ${getAddress(asset)}`);
  if (!sameAddress(requirements.extra.router, ctx.router) || !sameAddress(payload.accepted.extra.router, ctx.router)) {
    return fail(ERRORS.invalidRouter, `router must be ${getAddress(ctx.router)}`);
  }
  if (requirements.extra.name !== DOMAIN_NAME || requirements.extra.version !== DOMAIN_VERSION) {
    return fail(ERRORS.invalidRequirements, `extra.name and extra.version must be ${DOMAIN_NAME} and ${DOMAIN_VERSION}`);
  }
  if (!sameRequirements(payload.accepted, requirements)) {
    return fail(ERRORS.acceptedMismatch, "the payment was made for terms other than the ones offered");
  }
  const intent = fromWire(payload.payload.authorization);
  if (!intent) return fail(ERRORS.invalidPayload, "authorization is malformed");

  if (!sameAddress(intent.payee, requirements.payTo)) return fail(ERRORS.payeeMismatch, "payee is not the payTo address");
  if (intent.toolId !== String(requirements.extra.toolId).toLowerCase()) {
    return fail(ERRORS.toolMismatch, "toolId is not the tool's id");
  }
  if (intent.amount === 0n) return fail(ERRORS.invalidPayload, "amount must be above zero");
  if (intent.amount < BigInt(requirements.amount)) {
    return fail(ERRORS.amountTooLow, `amount ${intent.amount} is below the price ${requirements.amount}`);
  }

  const deadline = intent.deadline;
  const now = BigInt(ctx.now);
  if (deadline < now + BigInt(MIN_REMAINING_SECONDS)) return fail(ERRORS.expired, "the intent is expired or about to be");
  const latest = now + BigInt(Math.min(requirements.maxTimeoutSeconds, MAX_INTENT_LIFETIME_SECONDS) + CLOCK_SLACK_SECONDS);
  if (deadline > latest) return fail(ERRORS.deadlineTooFar, "the deadline is further away than the offer allows");

  const signer = recoverSigner(ctx.router, intent, payload.payload.signature, ctx.chainId);
  if (!signer) return fail(ERRORS.invalidSignature, "the signature is malformed or malleable, or does not recover to a signer");
  return {
    ok: true,
    intent,
    signer,
    digest: intentDigest(ctx.router, intent, ctx.chainId),
    signature: payload.payload.signature,
  };
}

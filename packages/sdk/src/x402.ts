// Building and reading the x402-over-MCP messages: the payment-required tool result, the payment in
// params._meta, and the settlement response in result._meta. Wire format: x402 repository,
// specs/transports-v2/mcp.md. docs/SPEC.md lists exactly where Sluice differs.
import { getAddress } from "ethers";
import {
  DEFAULT_TIMEOUT_SECONDS,
  DOMAIN_NAME,
  DOMAIN_VERSION,
  NETWORK,
  PAYMENT_META_KEY,
  PAYMENT_RESPONSE_META_KEY,
  QUSDC_ADDRESS,
  SCHEME,
  X402_VERSION,
  parsePayload,
  toolIdOf,
} from "./protocol";
import type {
  ErrorCode,
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  ResourceInfo,
  SettleResponse,
} from "./protocol";

/** The MCP CallToolResult fields Sluice reads and writes. Kept structural so any SDK version fits. */
export type ToolResult = {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
};

export type RequirementsInput = {
  toolName: string;
  /** Price in QUSDC units. */
  amount: bigint;
  payTo: string;
  router: string;
  vault?: string;
  chainId?: number;
  asset?: string;
  maxTimeoutSeconds?: number;
  facilitator?: string;
};

export function buildRequirements(input: RequirementsInput): PaymentRequirements {
  const chainId = input.chainId;
  return {
    scheme: SCHEME,
    network: chainId === undefined ? NETWORK : `eip155:${chainId}`,
    amount: input.amount.toString(),
    asset: getAddress(input.asset ?? QUSDC_ADDRESS),
    payTo: getAddress(input.payTo),
    maxTimeoutSeconds: input.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
    extra: {
      name: DOMAIN_NAME,
      version: DOMAIN_VERSION,
      router: getAddress(input.router),
      toolId: toolIdOf(input.toolName),
      ...(input.vault ? { vault: getAddress(input.vault) } : {}),
      ...(input.facilitator ? { facilitator: input.facilitator } : {}),
    },
  };
}

export function resourceFor(toolName: string, description?: string): ResourceInfo {
  return { url: `mcp://tool/${toolName}`, ...(description ? { description } : {}), mimeType: "application/json" };
}

export function buildPaymentRequired(resource: ResourceInfo, accepts: PaymentRequirements[], error?: string): PaymentRequired {
  return { x402Version: X402_VERSION, ...(error ? { error } : {}), resource, accepts };
}

/** The tool result a server returns when payment is missing or wrong: isError, structuredContent and a text copy. */
export function paymentRequiredResult(required: PaymentRequired): ToolResult {
  return {
    isError: true,
    structuredContent: required as unknown as Record<string, unknown>,
    content: [{ type: "text", text: JSON.stringify(required) }],
  };
}

/**
 * Reads a PaymentRequired out of a tool result, preferring structuredContent and falling back to the JSON
 * in content[0].text, as the x402 MCP transport says clients should. Returns undefined for any other result.
 */
export function parsePaymentRequired(result: unknown): PaymentRequired | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const r = result as Record<string, unknown>;
  if (r.isError !== true) return undefined;
  const candidates: unknown[] = [r.structuredContent];
  const first = Array.isArray(r.content) ? (r.content[0] as { text?: unknown } | undefined) : undefined;
  if (first && typeof first.text === "string") {
    try {
      candidates.push(JSON.parse(first.text));
    } catch {
      // not JSON: an ordinary error message
    }
  }
  for (const c of candidates) {
    if (typeof c !== "object" || c === null) continue;
    const v = c as Record<string, unknown>;
    if (typeof v.x402Version === "number" && Array.isArray(v.accepts) && typeof v.resource === "object" && v.resource !== null) {
      return v as unknown as PaymentRequired;
    }
  }
  return undefined;
}

/** Reads `params._meta["x402/payment"]`. Returns the payload, `"malformed"` if one is there but unreadable, or undefined. */
export function readPayment(meta: unknown): PaymentPayload | "malformed" | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;
  const raw = (meta as Record<string, unknown>)[PAYMENT_META_KEY];
  if (raw === undefined) return undefined;
  return parsePayload(raw) ?? "malformed";
}

/** A copy of a tool result with the settlement response attached under result._meta["x402/payment-response"]. */
export function withSettlement(result: ToolResult, settlement: SettleResponse): ToolResult {
  return { ...result, _meta: { ...(result._meta ?? {}), [PAYMENT_RESPONSE_META_KEY]: settlement } };
}

export function settlementOf(result: unknown): SettleResponse | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const meta = (result as { _meta?: Record<string, unknown> })._meta;
  const s = meta?.[PAYMENT_RESPONSE_META_KEY];
  return typeof s === "object" && s !== null ? (s as SettleResponse) : undefined;
}

/** A tool-result error that is not a payment request, for failures a client should not answer by paying. */
export function errorResult(code: ErrorCode | string, message: string): ToolResult {
  return {
    isError: true,
    structuredContent: { error: code, message },
    content: [{ type: "text", text: `${code}: ${message}` }],
  };
}

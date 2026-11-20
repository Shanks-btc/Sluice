// Reading a facilitator's /health and /status from the demo page. A facilitator is an address the person types in, so everything it
// sends back is untrusted: the answer is size-limited, parsed into a strict shape, and shown as text. Nothing here sends a payment.
import { parseWebUrl } from "./config";
import { isLocalUrl } from "./networks";
import type { NetworkId } from "./networks";

export type UrlCheck = { ok: true; url: string } | { ok: false; reason: string };

/** An https address, or an http address on this machine. No credentials, no query, no fragment. */
export function validateFacilitatorUrl(text: string): UrlCheck {
  const t = text.trim();
  if (t === "") return { ok: false, reason: "Enter the address of a facilitator." };
  const url = parseWebUrl(t);
  if (!url) return { ok: false, reason: "Use an https address, or an http address on this machine, like http://127.0.0.1:8402." };
  if (url.search || url.hash) return { ok: false, reason: "The address must not have a query or a fragment." };
  return { ok: true, url: url.toString().replace(/\/+$/, "") };
}

/** A warning when the network the person chose does not fit the address they typed. Never blocks; only says. */
export function targetWarning(target: NetworkId, url: string): string | undefined {
  const local = isLocalUrl(url);
  if (target === "local" && !local) return "You chose a local network, but this address is not on your machine.";
  if (target !== "local" && local) return "You chose a QIE network, but this address is on your machine.";
  return undefined;
}

export type FetchLike = (input: string, init?: { method?: string; signal?: AbortSignal; credentials?: "omit"; referrerPolicy?: "no-referrer"; headers?: Record<string, string> }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

export type Fetched = { ok: true; status: number; json: unknown } | { ok: false; reason: string };

export const MAX_RESPONSE_CHARS = 100_000;
export const REQUEST_TIMEOUT_MS = 8_000;

export async function fetchJson(url: string, fetchImpl: FetchLike = (u, i) => fetch(u, i as RequestInit)): Promise<Fetched> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { method: "GET", signal: controller.signal, credentials: "omit", referrerPolicy: "no-referrer", headers: { accept: "application/json" } });
    const text = await res.text();
    if (text.length > MAX_RESPONSE_CHARS) return { ok: false, reason: "The answer was larger than the page will read." };
    try {
      return { ok: true, status: res.status, json: JSON.parse(text) };
    } catch {
      return { ok: false, reason: `The address answered with something that is not JSON (HTTP ${res.status}).` };
    }
  } catch {
    return { ok: false, reason: "The address could not be reached from this browser." };
  } finally {
    clearTimeout(timer);
  }
}

const text = (v: unknown, max = 200): string | undefined => (typeof v === "string" && v.length <= max ? v : undefined);
const digits = (v: unknown): string | undefined => (typeof v === "string" && /^\d{1,40}$/.test(v) ? v : undefined);
const address = (v: unknown): string | undefined => (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? v : undefined);

export type HealthView = {
  chainId?: number;
  router?: string;
  vault?: string;
  relayer?: string;
  relayerBalanceWei?: string;
  budgetWei?: string;
  spentWei?: string;
  remainingWei?: string;
  queued?: number;
  alerts: string[];
};

/** Reads only the fields the page shows, each checked. Anything else in the answer is dropped. */
export function parseHealth(json: unknown): HealthView | undefined {
  if (typeof json !== "object" || json === null) return undefined;
  const j = json as Record<string, unknown>;
  if (j.ok !== true) return undefined;
  const budget = typeof j.budget === "object" && j.budget !== null ? (j.budget as Record<string, unknown>) : {};
  const alerts = Array.isArray(j.alerts)
    ? j.alerts.slice(0, 20).map((a) => (typeof a === "string" ? a : typeof a === "object" && a !== null ? text((a as Record<string, unknown>).code) ?? text((a as Record<string, unknown>).message) : undefined)).filter((a): a is string => typeof a === "string")
    : [];
  return {
    chainId: typeof j.chainId === "number" && Number.isSafeInteger(j.chainId) ? j.chainId : undefined,
    router: address(j.router),
    vault: address(j.vault),
    relayer: address(j.relayer),
    relayerBalanceWei: digits(j.relayerBalanceWei),
    budgetWei: digits(budget.budgetWei),
    spentWei: digits(budget.spentWei),
    remainingWei: digits(budget.remainingWei),
    queued: typeof j.queued === "number" && Number.isSafeInteger(j.queued) ? j.queued : undefined,
    alerts,
  };
}

export type StatusView = { id?: string; status?: string; transaction?: string; blockNumber?: number; reason?: string };

export const INTENT_ID = /^0x[0-9a-fA-F]{64}$/;

export function parseStatus(json: unknown): StatusView | undefined {
  if (typeof json !== "object" || json === null) return undefined;
  const j = json as Record<string, unknown>;
  if (typeof j.error === "string") return undefined;
  const status = text(j.status, 20);
  if (!status || !["queued", "submitted", "settled", "skipped", "expired", "failed"].includes(status)) return undefined;
  return {
    id: typeof j.id === "string" && INTENT_ID.test(j.id) ? j.id : undefined,
    status,
    transaction: typeof j.transaction === "string" && INTENT_ID.test(j.transaction) ? j.transaction : undefined,
    blockNumber: typeof j.blockNumber === "number" && Number.isSafeInteger(j.blockNumber) ? j.blockNumber : undefined,
    reason: text(j.reason, 120),
  };
}

export async function getHealth(base: string, fetchImpl?: FetchLike): Promise<{ ok: true; health: HealthView } | { ok: false; reason: string }> {
  const res = await fetchJson(`${base}/health`, fetchImpl);
  if (!res.ok) return res;
  const health = parseHealth(res.json);
  return health ? { ok: true, health } : { ok: false, reason: "The address answered, but not like a Sluice facilitator's /health." };
}

export async function getStatus(base: string, id: string, fetchImpl?: FetchLike): Promise<{ ok: true; status: StatusView } | { ok: false; reason: string }> {
  if (!INTENT_ID.test(id.trim())) return { ok: false, reason: "An intent id is 0x and 64 hex characters." };
  const res = await fetchJson(`${base}/status/${id.trim()}`, fetchImpl);
  if (!res.ok) return res;
  const status = parseStatus(res.json);
  return status ? { ok: true, status } : { ok: false, reason: "The facilitator does not know that intent, or answered in a form the page does not read." };
}

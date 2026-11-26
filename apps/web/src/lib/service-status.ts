// The /status page's data: whether the services the live pages depend on are working, read from the services themselves.
//
// It reads, from the server and with GET requests only: the facilitator's /health, the tool server's /health, and an eth_chainId probe of
// the QIE endpoints. Everything it reports is already public (a service's /health holds no key and no payer's data). Answers are held for
// a few seconds, so a crowd of visitors makes one set of requests to the services, not one each, and the JSON route has its own limiter.
import { QIE_ENDPOINTS, probeEndpoints } from "@sluice/sdk/rpc";
import { isLocalUrl } from "./networks";
import type { AppConfig } from "./config";
import { fetchJson } from "./facilitator";
import type { FetchLike } from "./facilitator";
import { parseToolServerHealth } from "./paid-call";
import type { ToolListing } from "./paid-call";
import { RateLimiter, callerKey } from "./rate-limit";

export type Overall = "operational" | "degraded" | "down" | "not_configured";

export type RpcProbeView = { host: string; ok: boolean; ms: number; reason?: string };

export type FacilitatorStatus =
  | { configured: false }
  | { configured: true; reachable: false; reason: string }
  | {
      configured: true;
      reachable: true;
      /** The service's own verdict: false when it is shutting down or cannot record what it is told. */
      ok: boolean;
      chainId?: number;
      chainMatches: boolean;
      routerMatches: boolean;
      killSwitch: boolean;
      lowBalance: boolean;
      draining: boolean;
      storeHealthy: boolean;
      queued: number;
      inFlight: number;
      oldestInFlightAgeSeconds: number;
      relayerBalanceWei?: string;
      alerts: string[];
      lastSettled: { blockNumber: number | null; at: number; ageSeconds: number } | null;
    };

export type ToolsStatus =
  | { configured: false }
  | { configured: true; reachable: false; reason: string }
  | { configured: true; reachable: true; chainMatches: boolean; routerMatches: boolean; tools: ToolListing[] };

export type ServiceStatus = {
  /** When this was read, in milliseconds. */
  checkedAt: number;
  chainId: number;
  network: string;
  realFunds: boolean;
  overall: Overall;
  /** The things that are wrong, in words, most serious first. Empty when operational. */
  problems: string[];
  facilitator: FacilitatorStatus;
  tools: ToolsStatus;
  rpc: { endpoints: RpcProbeView[]; healthy: number };
};

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined);
const flag = (v: unknown): boolean => v === true;
const digits = (v: unknown): string | undefined => (typeof v === "string" && /^\d{1,40}$/.test(v) ? v : undefined);
const addr = (v: unknown): string | undefined => (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : undefined);

/** A lenient reading of a facilitator's /health: unlike the demo's, it accepts a service that says ok: false, because that is what a status page is for. */
export function readFacilitatorHealth(json: unknown, expected: { chainId: number; router: string | null }, nowSeconds: number): FacilitatorStatus {
  if (typeof json !== "object" || json === null) return { configured: true, reachable: false, reason: "It answered with something that is not a health report." };
  const j = json as Record<string, unknown>;
  if (typeof j.ok !== "boolean" || num(j.chainId) === undefined) return { configured: true, reachable: false, reason: "It answered, but not like a Sluice facilitator's /health." };
  const store = typeof j.store === "object" && j.store !== null ? (j.store as Record<string, unknown>) : {};
  const flight = typeof j.inFlight === "object" && j.inFlight !== null ? (j.inFlight as Record<string, unknown>) : {};
  const last = typeof j.lastSettled === "object" && j.lastSettled !== null ? (j.lastSettled as Record<string, unknown>) : undefined;
  const at = last ? num(last.at) : undefined;
  const alerts = Array.isArray(j.alerts)
    ? j.alerts
        .slice(0, 20)
        .map((a) => (typeof a === "string" ? a : typeof a === "object" && a !== null && typeof (a as Record<string, unknown>).kind === "string" ? String((a as Record<string, unknown>).kind) : undefined))
        .filter((a): a is string => typeof a === "string" && /^[a-z0-9_ -]{1,40}$/i.test(a))
    : [];
  return {
    configured: true,
    reachable: true,
    ok: j.ok,
    chainId: num(j.chainId),
    chainMatches: num(j.chainId) === expected.chainId,
    routerMatches: expected.router === null ? true : addr(j.router) === expected.router.toLowerCase(),
    killSwitch: flag(j.killSwitch),
    lowBalance: flag(j.lowBalance),
    draining: flag(j.draining),
    storeHealthy: store.healthy === undefined ? true : flag(store.healthy),
    queued: num(j.queued) ?? 0,
    inFlight: num(flight.count) ?? 0,
    oldestInFlightAgeSeconds: num(flight.oldestAgeSeconds) ?? 0,
    relayerBalanceWei: digits(j.relayerBalanceWei),
    alerts,
    lastSettled: last && at !== undefined ? { blockNumber: num(last.blockNumber) ?? null, at, ageSeconds: Math.max(0, nowSeconds - at) } : null,
  };
}

/** What is wrong, from the readings, most serious first. */
export function judge(s: Pick<ServiceStatus, "facilitator" | "tools" | "rpc">): { overall: Overall; problems: string[] } {
  const problems: string[] = [];
  let down = false;
  const f = s.facilitator;
  const t = s.tools;
  if (!f.configured && !t.configured) return { overall: "not_configured", problems: ["No facilitator and no tool server are configured on this site, so there is nothing to check."] };
  if (s.rpc.healthy === 0) {
    down = true;
    problems.push("No QIE endpoint answered with the right chain id, so nothing can be read or settled.");
  }
  if (f.configured) {
    if (!f.reachable) {
      down = true;
      problems.push(`The facilitator is not answering. ${f.reason}`);
    } else {
      if (!f.ok) problems.push("The facilitator reports itself unwell: it is shutting down or cannot record what it is told.");
      if (!f.chainMatches) problems.push("The facilitator is on a different chain than this site.");
      if (!f.routerMatches) problems.push("The facilitator settles through a different router than this site.");
      if (f.killSwitch) problems.push("The kill switch is on: payments and top-ups are paused. Reading still works.");
      if (f.lowBalance) problems.push("The relayer's QIE balance is low. Settlements stop when it runs out.");
      if (!f.storeHealthy) problems.push("The facilitator's journal is not healthy.");
      if (f.oldestInFlightAgeSeconds > 600) problems.push("A batch has been waiting on the chain for more than ten minutes.");
      if (f.alerts.length > 0) problems.push(`The facilitator has ${f.alerts.length} open alert${f.alerts.length === 1 ? "" : "s"}.`);
    }
  }
  if (t.configured) {
    if (!t.reachable) {
      down = true;
      problems.push(`The tool server is not answering. ${t.reason}`);
    } else {
      if (!t.chainMatches) problems.push("The tool server is on a different chain than this site.");
      if (!t.routerMatches) problems.push("The tool server settles through a different router than this site.");
    }
  }
  return { overall: down ? "down" : problems.length > 0 ? "degraded" : "operational", problems };
}

export type StatusDeps = {
  fetchImpl?: FetchLike;
  /** For the RPC probe, which posts. */
  probeFetch?: typeof fetch;
  now?: () => number;
};

/** The addresses to probe: QIE's five for a QIE network, or the one the site is set to (a local node, or a named endpoint). */
export function probeTargets(config: Pick<AppConfig, "chainId" | "rpcUrl" | "network">): string[] {
  const network = config.chainId === 1990 ? "mainnet" : config.chainId === 1983 ? "testnet" : undefined;
  const named = !network || isLocalUrl(config.rpcUrl) || !QIE_ENDPOINTS[network].includes(config.rpcUrl);
  return named || !network ? [config.rpcUrl] : [...QIE_ENDPOINTS[network]];
}

/** Reads everything once. Never throws: a service that cannot be read is a finding, not an error. */
export async function readServiceStatus(config: AppConfig, deps: StatusDeps = {}): Promise<ServiceStatus> {
  const now = deps.now ?? Date.now;
  const nowSeconds = Math.floor(now() / 1000);
  const [facilitator, tools, probes] = await Promise.all([
    (async (): Promise<FacilitatorStatus> => {
      if (!config.facilitatorUrl) return { configured: false };
      const got = await fetchJson(`${config.facilitatorUrl}/health`, deps.fetchImpl);
      if (!got.ok) return { configured: true, reachable: false, reason: got.reason };
      return readFacilitatorHealth(got.json, { chainId: config.chainId, router: config.router }, nowSeconds);
    })(),
    (async (): Promise<ToolsStatus> => {
      if (!config.toolsUrl) return { configured: false };
      const got = await fetchJson(`${config.toolsUrl}/health`, deps.fetchImpl);
      if (!got.ok) return { configured: true, reachable: false, reason: got.reason };
      const info = parseToolServerHealth(got.json);
      if (!info) return { configured: true, reachable: false, reason: "It answered, but not like a Sluice tool server." };
      return { configured: true, reachable: true, chainMatches: info.chainId === config.chainId, routerMatches: config.router === null || info.router.toLowerCase() === config.router.toLowerCase(), tools: info.tools };
    })(),
    probeEndpoints(probeTargets(config), config.chainId, { fetchImpl: deps.probeFetch, timeoutMs: 5_000 }),
  ]);
  const rpc = { endpoints: probes.map((p) => ({ host: new URL(p.url).host, ok: p.ok, ms: p.ms, ...(p.reason ? { reason: p.reason } : {}) })), healthy: probes.filter((p) => p.ok).length };
  const verdict = judge({ facilitator, tools, rpc });
  return { checkedAt: now(), chainId: config.chainId, network: config.network.label, realFunds: config.network.realFunds, overall: verdict.overall, problems: verdict.problems, facilitator, tools, rpc };
}

/** A reader that keeps its answer for `ttlMs`, so many visitors cost the services one set of requests. Concurrent readers share one read. */
export function cachedStatusReader(read: () => Promise<ServiceStatus>, ttlMs = 10_000, now: () => number = Date.now): () => Promise<ServiceStatus> {
  let held: { at: number; value: ServiceStatus } | undefined;
  let inFlight: Promise<ServiceStatus> | undefined;
  return async () => {
    if (held && now() - held.at < ttlMs) return held.value;
    inFlight ??= read()
      .then((value) => {
        held = { at: now(), value };
        return value;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
}

export type StatusHandlerOptions = {
  read: () => Promise<ServiceStatus>;
  perCaller?: RateLimiter;
  global?: RateLimiter;
};

const json = (status: number, body: unknown, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });

/** The JSON route: GET only, a limit per caller and one for the whole server, no secret in any answer. */
export function makeStatusHandler(options: StatusHandlerOptions): (request: Request) => Promise<Response> {
  const perCaller = options.perCaller ?? new RateLimiter({ limit: 30, windowMs: 60_000 });
  const global = options.global ?? new RateLimiter({ limit: 600, windowMs: 60_000, maxKeys: 1 });
  return async (request) => {
    if (request.method !== "GET") return json(405, { ok: false, error: "method_not_allowed" }, { allow: "GET" });
    // A caller over its own allowance is refused before the server's is touched, so one caller that keeps asking cannot use up what the
    // others are allowed.
    const caller = perCaller.take(callerKey(request.headers));
    if (!caller.ok) return json(429, { ok: false, error: "rate_limited", retryAfterSeconds: caller.retryAfterSeconds }, { "retry-after": String(caller.retryAfterSeconds) });
    const all = global.take("all");
    if (!all.ok) return json(429, { ok: false, error: "rate_limited", retryAfterSeconds: all.retryAfterSeconds }, { "retry-after": String(all.retryAfterSeconds) });
    try {
      return json(200, { ok: true, status: await options.read() });
    } catch {
      return json(502, { ok: false, error: "status_unavailable" });
    }
  };
}

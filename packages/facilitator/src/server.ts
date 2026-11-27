// The HTTP face of the facilitator. Plain node:http, no framework.
//
//   POST /verify     x402 facilitator interface: {x402Version, paymentPayload, paymentRequirements}
//   POST /settle     the same body; queues the payment and returns its id
//   GET  /status/:id where an intent is: queued, submitted, settled, skipped, expired or failed
//   POST /onboard    the zero-QIE start (two pre-signed transactions)
//   POST /relay      a relayed withdrawal or refund, with a relayer fee of zero
//   GET  /health     the relayer's address, balance, budget, flags and alerts. Never the key. HTTP 503 when `ok` is false.
//
// A facilitator that runs as short-lived copies has no timer, so it also has, when a secret is given:
//   GET or POST /internal/drain   settles what is queued, for a caller that sends the secret as a bearer token
// and, when it is asked to offer them, for a tool server that answers only for a settled payment:
//   POST /hold      the same body as /settle; records the payment without sending it, and answers with the token that releases it
//   POST /capture   {id, token}; releases a held payment and waits for the chain: success only once it settled
//
// Limits, all in code and all configurable downwards or upwards within the bounds below:
//   - a request body larger than `maxBodyBytes` (64 KiB by default, 1 MiB at most) is refused;
//   - a client address may make `ipLimit` requests per window, and a payer address `payerLimit` POSTs per window; past that the
//     answer is HTTP 429 with Retry-After. A limiter that cannot be asked refuses the request;
//   - a request that takes too long to send its headers or its body is cut off.
//
// A browser page (the Sluice web app) can call these endpoints only if the facilitator names the page's origin: see CorsOptions. By
// default no origin is allowed, so a facilitator that never set the list answers browsers exactly as before.
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { ERRORS } from "@sluice/sdk";
import { silentLogger } from "@sluice/sdk";
import type { Limiter, Logger } from "@sluice/sdk";
import { BodyNotJson, BodyTooLarge, RateLimiter, RequestCounter, bearerMatches, clientAddress, readJsonBody, renderGauges, requestIdFor, routeLabel } from "@sluice/sdk";
import type { Facilitator, SweepReport } from "./service";

export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
export const HARD_MAX_BODY_BYTES = 1024 * 1024;

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...extra });
  res.end(text);
}

export type CorsOptions = {
  /** Exact origins (scheme, host and port, no path) that may call the facilitator from a browser. Never a wildcard. */
  origins?: readonly string[];
};

export type RateLimit = { max: number; windowMs: number };

export type DrainOptions = {
  /** The bearer tokens that may ask for a drain. None of them is ever printed. */
  secrets: () => readonly string[];
  run: () => Promise<SweepReport>;
};

export type ServerOptions = CorsOptions & {
  /** The largest request body, in bytes. Default 64 KiB; a larger value is refused, above 1 MiB. */
  maxBodyBytes?: number;
  /** Requests of any kind one client address may make in a window. Default 240 a minute. */
  ipLimit?: RateLimit;
  /** POSTs that name one payer address, in a window. Default 60 a minute. */
  payerLimit?: RateLimit;
  /** Limiters to use instead of ones in memory: those that every copy of the service shares. */
  limiters?: { ip: Limiter; payer: Limiter };
  /** How many proxies in front of this service append to X-Forwarded-For. Default 0: the header is not believed. */
  trustedProxyHops?: number;
  /** The bearer token for GET /internal/metrics. With none, that path does not exist (it answers 404 like any unknown path). */
  metricsToken?: string;
  /** The drain endpoint. With none, that path does not exist. */
  drain?: DrainOptions;
  /** Told of each payment that /settle accepted and left queued, so that a copy with no timer can start settling it. */
  onQueued?: () => void;
  /** Offers /hold and /capture. With none, those paths do not exist. */
  holds?: { waitMs?: number; drainMs?: number; keep?: (work: Promise<unknown>) => void };
  logger?: Logger;
  /** The limiters' clock, in milliseconds. For tests. */
  now?: () => number;
};

export const DEFAULT_IP_LIMIT: RateLimit = { max: 240, windowMs: 60_000 };
export const DEFAULT_PAYER_LIMIT: RateLimit = { max: 60, windowMs: 60_000 };

/**
 * The headers that let one named origin read the answer. An origin not on the list gets none, and the browser blocks the page from
 * reading the response. CORS limits what a web page may read; it is not authentication, and the endpoints are as open to other
 * programs as they were.
 */
export function corsHeaders(origin: string | undefined, options: CorsOptions): Record<string, string> {
  if (!origin || !options.origins?.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-expose-headers": "x-request-id, retry-after",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

export const METRICS_PATH = "/internal/metrics";
export const DRAIN_PATH = "/internal/drain";
const KNOWN_ROUTES = ["/health", "/status", "/verify", "/settle", "/hold", "/capture", "/onboard", "/relay", METRICS_PATH, DRAIN_PATH] as const;

type FacilitatorMetrics = Awaited<ReturnType<Facilitator["metrics"]>>;

/** The metrics as text, one gauge or counter per line. Counts, ages and the relayer's own balance: no payer, amount or key. */
export function renderFacilitatorMetrics(m: FacilitatorMetrics, counter: RequestCounter): string {
  const gauges = [
    ...(Object.entries(m.intents) as Array<[string, number]>).map(([status, value]) => ({ name: "sluice_facilitator_intents", labels: { status }, value, help: "Intents in each state, from the journal." })),
    { name: "sluice_facilitator_oldest_queued_age_seconds", value: m.oldestQueuedAgeSeconds, help: "Age of the oldest intent still waiting for a batch." },
    { name: "sluice_facilitator_in_flight", value: m.inFlight, help: "Intents in a batch whose outcome is not yet recorded." },
    { name: "sluice_facilitator_oldest_in_flight_age_seconds", value: m.oldestInFlightAgeSeconds },
    { name: "sluice_facilitator_kill_switch", value: m.killSwitch, help: "1 while the kill switch is on." },
    { name: "sluice_facilitator_low_balance", value: m.lowBalance, help: "1 while the relayer holds less QIE than its low-balance threshold." },
    { name: "sluice_facilitator_draining", value: m.draining },
    { name: "sluice_facilitator_store_healthy", value: m.storeHealthy, help: "1 while the journal can record what it is told." },
    { name: "sluice_facilitator_relayer_balance_wei", value: BigInt(m.relayerBalanceWei) },
    { name: "sluice_facilitator_budget_wei", value: BigInt(m.budgetWei), help: "The relayer's QIE budget for the day." },
    { name: "sluice_facilitator_spent_wei", value: BigInt(m.spentWei) },
    { name: "sluice_facilitator_alerts", value: m.alerts },
    { name: "sluice_facilitator_last_settled_block", value: m.lastSettledBlock },
    { name: "sluice_facilitator_last_settled_timestamp_seconds", value: m.lastSettledAt },
  ];
  return `${[...counter.lines("sluice_facilitator_requests_total"), ...renderGauges(gauges)].join("\n")}\n`;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The payer address a POST names, if it names a well-formed one: that is what the per-payer limit is counted against. */
export function payerOf(path: string, body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const b = body as Record<string, unknown>;
  let candidate: unknown;
  if (path === "/verify" || path === "/settle" || path === "/hold") {
    const payload = b.paymentPayload as { payload?: { authorization?: { payer?: unknown } } } | undefined;
    candidate = payload?.payload?.authorization?.payer;
  } else if (path === "/onboard") {
    candidate = b.payer;
  } else {
    candidate = b.payer ?? b.account;
  }
  return typeof candidate === "string" && ADDRESS.test(candidate) ? candidate.toLowerCase() : undefined;
}

/** The facilitator's requests, as a listener that a node server or a serverless function can call. */
export function createListener(facilitator: Facilitator, options: ServerOptions = {}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const log = options.logger ?? silentLogger;
  const maxBody = Math.min(options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES, HARD_MAX_BODY_BYTES);
  if (!Number.isInteger(maxBody) || maxBody <= 0) throw new Error("maxBodyBytes must be a positive whole number");
  const ip = options.ipLimit ?? DEFAULT_IP_LIMIT;
  const pay = options.payerLimit ?? DEFAULT_PAYER_LIMIT;
  const ipLimiter = options.limiters?.ip ?? new RateLimiter(ip.max, ip.windowMs, 10_000, options.now);
  const payerLimiter = options.limiters?.payer ?? new RateLimiter(pay.max, pay.windowMs, 10_000, options.now);
  const hops = options.trustedProxyHops ?? 0;
  const counter = new RequestCounter();

  return async (req, res) => {
    // Every request has an id, which the caller may supply (if it is well formed) and which comes back in x-request-id and in the log
    // line, so a report from a user ("this request, at this time") finds its line.
    const started = Date.now();
    const requestId = requestIdFor(req.headers["x-request-id"]);
    res.setHeader("x-request-id", requestId);
    const route = routeLabel((req.url ?? "/").split("?")[0] ?? "/", KNOWN_ROUTES);
    res.once("finish", () => {
      counter.record(route, res.statusCode);
      log.info("request", { requestId, method: req.method, route, status: res.statusCode, ms: Date.now() - started });
    });
    const allow = corsHeaders(typeof req.headers.origin === "string" ? req.headers.origin : undefined, options);
    const send_ = (status: number, body: unknown, extra: Record<string, string> = {}) => send(res, status, body, { ...allow, ...extra });
    const limited = (who: "address" | "payer", retryAfterSeconds: number, where: string, key: string) => {
      log.warn("rate limited", { who, where, key: who === "payer" ? key : undefined, client: who === "address" ? key : undefined });
      return send_(429, { error: ERRORS.rateLimited, detail: `too many requests; try again in ${retryAfterSeconds} seconds` }, { "retry-after": String(retryAfterSeconds) });
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const client = clientAddress(req.socket.remoteAddress, req.headers["x-forwarded-for"], hops);
      let byIp;
      try {
        byIp = await ipLimiter.hit(client);
      } catch {
        log.error("the rate limit could not be counted, so the request is refused", { route });
        return send_(503, { error: ERRORS.storeUnavailable, detail: "the facilitator cannot count requests, so it serves none" });
      }
      if (!byIp.ok) return limited("address", byIp.retryAfterSeconds, path, client);

      // The private metrics path. It does not exist unless a token is set, it needs that token, and it never carries a CORS header, so
      // no web page can read it.
      if (path === METRICS_PATH) {
        if (!options.metricsToken) return send(res, 404, { error: "not_found" });
        if (req.method !== "GET") return send(res, 405, { error: "method_not_allowed" }, { allow: "GET" });
        if (!bearerMatches(req.headers.authorization, options.metricsToken)) return send(res, 401, { error: "unauthorized" }, { "www-authenticate": 'Bearer realm="sluice-metrics"' });
        const text = renderFacilitatorMetrics(await facilitator.metrics(), counter);
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" });
        return void res.end(text);
      }
      // The drain endpoint: the same rules, and it never carries a CORS header. A scheduler asks with GET or POST.
      if (path === DRAIN_PATH) {
        const secrets = options.drain?.secrets() ?? [];
        if (!options.drain || secrets.length === 0) return send(res, 404, { error: "not_found" });
        if (req.method !== "GET" && req.method !== "POST") return send(res, 405, { error: "method_not_allowed" }, { allow: "GET, POST" });
        // Every secret is compared, each in constant time.
        const matched = secrets.map((secret) => bearerMatches(req.headers.authorization, secret)).includes(true);
        if (!matched) {
          log.warn("drain refused", { reason: "unauthorized", requestId });
          return send(res, 401, { error: "unauthorized" }, { "www-authenticate": 'Bearer realm="sluice-drain"' });
        }
        req.resume();
        const report = await options.drain.run();
        return send(res, 200, report);
      }
      if (req.method === "OPTIONS") {
        if (Object.keys(allow).length === 0) return send(res, 404, { error: "not_found" });
        res.writeHead(204, { ...allow, "cache-control": "no-store" });
        return void res.end();
      }
      if (req.method === "GET" && path === "/health") {
        const health = await facilitator.health();
        return send_(health.ok ? 200 : 503, health);
      }
      if (req.method === "GET" && path.startsWith("/status/")) {
        const status = await facilitator.status(decodeURIComponent(path.slice("/status/".length)));
        return status ? send_(200, status) : send_(404, { error: "sluice_not_found" });
      }
      const posted = ["/verify", "/settle", "/onboard", "/relay", ...(options.holds ? ["/hold", "/capture"] : [])];
      if (req.method === "POST" && posted.includes(path)) {
        // A declared length over the limit is refused before a byte of it is read.
        const declared = Number(req.headers["content-length"]);
        if (Number.isFinite(declared) && declared > maxBody) {
          req.resume();
          return send_(400, { error: "invalid_payload", detail: "the body is too large" }, { connection: "close" });
        }
        let body: unknown;
        try {
          body = await readJsonBody(req, maxBody);
        } catch (err) {
          return send_(400, { error: "invalid_payload", detail: err instanceof BodyTooLarge || err instanceof BodyNotJson ? err.message : "bad request" });
        }
        const payer = payerOf(path, body);
        if (payer) {
          let byPayer;
          try {
            byPayer = await payerLimiter.hit(payer);
          } catch {
            log.error("the rate limit could not be counted, so the request is refused", { route });
            return send_(503, { error: ERRORS.storeUnavailable, detail: "the facilitator cannot count requests, so it serves none" });
          }
          if (!byPayer.ok) return limited("payer", byPayer.retryAfterSeconds, path, payer);
        }
        if (path === "/verify") return send_(200, await facilitator.verify(body));
        if (path === "/settle") {
          const settled = await facilitator.settle(body);
          if (settled.success && settled.extensions?.sluice?.status === "queued") options.onQueued?.();
          return send_(200, settled);
        }
        if (path === "/hold") return send_(200, await facilitator.hold(body));
        if (path === "/capture") return send_(200, await facilitator.capture(body, options.holds));
        if (path === "/onboard") return send_(200, await facilitator.onboard(body));
        return send_(200, await facilitator.relay(body));
      }
      return send_(404, { error: "not_found" });
    } catch {
      // Never put an exception's text, which could hold a URL or a key fragment, in a response or a log line.
      log.error("unexpected error while serving a request");
      return send_(500, { error: "unexpected_error" });
    }
  };
}

export function createServer(facilitator: Facilitator, options: ServerOptions = {}): Server {
  const listener = createListener(facilitator, options);
  const server = createHttpServer((req, res) => void listener(req, res));
  // A client that dribbles its request in is cut off instead of holding a connection open for ever.
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  return server;
}

/** Listens on 127.0.0.1 unless told otherwise, and resolves with the port in use. */
export function listen(server: Server, port: number, host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    });
  });
}

// The HTTP face of the facilitator. Plain node:http, no framework.
//
//   POST /verify     x402 facilitator interface: {x402Version, paymentPayload, paymentRequirements}
//   POST /settle     the same body; queues the payment and returns its id
//   GET  /status/:id where an intent is: queued, submitted, settled, skipped, expired or failed
//   POST /onboard    the zero-QIE start (two pre-signed transactions)
//   POST /relay      a relayed withdrawal or refund, with a relayer fee of zero
//   GET  /health     the relayer's address, balance, budget, flags and alerts. Never the key. HTTP 503 when `ok` is false.
//
// Limits, all in code and all configurable downwards or upwards within the bounds below:
//   - a request body larger than `maxBodyBytes` (64 KiB by default, 1 MiB at most) is refused;
//   - a client address may make `ipLimit` requests per window, and a payer address `payerLimit` POSTs per window; past that the
//     answer is HTTP 429 with Retry-After;
//   - a request that takes too long to send its headers or its body is cut off.
//
// A browser page (the Sluice web app) can call these endpoints only if the facilitator names the page's origin: see CorsOptions. By
// default no origin is allowed, so a facilitator that never set the list answers browsers exactly as before.
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { ERRORS } from "@sluice/sdk";
import { silentLogger } from "@sluice/sdk";
import type { Logger } from "@sluice/sdk";
import { RateLimiter, clientAddress } from "@sluice/sdk";
import type { Facilitator } from "./service";

export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
export const HARD_MAX_BODY_BYTES = 1024 * 1024;

class BodyError extends Error {}

function readBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new BodyError("the body is too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new BodyError("the body is not JSON"));
      }
    });
    req.on("error", () => reject(new BodyError("the request failed")));
  });
}

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

export type ServerOptions = CorsOptions & {
  /** The largest request body, in bytes. Default 64 KiB; a larger value is refused, above 1 MiB. */
  maxBodyBytes?: number;
  /** Requests of any kind one client address may make in a window. Default 240 a minute. */
  ipLimit?: RateLimit;
  /** POSTs that name one payer address, in a window. Default 60 a minute. */
  payerLimit?: RateLimit;
  /** How many proxies in front of this service append to X-Forwarded-For. Default 0: the header is not believed. */
  trustedProxyHops?: number;
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
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The payer address a POST names, if it names a well-formed one: that is what the per-payer limit is counted against. */
export function payerOf(path: string, body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const b = body as Record<string, unknown>;
  let candidate: unknown;
  if (path === "/verify" || path === "/settle") {
    const payload = b.paymentPayload as { payload?: { authorization?: { payer?: unknown } } } | undefined;
    candidate = payload?.payload?.authorization?.payer;
  } else if (path === "/onboard") {
    candidate = b.payer;
  } else {
    candidate = b.payer ?? b.account;
  }
  return typeof candidate === "string" && ADDRESS.test(candidate) ? candidate.toLowerCase() : undefined;
}

export function createServer(facilitator: Facilitator, options: ServerOptions = {}): Server {
  const log = options.logger ?? silentLogger;
  const maxBody = Math.min(options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES, HARD_MAX_BODY_BYTES);
  if (!Number.isInteger(maxBody) || maxBody <= 0) throw new Error("maxBodyBytes must be a positive whole number");
  const ip = options.ipLimit ?? DEFAULT_IP_LIMIT;
  const pay = options.payerLimit ?? DEFAULT_PAYER_LIMIT;
  const ipLimiter = new RateLimiter(ip.max, ip.windowMs, 10_000, options.now);
  const payerLimiter = new RateLimiter(pay.max, pay.windowMs, 10_000, options.now);
  const hops = options.trustedProxyHops ?? 0;

  const server = createHttpServer((req, res) => {
    void (async () => {
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
        const byIp = ipLimiter.hit(client);
        if (!byIp.ok) return limited("address", byIp.retryAfterSeconds, path, client);

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
          const status = facilitator.status(decodeURIComponent(path.slice("/status/".length)));
          return status ? send_(200, status) : send_(404, { error: "sluice_not_found" });
        }
        if (req.method === "POST" && ["/verify", "/settle", "/onboard", "/relay"].includes(path)) {
          // A declared length over the limit is refused before a byte of it is read.
          const declared = Number(req.headers["content-length"]);
          if (Number.isFinite(declared) && declared > maxBody) {
            req.resume();
            return send_(400, { error: "invalid_payload", detail: "the body is too large" }, { connection: "close" });
          }
          let body: unknown;
          try {
            body = await readBody(req, maxBody);
          } catch (err) {
            return send_(400, { error: "invalid_payload", detail: err instanceof BodyError ? err.message : "bad request" });
          }
          const payer = payerOf(path, body);
          if (payer) {
            const byPayer = payerLimiter.hit(payer);
            if (!byPayer.ok) return limited("payer", byPayer.retryAfterSeconds, path, payer);
          }
          if (path === "/verify") return send_(200, await facilitator.verify(body));
          if (path === "/settle") return send_(200, await facilitator.settle(body));
          if (path === "/onboard") return send_(200, await facilitator.onboard(body));
          return send_(200, await facilitator.relay(body));
        }
        return send_(404, { error: "not_found" });
      } catch {
        // Never put an exception's text, which could hold a URL or a key fragment, in a response or a log line.
        log.error("unexpected error while serving a request");
        return send_(500, { error: "unexpected_error" });
      }
    })();
  });
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

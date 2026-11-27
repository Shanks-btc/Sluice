// Hosting the example paid tools on the internet: the settings it reads, when it refuses to start, and an HTTP server with limits.
//
// What the host adds to the plain `mcpRequestListener`:
//   - the settings come from the environment, and the network must be named: there is no default, so a tool server never
//     starts on mainnet by accident. On mainnet it also needs a configured router, and the router must hold QUSDC;
//   - one request body is read, size-limited and parsed before anything runs, which is how an unpaid call is told from a paid one;
//   - an address may make a limited number of requests a minute, and a smaller number of unpaid ones (a call with no payment is
//     answered with a price, which costs the server work and earns it nothing, so it is the request to ration);
//   - reads from the node and the explorer have time limits, and so has the whole request;
//   - logs are JSON lines with the keys, signatures and request bodies left out.
//
// The server holds no key. It verifies and settles through a facilitator, and it only reads from the chain.
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { Contract, Network, getAddress } from "ethers";
import {
  BodyTooLarge,
  FacilitatorClient,
  PAYMENT_META_KEY,
  QUSDC_ADDRESS,
  RateLimiter,
  readJsonBody,
  RequestCounter,
  FailoverJsonRpcProvider,
  NoHealthyEndpoint,
  bearerMatches,
  clientAddress,
  describeSelection,
  orderedUrls,
  requireNodeChain,
  resolveEndpoint,
  createLogger,
  createPaywall,
  mcpRequestListener,
  parseQusdc,
  renderGauges,
  requestIdFor,
  routeLabel,
  silentLogger,
} from "@sluice/sdk";
import type { IdempotencyStore, Limiter, Logger, LogLevel } from "@sluice/sdk";
import { PUBLIC_EXPLORER, explorerClient, rpcFromProvider, withTimeout } from "./rpc";
import type { ExplorerGet, Rpc } from "./rpc";
import { DEFAULT_PRICES, paidToolsFactory } from "./server";
import type { ToolName } from "./server";

export class ToolServerEnvError extends Error {}

export type Env = Record<string, string | undefined>;

export type ToolServerEnv = {
  network: "mainnet" | "testnet" | "local";
  chainId: number;
  router: string;
  facilitatorUrl: string;
  payee: string;
  rpcUrl: string;
  /** True when SLUICE_RPC_URL names the endpoint (or the node is local): it is used as given. False: QIE's public endpoints are probed and the first healthy one is used. */
  rpcNamed: boolean;
  /** The explorer the tools read, or undefined for none. Only mainnet has a default: no testnet explorer is known, and a mainnet explorer must not answer for testnet addresses. */
  explorerUrl?: string;
  /** The price of each tool, as the builder set it. */
  prices: Record<ToolName, string>;
  host: string;
  port: number;
  maxBodyBytes: number;
  /** Requests a minute from one address, of any kind. */
  ipPerMinute: number;
  /** Requests a minute from one address that carry no payment. */
  unpaidPerMinute: number;
  trustedProxyHops: number;
  rpcTimeoutMs: number;
  /** Browser origins that may call the server (SLUICE_TOOLS_CORS_ORIGINS). Empty: no page can read an answer. Exact origins, never a wildcard. */
  corsOrigins: string[];
  /** The bearer token for the private metrics path, as a function so that it is never printed. Undefined: the path does not exist. */
  metricsToken: () => string | undefined;
  logLevel: LogLevel;
};

/** Exact origins, separated by commas: https, or http on this machine, with no path and no wildcard. */
export function parseCorsOrigins(text: string | undefined): string[] {
  const out: string[] = [];
  for (const raw of (text ?? "").split(",")) {
    const o = raw.trim();
    if (!o) continue;
    let url: URL;
    try {
      url = new URL(o);
    } catch {
      throw new ToolServerEnvError("refusing to start: SLUICE_TOOLS_CORS_ORIGINS holds an origin that is not a URL");
    }
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (o.includes("*") || url.origin !== o || !(url.protocol === "https:" || (url.protocol === "http:" && local))) {
      throw new ToolServerEnvError("refusing to start: SLUICE_TOOLS_CORS_ORIGINS must list exact origins (https, or http on this machine), each with no path and no wildcard");
    }
    if (!out.includes(o)) out.push(o);
  }
  return out;
}

const RPC = { mainnet: "https://rpc1mainnet.qie.digital/", testnet: "https://rpc1testnet.qie.digital/" } as const;
const CHAIN = { mainnet: 1990, testnet: 1983, local: 1990 } as const;
const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/;
const HOST = /^(\d{1,3}(\.\d{1,3}){3}|localhost|[a-z0-9.-]+)$/i;

function whole(name: string, text: string | undefined, fallback: number, min: number, max: number): number {
  const raw = text?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) {
    throw new ToolServerEnvError(`refusing to start: ${name} must be a whole number from ${min} to ${max}`);
  }
  return n;
}

/** "token_risk_check=0.01,dex_quote=0.002" on top of the built-in prices. A name that is not a tool, or a price that is not QUSDC, stops the start. */
export function parsePrices(text: string | undefined): Record<ToolName, string> {
  const prices: Record<ToolName, string> = { ...DEFAULT_PRICES };
  for (const part of (text ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
    const [name, value, ...extra] = part.split("=").map((s) => s.trim());
    if (!name || !value || extra.length > 0 || !(name in DEFAULT_PRICES)) {
      throw new ToolServerEnvError(`refusing to start: SLUICE_TOOLS_PRICES entries look like ${Object.keys(DEFAULT_PRICES)[0]}=0.01, and the names are ${Object.keys(DEFAULT_PRICES).join(", ")}`);
    }
    try {
      if (parseQusdc(value) <= 0n) throw new Error("zero");
    } catch {
      throw new ToolServerEnvError(`refusing to start: the price of ${name} must be an amount of QUSDC above zero with at most six decimals`);
    }
    prices[name as ToolName] = value;
  }
  return prices;
}

export function readToolServerEnv(env: Env): ToolServerEnv {
  const network = env.SLUICE_NETWORK?.trim();
  if (network !== "mainnet" && network !== "testnet" && network !== "local") {
    throw new ToolServerEnvError("refusing to start: set SLUICE_NETWORK to mainnet, testnet or local; there is no default");
  }
  const router = env.SLUICE_ROUTER?.trim();
  if (!router || !/^0x[0-9a-fA-F]{40}$/.test(router)) {
    throw new ToolServerEnvError(`refusing to start on ${network}: SLUICE_ROUTER must be the router's address`);
  }
  const payee = env.SLUICE_PAYEE?.trim();
  if (!payee || !/^0x[0-9a-fA-F]{40}$/.test(payee)) throw new ToolServerEnvError("refusing to start: SLUICE_PAYEE must be the address that is paid");
  const facilitatorUrl = env.SLUICE_FACILITATOR_URL?.trim();
  if (!facilitatorUrl) throw new ToolServerEnvError("refusing to start: set SLUICE_FACILITATOR_URL");
  if (!facilitatorUrl.startsWith("https://") && !LOCAL.test(facilitatorUrl)) throw new ToolServerEnvError("refusing to start: SLUICE_FACILITATOR_URL must be https");
  const rpcUrl = (env.SLUICE_RPC_URL?.trim() || (network === "local" ? "" : RPC[network])).trim();
  if (!rpcUrl) throw new ToolServerEnvError("refusing to start: set SLUICE_RPC_URL for a local node");
  if (!rpcUrl.startsWith("https://") && !LOCAL.test(rpcUrl)) throw new ToolServerEnvError("refusing to start: SLUICE_RPC_URL must be https");
  if (network === "local" && !LOCAL.test(rpcUrl)) throw new ToolServerEnvError("refusing to start: a local run needs an http://127.0.0.1 RPC");
  const explorerUrl = env.SLUICE_EXPLORER_URL?.trim() || (network === "mainnet" ? PUBLIC_EXPLORER : undefined);
  if (explorerUrl && !explorerUrl.startsWith("https://") && !LOCAL.test(explorerUrl)) throw new ToolServerEnvError("refusing to start: SLUICE_EXPLORER_URL must be https");
  const host = env.SLUICE_TOOLS_HOST?.trim() || "127.0.0.1";
  if (!HOST.test(host)) throw new ToolServerEnvError("refusing to start: SLUICE_TOOLS_HOST is not an address");
  const level = env.SLUICE_TOOLS_LOG_LEVEL?.trim() || "info";
  if (level !== "debug" && level !== "info" && level !== "warn" && level !== "error") {
    throw new ToolServerEnvError("refusing to start: SLUICE_TOOLS_LOG_LEVEL must be debug, info, warn or error");
  }
  const ipPerMinute = whole("SLUICE_TOOLS_RATE_LIMIT_IP", env.SLUICE_TOOLS_RATE_LIMIT_IP, 300, 1, 100_000);
  const unpaidPerMinute = whole("SLUICE_TOOLS_RATE_LIMIT_UNPAID", env.SLUICE_TOOLS_RATE_LIMIT_UNPAID, 60, 1, 100_000);
  if (unpaidPerMinute > ipPerMinute) throw new ToolServerEnvError("refusing to start: SLUICE_TOOLS_RATE_LIMIT_UNPAID is above SLUICE_TOOLS_RATE_LIMIT_IP, so it could never apply");
  const metrics = env.SLUICE_TOOLS_METRICS_TOKEN?.trim() || undefined;
  if (metrics !== undefined && !/^[A-Za-z0-9._~+/=-]{24,200}$/.test(metrics)) {
    throw new ToolServerEnvError("refusing to start: SLUICE_TOOLS_METRICS_TOKEN must be 24 to 200 characters of letters, digits and . _ ~ + / = -");
  }
  const out: ToolServerEnv = {
    network,
    chainId: CHAIN[network],
    router: getAddress(router),
    facilitatorUrl: facilitatorUrl.replace(/\/+$/, ""),
    payee: getAddress(payee),
    rpcUrl,
    rpcNamed: Boolean(env.SLUICE_RPC_URL?.trim()) || network === "local",
    explorerUrl,
    prices: parsePrices(env.SLUICE_TOOLS_PRICES),
    host,
    port: whole("SLUICE_TOOLS_PORT", env.SLUICE_TOOLS_PORT, 8403, 0, 65535),
    maxBodyBytes: whole("SLUICE_TOOLS_MAX_BODY_BYTES", env.SLUICE_TOOLS_MAX_BODY_BYTES, 32 * 1024, 1024, 1024 * 1024),
    ipPerMinute,
    unpaidPerMinute,
    trustedProxyHops: whole("SLUICE_TOOLS_TRUST_PROXY_HOPS", env.SLUICE_TOOLS_TRUST_PROXY_HOPS, 0, 0, 5),
    rpcTimeoutMs: whole("SLUICE_TOOLS_RPC_TIMEOUT_MS", env.SLUICE_TOOLS_RPC_TIMEOUT_MS, 10_000, 500, 60_000),
    corsOrigins: parseCorsOrigins(env.SLUICE_TOOLS_CORS_ORIGINS),
    metricsToken: () => metrics,
    logLevel: level,
  };
  Object.defineProperty(out, "metricsToken", { enumerable: false, value: out.metricsToken });
  return out;
}

// ------------------------------------------------------------------------------------------------ telling paid from unpaid

type RpcMessage = { method?: unknown; params?: { name?: unknown; _meta?: Record<string, unknown> } };

const messagesOf = (body: unknown): RpcMessage[] => (Array.isArray(body) ? (body as RpcMessage[]) : [body as RpcMessage]);

/** True when the request is a tools/call that carries a payment. Anything else, including a call with no payment, is unpaid. */
export function carriesPayment(body: unknown): boolean {
  return messagesOf(body).some(
    (m) => typeof m === "object" && m !== null && m.method === "tools/call" && typeof m.params?._meta?.[PAYMENT_META_KEY] === "object" && m.params._meta[PAYMENT_META_KEY] !== null,
  );
}

/** What the request is, for the log: the MCP method and the tool name, never the arguments or the payment. */
export function describeRequest(body: unknown): { method: string; tool?: string } {
  const first = messagesOf(body)[0];
  const method = typeof first?.method === "string" ? first.method.slice(0, 40) : "unknown";
  const tool = method === "tools/call" && typeof first?.params?.name === "string" ? first.params.name.slice(0, 60) : undefined;
  return tool ? { method, tool } : { method };
}

// -------------------------------------------------------------------------------------------------------------- the server

export type ToolServerOptions = {
  env: ToolServerEnv;
  logger?: Logger;
  /** For tests: a node and an explorer to use instead of the ones the settings name. */
  rpc?: Rpc;
  explorer?: ExplorerGet;
  /** The limiters' clock, in milliseconds. For tests. */
  now?: () => number;
  /** How long one whole request may take before it is answered with 504. */
  handlerTimeoutMs?: number;
  /** Limiters to use instead of ones in memory: those that every copy of the server shares. */
  limiters?: { ip: Limiter; unpaid: Limiter };
  /** Where what each payment was used for is kept. A server that runs as several copies must give one they share. */
  paywallStore?: IdempotencyStore;
  /** Hold each payment at the facilitator before the tool runs, and answer only once it has settled on chain. */
  answerOnlyWhenSettled?: boolean;
};

export type ToolApp = {
  /** The server's requests, as a listener that a node server or a serverless function can call. */
  listener: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  /** The QUSDC address the router holds, which payments are in. */
  asset: string;
  /** Lets go of the connection to the node. */
  destroy(): void;
};

export type ToolServer = {
  server: Server;
  /** Listens and resolves with the port in use. */
  listen(): Promise<number>;
  close(): Promise<void>;
  /** The QUSDC address the router holds, which payments are in. */
  asset: string;
};

export const METRICS_PATH = "/internal/metrics";
const KNOWN_ROUTES = ["/health", "/mcp", METRICS_PATH] as const;

const rpcError = (code: number, message: string) => JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null });

/** The tool server's requests and what they need, with no server around them. */
export async function createToolApp(options: ToolServerOptions): Promise<ToolApp> {
  const env = options.env;
  const log = options.logger ?? silentLogger;
  const network = Network.from(env.chainId);
  // The endpoint: one named by SLUICE_RPC_URL as given, otherwise the first of QIE's public endpoints that answers with this chain's id,
  // with the others as fallbacks for reads.
  let urls = [env.rpcUrl];
  if (!env.rpcNamed && (env.network === "mainnet" || env.network === "testnet")) {
    try {
      const sel = await resolveEndpoint(env.network, undefined);
      log.info("rpc endpoint chosen", { endpoint: describeSelection(sel) });
      urls = orderedUrls(sel);
    } catch (err) {
      throw new ToolServerEnvError(`refusing to start: ${err instanceof NoHealthyEndpoint ? err.message : "no RPC endpoint could be probed"}`);
    }
  }
  // Every request to the node has a time limit: ethers would otherwise wait up to five minutes, or for ever on a node that never answers.
  const provider = new FailoverJsonRpcProvider(urls, network, { staticNetwork: network }, env.rpcTimeoutMs);
  // A provider made with a fixed network never asks the node which chain it is on, so ask it here (a named SLUICE_RPC_URL is used as given).
  try {
    await requireNodeChain(provider, env.chainId, env.network);
  } catch (err) {
    provider.destroy();
    throw new ToolServerEnvError(`refusing to start: ${err instanceof Error ? err.message : "the RPC's chain could not be checked"}`);
  }
  const rpc = options.rpc ?? withTimeout(rpcFromProvider(provider), env.rpcTimeoutMs);
  // What the router holds is the asset payments are in. A router that cannot be read, or on mainnet one that holds anything but
  // QUSDC, stops the start: a tool server must not take a price in a token the builder did not mean.
  let asset: string;
  let vault: string;
  try {
    const router = new Contract(env.router, ["function token() view returns (address)", "function vault() view returns (address)"], provider);
    asset = getAddress((await router.getFunction("token")()) as string);
    vault = getAddress((await router.getFunction("vault")()) as string);
  } catch {
    provider.destroy();
    throw new ToolServerEnvError("refusing to start: the router could not be read at SLUICE_ROUTER on that network");
  }
  if (env.network === "mainnet" && asset !== getAddress(QUSDC_ADDRESS)) {
    provider.destroy();
    throw new ToolServerEnvError("refusing to start on mainnet: the router does not hold QUSDC");
  }

  const facilitator = new FacilitatorClient({ url: env.facilitatorUrl, timeoutMs: env.rpcTimeoutMs });
  const paywall = createPaywall({ facilitator, router: env.router, vault, asset, chainId: env.chainId, store: options.paywallStore, answerOnlyWhenSettled: options.answerOnlyWhenSettled });
  const build = paidToolsFactory({
    paywall,
    payee: env.payee,
    rpc,
    explorer: options.explorer ?? (env.explorerUrl ? explorerClient(env.explorerUrl, fetch, env.rpcTimeoutMs) : undefined),
    prices: env.prices,
  });
  const mcp = mcpRequestListener(build);
  const ipLimiter: Limiter = options.limiters?.ip ?? new RateLimiter(env.ipPerMinute, 60_000, 10_000, options.now);
  const unpaidLimiter: Limiter = options.limiters?.unpaid ?? new RateLimiter(env.unpaidPerMinute, 60_000, 10_000, options.now);
  const handlerTimeout = options.handlerTimeoutMs ?? 60_000;

  const reply = (res: ServerResponse, status: number, text: string, extra: Record<string, string> = {}) => {
    if (res.headersSent) return;
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...extra }).end(text);
  };

  const counter = new RequestCounter();
  const calls = { paid: 0, unpaid: 0, rateLimited: 0 };
  // The token is a function that is not an own enumerable property, so a settings object that was copied (spread) has lost it: that means no token, never an error.
  const metricsToken = typeof env.metricsToken === "function" ? env.metricsToken() : undefined;

  const listener = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const started = Date.now();
      // Every request has an id (the caller's, if well formed), which comes back in x-request-id and in the log line.
      const requestId = requestIdFor(req.headers["x-request-id"]);
      res.setHeader("x-request-id", requestId);
      /** Whether the limiter lets the call through. A limiter that cannot be asked refuses it: nothing is served uncounted. */
      const within = async (limiter: Limiter, client: string, kind: "any" | "unpaid", why: string): Promise<boolean> => {
        let answer;
        try {
          answer = await limiter.hit(client);
        } catch {
          log.error("the rate limit could not be counted, so the request is refused", { requestId, kind });
          reply(res, 503, rpcError(-32603, "the server cannot count requests, so it serves none; try again later"));
          return false;
        }
        if (answer.ok) return true;
        calls.rateLimited += 1;
        log.warn("rate limited", { requestId, client, kind });
        reply(res, 429, rpcError(-32029, `${why}; try again in ${answer.retryAfterSeconds} seconds`), { "retry-after": String(answer.retryAfterSeconds) });
        return false;
      };
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const route = routeLabel(url.pathname, KNOWN_ROUTES);
        res.once("finish", () => counter.record(route, res.statusCode));
        // The private metrics path: it does not exist unless a token is set, it needs that token, and it never carries a CORS header.
        if (url.pathname === METRICS_PATH) {
          if (!metricsToken) return reply(res, 404, JSON.stringify({ error: "not_found" }));
          if (req.method !== "GET") return reply(res, 405, JSON.stringify({ error: "method_not_allowed" }), { allow: "GET" });
          if (!bearerMatches(req.headers.authorization, metricsToken)) return reply(res, 401, JSON.stringify({ error: "unauthorized" }), { "www-authenticate": 'Bearer realm="sluice-metrics"' });
          const text = `${[
            ...counter.lines("sluice_tools_requests_total"),
            "# TYPE sluice_tools_calls_total counter",
            `sluice_tools_calls_total{kind="paid"} ${calls.paid}`,
            `sluice_tools_calls_total{kind="unpaid"} ${calls.unpaid}`,
            `sluice_tools_calls_total{kind="rate_limited"} ${calls.rateLimited}`,
            ...renderGauges([{ name: "sluice_tools_registered", value: Object.keys(env.prices).length, help: "Tools the server offers." }]),
          ].join("\n")}\n`;
          res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" });
          return void res.end(text);
        }
        // A page on a listed origin may read the answers of /mcp and /health. Any other origin gets no header, so its page cannot read them.
        const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
        const allowed = origin !== undefined && env.corsOrigins.includes(origin);
        if (allowed) {
          res.setHeader("access-control-allow-origin", origin);
          res.setHeader("access-control-expose-headers", "x-request-id, retry-after");
          res.setHeader("vary", "Origin");
        }
        if (req.method === "OPTIONS") {
          if (!allowed || (url.pathname !== "/mcp" && url.pathname !== "/health")) return reply(res, 404, JSON.stringify({ error: "not_found" }));
          res.writeHead(204, { "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type, accept, mcp-protocol-version, x-request-id", "access-control-max-age": "600", "cache-control": "no-store" });
          return void res.end();
        }
        if (req.method === "GET" && url.pathname === "/health") {
          return reply(res, 200, JSON.stringify({
            ok: true,
            service: "sluice-paid-tools",
            network: env.network,
            chainId: env.chainId,
            router: env.router,
            payee: env.payee,
            tools: Object.entries(env.prices).map(([name, price]) => ({ name, price })),
          }));
        }
        if (url.pathname !== "/mcp") return reply(res, 404, JSON.stringify({ error: "not_found" }));
        if (req.method !== "POST") return reply(res, 405, rpcError(-32000, "method not allowed"), { allow: "POST" });

        const client = clientAddress(req.socket.remoteAddress, req.headers["x-forwarded-for"], env.trustedProxyHops);
        if (!(await within(ipLimiter, client, "any", "too many requests"))) return;
        const declared = Number(req.headers["content-length"]);
        if (Number.isFinite(declared) && declared > env.maxBodyBytes) {
          req.resume();
          return reply(res, 413, rpcError(-32600, "the request is too large"), { connection: "close" });
        }
        let body: unknown;
        try {
          body = await readJsonBody(req, env.maxBodyBytes);
        } catch (err) {
          if (err instanceof BodyTooLarge) return reply(res, 413, rpcError(-32600, "the request is too large"), { connection: "close" });
          return reply(res, 400, rpcError(-32700, "the request is not JSON"));
        }
        if (typeof body !== "object" || body === null) return reply(res, 400, rpcError(-32600, "the request is not a JSON-RPC message"));
        const paid = carriesPayment(body);
        if (paid) calls.paid += 1;
        else calls.unpaid += 1;
        if (!paid && !(await within(unpaidLimiter, client, "unpaid", "too many requests without a payment"))) return;
        const what = describeRequest(body);
        res.once("finish", () => log.info("request", { requestId, ...what, paid, status: res.statusCode, ms: Date.now() - started }));
        let timer: NodeJS.Timeout | undefined;
        const late = new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            log.warn("a request took too long", { requestId, ...what });
            reply(res, 504, rpcError(-32603, "the request took too long"));
            resolve();
          }, handlerTimeout);
        });
        await Promise.race([mcp(req, res, body), late]);
        if (timer) clearTimeout(timer);
      } catch {
        // Never put an exception's text, which could hold a URL or a key fragment, in a response or a log line.
        log.error("unexpected error while serving a request");
        reply(res, 500, rpcError(-32603, "internal error"));
      }
  };

  return { listener, asset, destroy: () => provider.destroy() };
}

export async function createToolServer(options: ToolServerOptions): Promise<ToolServer> {
  const env = options.env;
  const app = await createToolApp(options);
  const server = createServer((req, res) => void app.listener(req, res));
  server.headersTimeout = 10_000;
  server.requestTimeout = 20_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;

  return {
    server,
    asset: app.asset,
    listen: () =>
      new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(env.port, env.host, () => {
          const address = server.address();
          resolve(typeof address === "object" && address ? address.port : env.port);
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          app.destroy();
          resolve();
        });
        server.closeIdleConnections();
        setTimeout(() => server.closeAllConnections(), 5_000).unref();
      }),
  };
}

/** Logger for the command-line program: JSON lines on standard error, since standard output belongs to MCP in stdio mode. */
export function toolServerLogger(env: Pick<ToolServerEnv, "logLevel">, secrets: readonly string[] = []): Logger {
  return createLogger({ write: (line) => void process.stderr.write(`${line}\n`), level: env.logLevel, secrets, base: { service: "sluice-paid-tools" } });
}

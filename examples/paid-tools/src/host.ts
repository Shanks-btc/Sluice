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
  FacilitatorClient,
  PAYMENT_META_KEY,
  QUSDC_ADDRESS,
  RateLimiter,
  TimedJsonRpcProvider,
  clientAddress,
  createLogger,
  createPaywall,
  mcpRequestListener,
  parseQusdc,
  silentLogger,
} from "@sluice/sdk";
import type { Logger, LogLevel } from "@sluice/sdk";
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
  explorerUrl: string;
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
  logLevel: LogLevel;
};

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
  const explorerUrl = env.SLUICE_EXPLORER_URL?.trim() || PUBLIC_EXPLORER;
  if (!explorerUrl.startsWith("https://") && !LOCAL.test(explorerUrl)) throw new ToolServerEnvError("refusing to start: SLUICE_EXPLORER_URL must be https");
  const host = env.SLUICE_TOOLS_HOST?.trim() || "127.0.0.1";
  if (!HOST.test(host)) throw new ToolServerEnvError("refusing to start: SLUICE_TOOLS_HOST is not an address");
  const level = env.SLUICE_TOOLS_LOG_LEVEL?.trim() || "info";
  if (level !== "debug" && level !== "info" && level !== "warn" && level !== "error") {
    throw new ToolServerEnvError("refusing to start: SLUICE_TOOLS_LOG_LEVEL must be debug, info, warn or error");
  }
  const ipPerMinute = whole("SLUICE_TOOLS_RATE_LIMIT_IP", env.SLUICE_TOOLS_RATE_LIMIT_IP, 300, 1, 100_000);
  const unpaidPerMinute = whole("SLUICE_TOOLS_RATE_LIMIT_UNPAID", env.SLUICE_TOOLS_RATE_LIMIT_UNPAID, 60, 1, 100_000);
  if (unpaidPerMinute > ipPerMinute) throw new ToolServerEnvError("refusing to start: SLUICE_TOOLS_RATE_LIMIT_UNPAID is above SLUICE_TOOLS_RATE_LIMIT_IP, so it could never apply");
  return {
    network,
    chainId: CHAIN[network],
    router: getAddress(router),
    facilitatorUrl: facilitatorUrl.replace(/\/+$/, ""),
    payee: getAddress(payee),
    rpcUrl,
    explorerUrl,
    prices: parsePrices(env.SLUICE_TOOLS_PRICES),
    host,
    port: whole("SLUICE_TOOLS_PORT", env.SLUICE_TOOLS_PORT, 8403, 0, 65535),
    maxBodyBytes: whole("SLUICE_TOOLS_MAX_BODY_BYTES", env.SLUICE_TOOLS_MAX_BODY_BYTES, 32 * 1024, 1024, 1024 * 1024),
    ipPerMinute,
    unpaidPerMinute,
    trustedProxyHops: whole("SLUICE_TOOLS_TRUST_PROXY_HOPS", env.SLUICE_TOOLS_TRUST_PROXY_HOPS, 0, 0, 5),
    rpcTimeoutMs: whole("SLUICE_TOOLS_RPC_TIMEOUT_MS", env.SLUICE_TOOLS_RPC_TIMEOUT_MS, 10_000, 500, 60_000),
    logLevel: level,
  };
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
};

export type ToolServer = {
  server: Server;
  /** Listens and resolves with the port in use. */
  listen(): Promise<number>;
  close(): Promise<void>;
  /** The QUSDC address the router holds, which payments are in. */
  asset: string;
};

const rpcError = (code: number, message: string) => JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null });

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => reject(new Error("failed")));
  });
}

export async function createToolServer(options: ToolServerOptions): Promise<ToolServer> {
  const env = options.env;
  const log = options.logger ?? silentLogger;
  const network = Network.from(env.chainId);
  // Every request to the node has a time limit: ethers would otherwise wait up to five minutes, or for ever on a node that never answers.
  const provider = new TimedJsonRpcProvider(env.rpcUrl, network, { staticNetwork: network }, env.rpcTimeoutMs);
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
  const paywall = createPaywall({ facilitator, router: env.router, vault, asset, chainId: env.chainId });
  const build = paidToolsFactory({
    paywall,
    payee: env.payee,
    rpc,
    explorer: options.explorer ?? explorerClient(env.explorerUrl, fetch, env.rpcTimeoutMs),
    prices: env.prices,
  });
  const listener = mcpRequestListener(build);
  const ipLimiter = new RateLimiter(env.ipPerMinute, 60_000, 10_000, options.now);
  const unpaidLimiter = new RateLimiter(env.unpaidPerMinute, 60_000, 10_000, options.now);
  const handlerTimeout = options.handlerTimeoutMs ?? 60_000;

  const reply = (res: ServerResponse, status: number, text: string, extra: Record<string, string> = {}) => {
    if (res.headersSent) return;
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...extra }).end(text);
  };

  const server = createServer((req, res) => {
    void (async () => {
      const started = Date.now();
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
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
        const any = ipLimiter.hit(client);
        if (!any.ok) {
          log.warn("rate limited", { client, kind: "any" });
          return reply(res, 429, rpcError(-32029, `too many requests; try again in ${any.retryAfterSeconds} seconds`), { "retry-after": String(any.retryAfterSeconds) });
        }
        const declared = Number(req.headers["content-length"]);
        if (Number.isFinite(declared) && declared > env.maxBodyBytes) {
          req.resume();
          return reply(res, 413, rpcError(-32600, "the request is too large"), { connection: "close" });
        }
        let text: string;
        try {
          text = await readBody(req, env.maxBodyBytes);
        } catch {
          return reply(res, 413, rpcError(-32600, "the request is too large"), { connection: "close" });
        }
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          return reply(res, 400, rpcError(-32700, "the request is not JSON"));
        }
        if (typeof body !== "object" || body === null) return reply(res, 400, rpcError(-32600, "the request is not a JSON-RPC message"));
        const paid = carriesPayment(body);
        if (!paid) {
          const unpaid = unpaidLimiter.hit(client);
          if (!unpaid.ok) {
            log.warn("rate limited", { client, kind: "unpaid" });
            return reply(res, 429, rpcError(-32029, `too many requests without a payment; try again in ${unpaid.retryAfterSeconds} seconds`), { "retry-after": String(unpaid.retryAfterSeconds) });
          }
        }
        const what = describeRequest(body);
        res.once("finish", () => log.info("request", { ...what, paid, status: res.statusCode, ms: Date.now() - started }));
        let timer: NodeJS.Timeout | undefined;
        const late = new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            log.warn("a request took too long", { ...what });
            reply(res, 504, rpcError(-32603, "the request took too long"));
            resolve();
          }, handlerTimeout);
        });
        await Promise.race([listener(req, res, body), late]);
        if (timer) clearTimeout(timer);
      } catch {
        // Never put an exception's text, which could hold a URL or a key fragment, in a response or a log line.
        log.error("unexpected error while serving a request");
        reply(res, 500, rpcError(-32603, "internal error"));
      }
    })();
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 20_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;

  return {
    server,
    asset,
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
          provider.destroy();
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

// The example tool server as a serverless function (Vercel). The server keeps nothing between requests: what each payment was used for,
// and the callers' rate limits, are in Redis, so that copies running at the same moment cannot both run a tool for one payment or let a
// caller past a limit. It holds no key.
//
// The database may be the facilitator's too. Every request to it goes through ToolServerRedis, which lets this server reach its own keys
// and nothing else, and the server marks the database as one a tool server uses, so that the facilitator does not share it without being
// told to. That isolation is in this code alone: the token can do anything. A database of its own is the stronger setup.
//
// A hosted facilitator gets no steady second chance at a payment: the sweeper comes every five minutes or later, and a payment lives about
// five. So here the facilitator holds each payment before the tool runs, and the answer is given only once the chain shows it settled.
// Nothing turns this off.
import type { IncomingMessage, ServerResponse } from "node:http";
import { ERRORS, RateLimiter, RedisError, RedisIdempotencyStore, RedisRateLimiter, TOOLS_KEY_PREFIX, TOOLS_MARKER_KEY, TOOLS_MARKER_VALUE, ToolServerRedis, UpstashRest, readRedisCredentials } from "@sluice/sdk";
import type { Limiter, RedisClient } from "@sluice/sdk";
import { ToolServerEnvError, createToolApp, readToolServerEnv, toolServerLogger } from "./host";
import type { Env, ToolApp } from "./host";
import type { ExplorerGet, Rpc } from "./rpc";

/** The longest a function may run, which vercel.json asks for. A claim on a payment outlives it. */
export const MAX_DURATION_SECONDS = 60;
/** A request is answered before the platform would end the function. */
export const HANDLER_TIMEOUT_MS = 45_000;
export const CLAIM_MS = (MAX_DURATION_SECONDS + 30) * 1000;
/** How often a running copy writes the mark again, on a request, in case the database was emptied. */
export const MARK_EVERY_MS = 10 * 60_000;

export type ServerlessToolOptions = {
  /** The settings. Left out, the process's environment. */
  env?: Env;
  /** The database. Left out, Upstash's REST interface with the settings' address and token. For tests, a stand-in. */
  client?: RedisClient;
  /** For tests: a node and an explorer to use instead of the ones the settings name. */
  rpc?: Rpc;
  explorer?: ExplorerGet;
  /** Milliseconds, for when the mark was last written. For tests. */
  now?: () => number;
};

export const toolsPrefix = (network: string, router: string): string => `${TOOLS_KEY_PREFIX}${network}:${router.toLowerCase()}:`;

/** A caller this copy has already counted past the limit is refused here, without a request to a database that others may share. */
const countedHereFirst = (here: RateLimiter, everywhere: Limiter): Limiter => ({
  hit: async (client) => {
    const own = here.hit(client);
    return own.ok ? everywhere.hit(client) : own;
  },
});

export async function createServerlessTools(options: ServerlessToolOptions = {}): Promise<ToolApp> {
  const settings = options.env ?? process.env;
  const env = readToolServerEnv(settings);
  if (env.network === "mainnet" && settings.VERCEL_ENV?.trim() !== "production") {
    throw new ToolServerEnvError("refusing to start on mainnet: this is not a production deployment (VERCEL_ENV must be production)");
  }
  let redis;
  try {
    redis = readRedisCredentials(settings);
  } catch (err) {
    throw new ToolServerEnvError(`refusing to start: ${err instanceof RedisError ? err.message : "the database's settings could not be read"}`);
  }
  if (!redis) throw new ToolServerEnvError("refusing to start: set SLUICE_REDIS_REST_URL and SLUICE_REDIS_REST_TOKEN, where copies of the server keep what each payment was used for");
  // Behind the platform's own proxy, which writes the caller's address, unless the setting says otherwise.
  if (!settings.SLUICE_TOOLS_TRUST_PROXY_HOPS?.trim()) env.trustedProxyHops = 1;
  const metrics = env.metricsToken();
  const logger = toolServerLogger(env, [redis.token(), ...(metrics ? [metrics] : [])]);
  const prefix = toolsPrefix(env.network, env.router);
  // The one client of the database this server has, and it is guarded: nothing here holds the unguarded one.
  const client = new ToolServerRedis(options.client ?? new UpstashRest(redis), prefix);
  const now = options.now ?? (() => Date.now());
  let marked: number | undefined;
  const mark = async (): Promise<void> => {
    if (marked !== undefined && now() - marked < MARK_EVERY_MS) return;
    await client.command(["SET", TOOLS_MARKER_KEY, TOOLS_MARKER_VALUE]);
    marked = now();
  };
  // Said before anything is served or written, so that a facilitator on the same database can see it.
  try {
    await mark();
  } catch {
    throw new ToolServerEnvError("refusing to start: the database could not be marked as one a tool server uses");
  }
  const ip = countedHereFirst(new RateLimiter(env.ipPerMinute, 60_000), new RedisRateLimiter(client, `${prefix}rate:ip:`, env.ipPerMinute, 60_000));
  return createToolApp({
    env,
    logger,
    rpc: options.rpc,
    explorer: options.explorer,
    handlerTimeoutMs: HANDLER_TIMEOUT_MS,
    answerOnlyWhenSettled: true,
    paywallStore: new RedisIdempotencyStore(client, prefix, { claimMs: CLAIM_MS }),
    limiters: {
      ip: { hit: async (caller) => (await mark(), ip.hit(caller)) },
      unpaid: countedHereFirst(new RateLimiter(env.unpaidPerMinute, 60_000), new RedisRateLimiter(client, `${prefix}rate:unpaid:`, env.unpaidPerMinute, 60_000)),
    },
  });
}

let cached: Promise<ToolApp> | undefined;

/** The function Vercel calls (api/index.js). */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let app: ToolApp;
  try {
    cached ??= createServerlessTools();
    app = await cached;
  } catch (err) {
    cached = undefined; // the next request tries again
    // Only messages this package wrote are logged: an unexpected error's text could hold an address or a key fragment.
    toolServerLogger({ logLevel: "info" }).error(err instanceof ToolServerEnvError ? err.message : "the paid tools server failed to start");
    res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: ERRORS.facilitatorUnavailable }));
    return;
  }
  await app.listener(req, res);
}

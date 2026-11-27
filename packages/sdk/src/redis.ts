// The Redis a serverless deployment keeps its shared state in, spoken to over Upstash's REST interface: one HTTPS request per command, the
// command as a JSON array, the token in a header. No client library. Anything that must happen all at once is a Lua script (EVAL), which
// Redis runs without another command in between.
//
// Nothing here ever puts the address or the token in an error or a log line.
import type { LimitResult, Limiter } from "./ratelimit";

/**
 * The facilitator's keys start with one of these and a tool server's with the other, in one database or in two. They are constants:
 * no setting can change what keeps the two apart.
 */
export const FACILITATOR_KEY_PREFIX = "sluice:facilitator:";
export const TOOLS_KEY_PREFIX = "sluice:tools:";
/** What a tool server writes before it serves anything, so that a facilitator can see that a database is also a tool server's. */
export const TOOLS_MARKER_KEY = `${TOOLS_KEY_PREFIX}in-use`;
export const TOOLS_MARKER_VALUE = "a tool server uses this database";

export interface RedisClient {
  /** One command, such as ["GET", "key"]. */
  command(args: ReadonlyArray<string | number>): Promise<unknown>;
  /** A Lua script, with the keys and the other arguments it is given. */
  eval(script: string, keys: readonly string[], args: ReadonlyArray<string | number>): Promise<unknown>;
}

export class RedisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedisError";
  }
}

export type RedisCredentials = { url: string; token: () => string };

const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/;

/**
 * The database's address and token from the environment. SLUICE_REDIS_REST_URL and SLUICE_REDIS_REST_TOKEN are this project's own names;
 * left out, the names a marketplace integration may add are read, as a pair from one source. The read-only token is never one of them.
 * Undefined when none is set. Throws, with no value in the message, for half a pair or an address that is not https.
 */
export function readRedisCredentials(env: Record<string, string | undefined>): RedisCredentials | undefined {
  for (const [urlName, tokenName] of [
    ["SLUICE_REDIS_REST_URL", "SLUICE_REDIS_REST_TOKEN"],
    ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
    ["KV_REST_API_URL", "KV_REST_API_TOKEN"],
  ] as const) {
    const url = env[urlName]?.trim();
    const token = env[tokenName]?.trim();
    if (!url && !token) continue;
    if (!url || !token) throw new RedisError(`${urlName} and ${tokenName} must both be set`);
    if (!url.startsWith("https://") && !LOCAL.test(url)) throw new RedisError(`${urlName} must be an https address`);
    const credentials = { url: url.replace(/\/+$/, ""), token: () => token };
    Object.defineProperty(credentials, "token", { enumerable: false, value: credentials.token });
    return credentials;
  }
  return undefined;
}

/** Upstash's REST interface: POST the command as a JSON array, and read {"result": ...} or {"error": ...}. */
export class UpstashRest implements RedisClient {
  readonly #url: string;
  readonly #token: () => string;

  constructor(
    credentials: RedisCredentials,
    private readonly timeoutMs = 5_000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.#url = credentials.url;
    this.#token = credentials.token;
  }

  async command(args: ReadonlyArray<string | number>): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.#url, {
        method: "POST",
        headers: { authorization: `Bearer ${this.#token()}`, "content-type": "application/json" },
        body: JSON.stringify(args.map(String)),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new RedisError("the database could not be reached");
    }
    let body: { result?: unknown; error?: unknown };
    try {
      body = (await response.json()) as { result?: unknown; error?: unknown };
    } catch {
      throw new RedisError(`the database answered HTTP ${response.status} with nothing readable`);
    }
    // The database's own words can quote the command, which can hold a record: they are not passed on.
    if (!response.ok || body.error !== undefined) throw new RedisError(`the database refused a command (HTTP ${response.status})`);
    return body.result ?? null;
  }

  eval(script: string, keys: readonly string[], args: ReadonlyArray<string | number>): Promise<unknown> {
    return this.command(["EVAL", script, keys.length, ...keys, ...args]);
  }
}

// ------------------------------------------------------------------------------------------------------------------- scripts shared

/** A fixed window: counts a hit, starts the window on the first one, and says whether it is within the limit and how long is left. */
export const RATE_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
local left = redis.call('PTTL', KEYS[1])
if left < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  left = tonumber(ARGV[2])
end
if n > tonumber(ARGV[1]) then return { 0, left } end
return { 1, left }
`;

/** Deletes a key only if it still holds the value given: a claim is let go by the one who made it and no one else. */
export const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

export async function redisHit(client: RedisClient, key: string, max: number, windowMs: number): Promise<LimitResult> {
  const answer = (await client.eval(RATE_SCRIPT, [key], [max, windowMs])) as [number, number];
  if (!Array.isArray(answer)) throw new RedisError("the database gave an unexpected answer");
  return Number(answer[0]) === 1 ? { ok: true } : { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(Number(answer[1]) / 1000)) };
}

/** The rate limit of a service that runs as many short-lived copies: one count for all of them. It throws when the database cannot be asked. */
export class RedisRateLimiter implements Limiter {
  constructor(
    private readonly client: RedisClient,
    private readonly prefix: string,
    private readonly max: number,
    private readonly windowMs: number,
  ) {
    if (!Number.isInteger(max) || max <= 0) throw new Error("the rate limit must be a positive whole number");
  }

  hit(key: string): Promise<LimitResult> {
    return redisHit(this.client, `${this.prefix}${key.toLowerCase()}`, this.max, this.windowMs);
  }
}

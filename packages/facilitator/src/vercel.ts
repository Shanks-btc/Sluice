// The facilitator as a serverless function (Vercel): no process that runs on and no disk that lasts. The queue, the daily caps, the
// relayer's budget and lock, the stored kill switch and the rate limits are in Redis (RedisLedger). A payment that /settle queues is
// settled in the background of that same request, and /internal/drain, which a scheduler calls with a secret, settles whatever is left.
//
// The database may be one a tool server also uses, when that is said in the settings. The switch that does not depend on the database
// is SLUICE_FACILITATOR_KILL_SWITCH: it stops everything whatever the database holds, or whether it answers at all.
//
// The times below fit inside one another: the function is allowed MAX_DURATION_SECONDS (vercel.json asks for the same), the relayer lock
// lasts longer than that, and no send or wait is started that cannot end in time. Safety does not rest on the platform's clock alone: a
// send is signed only while the lock is still held with time to spare, and every write names the lock it was made under.
import type { IncomingMessage, ServerResponse } from "node:http";
import { waitUntil as platformWaitUntil } from "@vercel/functions";
import { ERRORS, UpstashRest, createLogger } from "@sluice/sdk";
import type { Logger, RedisClient } from "@sluice/sdk";
import type { Provider } from "ethers";
import { EnvError, SHARED_DATABASE_ACCEPTED, readEnv } from "./env";
import type { Env } from "./env";
import { KillSwitch } from "./killswitch";
import { RedisLedger, redisPrefix } from "./redis-ledger";
import { connectNode } from "./runtime";
import { createListener } from "./server";
import { Facilitator } from "./service";
import type { SweepReport } from "./service";

export const MAX_DURATION_SECONDS = 120;
/** The relayer lock outlives a function, so one that is stopped part-way cannot overlap the next. */
export const LOCK_TTL_MS = (MAX_DURATION_SECONDS + 30) * 1000;
/** How long a relayed request or a start waits for the relayer. */
export const LOCK_WAIT_MS = 15_000;
export const RECEIPT_TIMEOUT_MS = 45_000;
export const PAYER_RECEIPT_TIMEOUT_MS = 20_000;
/** How long one drain may go on starting batches. */
export const DRAIN_BUDGET_MS = 90_000;
/** How long a capture waits for the chain before it answers "pending". Shorter than the tool server waits for it. */
export const CAPTURE_WAIT_MS = 20_000;

export type ServerlessOptions = {
  /** The settings. Left out, the process's environment. */
  env?: Env;
  /** The database. Left out, Upstash's REST interface with the settings' address and token. For tests, a stand-in. */
  client?: RedisClient;
  /** A provider to use instead of the node the settings name. For tests. */
  provider?: Provider;
  /** Keeps work going after the answer has been sent. Left out, the platform's own. */
  waitUntil?: (work: Promise<unknown>) => void;
  write?: (line: string) => void;
  /** Unix seconds, for the facilitator's clock. */
  now?: () => number;
  /** How long a capture waits. Left out, CAPTURE_WAIT_MS. For tests. */
  captureWaitMs?: number;
};

export type Serverless = {
  facilitator: Facilitator;
  ledger: RedisLedger;
  listener: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  logger: Logger;
};

export async function createServerlessFacilitator(options: ServerlessOptions = {}): Promise<Serverless> {
  const settings = options.env ?? process.env;
  const env = readEnv(settings, "serverless");
  // A preview of a branch must never run with the powers of the relayer key, so on mainnet the platform has to say this is production.
  if (env.network === "mainnet" && settings.VERCEL_ENV?.trim() !== "production") {
    throw new EnvError("refusing to start on mainnet: this is not a production deployment (VERCEL_ENV must be production)");
  }
  const key = env.relayerKey();
  const redis = env.redis as NonNullable<typeof env.redis>;
  const logger = createLogger({ write: options.write, level: env.logLevel, secrets: [key, redis.token(), ...env.drainSecrets()], base: { service: "sluice-facilitator", runtime: "serverless" } });
  const ledger = new RedisLedger(options.client ?? new UpstashRest(redis), redisPrefix(env.network, env.router), { acceptShared: env.acceptSharedDatabase });
  // A database that a tool server also uses means one token for both services, which has to be meant. Not knowing is not good enough
  // either. The ledger looks again before anything is accepted or sent, for a tool server that starts later.
  if (!env.acceptSharedDatabase) {
    let shared: boolean;
    try {
      shared = await ledger.sharedWithTools();
    } catch {
      throw new EnvError("refusing to start: whether the database is also used by a tool server could not be read");
    }
    if (shared) {
      throw new EnvError(`refusing to start: this database is also used by a tool server, so one token would serve both. To accept that, set SLUICE_FACILITATOR_SHARED_DATABASE=${SHARED_DATABASE_ACCEPTED}; a database for each is the stronger setup`);
    }
  } else {
    logger.warn("the database may be shared with a tool server: whatever holds its token can change everything the facilitator keeps in it");
  }
  const provider: Provider = options.provider ?? (await connectNode(env, logger));
  const facilitator = await Facilitator.create({
    provider,
    router: env.router,
    relayerKey: key,
    caps: env.caps,
    chainId: env.chainId,
    ledger,
    publicUrl: env.publicUrl,
    killSwitch: new KillSwitch(env.killSwitch),
    logger,
    lowBalanceWei: env.lowBalanceWei,
    onAlert: (alert) => logger.warn("alert", { kind: alert.kind, message: alert.message }),
    lockTtlMs: LOCK_TTL_MS,
    lockWaitMs: LOCK_WAIT_MS,
    receiptTimeoutMs: RECEIPT_TIMEOUT_MS,
    payerReceiptTimeoutMs: PAYER_RECEIPT_TIMEOUT_MS,
    now: options.now,
  });
  const background = options.waitUntil ?? platformWaitUntil;
  const drain = async (source: "request" | "endpoint"): Promise<SweepReport> => {
    const report = await facilitator.sweep(DRAIN_BUDGET_MS);
    logger.info("drain finished", { source, ...report });
    return report;
  };
  const listener = createListener(facilitator, {
    origins: env.corsOrigins,
    maxBodyBytes: env.maxBodyBytes,
    trustedProxyHops: env.trustedProxyHops,
    metricsToken: env.metricsToken(),
    logger,
    limiters: {
      ip: { hit: (client) => ledger.hit(`ip:${client}`, env.ipPerMinute, 60_000) },
      payer: { hit: (payer) => ledger.hit(`payer:${payer}`, env.payerPerMinute, 60_000) },
    },
    drain: { secrets: env.drainSecrets, run: () => drain("endpoint") },
    // The answer to /settle does not wait for this: it runs on after it, inside the same function's time.
    onQueued: () => background(drain("request").catch(() => logger.error("the drain after a payment failed; the next one settles what is queued"))),
    // /hold and /capture, for a tool server that answers only once a payment has settled. A drain that a capture starts runs on after it.
    holds: { waitMs: options.captureWaitMs ?? CAPTURE_WAIT_MS, drainMs: DRAIN_BUDGET_MS, keep: background },
  });
  return { facilitator, ledger, listener, logger };
}

let cached: Promise<Serverless> | undefined;

/** The function Vercel calls (api/index.js). One facilitator is made for each running copy and kept while the copy lives. */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let app: Serverless;
  try {
    cached ??= createServerlessFacilitator();
    app = await cached;
  } catch (err) {
    cached = undefined; // the next request tries again
    // Only messages this package wrote are logged: an unexpected error's text could hold an address or a key fragment.
    createLogger({ base: { service: "sluice-facilitator", runtime: "serverless" } }).error(err instanceof EnvError ? err.message : "the facilitator failed to start");
    res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: ERRORS.facilitatorUnavailable }));
    return;
  }
  await app.listener(req, res);
}

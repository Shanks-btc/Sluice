// What the facilitator reads from the environment, and when it refuses to start.
//
// Against QIE mainnet or testnet the facilitator sends real transactions, so it follows the same rule as the live
// scripts: it refuses to start without SLUICE_NETWORK, SLUICE_APPROVE=facilitator and a QIE spending cap
// (SLUICE_MAX_QIE, which becomes the relayer's daily budget and may not exceed the relayer's hard ceiling).
// Against a local node (SLUICE_NETWORK=local, an http://127.0.0.1 RPC) no approval is needed, since nothing real
// can be spent there.
import { DEFAULT_CAPS, HARD_CAPS, resolveCaps } from "./caps";
import type { Caps } from "./caps";

export class EnvError extends Error {}

export type Env = Record<string, string | undefined>;

export type FacilitatorEnv = {
  network: "mainnet" | "testnet" | "local";
  chainId: number;
  rpcUrl: string;
  /** True when SLUICE_RPC_URL names the endpoint (or the node is local): it is used as given. False: QIE's public endpoints are probed and the first healthy one is used. */
  rpcNamed: boolean;
  router: string;
  /** A function, so that logging or serialising this object never shows the key. */
  relayerKey: () => string;
  /** The bearer token for the private metrics path, as a function so that it is never printed. Undefined: the path does not exist. */
  metricsToken: () => string | undefined;
  port: number;
  caps: Caps;
  /** Where the queue's journal lives. Required on mainnet and testnet: a queue kept only in memory is lost by a restart. */
  statePath?: string;
  publicUrl?: string;
  /** Browser origins allowed to call the facilitator. Empty unless SLUICE_FACILITATOR_CORS_ORIGINS names some. */
  corsOrigins: string[];
  /** The address to listen on. 127.0.0.1 unless SLUICE_FACILITATOR_HOST says otherwise (a container needs 0.0.0.0). */
  host: string;
  killSwitch: boolean;
  killFile?: string;
  maxBodyBytes: number;
  /** Requests per minute from one client address, and POSTs per minute that name one payer. */
  ipPerMinute: number;
  payerPerMinute: number;
  trustedProxyHops: number;
  /** /health flags the relayer as low below this balance. Undefined means one day's budget. */
  lowBalanceWei?: bigint;
  /** How long a shutdown waits for a batch in progress, in milliseconds. */
  shutdownMs: number;
  /** How often queued intents are batched and sent, in milliseconds. */
  flushMs: number;
  /** How long one request to the node may take, in milliseconds. */
  rpcTimeoutMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
};

const RPC = { mainnet: "https://rpc1mainnet.qie.digital/", testnet: "https://rpc1testnet.qie.digital/" } as const;
const CHAIN = { mainnet: 1990, testnet: 1983, local: 1990 } as const;
const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/;

function qieToWei(text: string, name: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,18}))?$/.exec(text.trim());
  if (!m) throw new EnvError(`${name} must be a plain positive decimal`);
  const wei = BigInt(m[1] as string) * 10n ** 18n + BigInt((m[2] ?? "").padEnd(18, "0") || "0");
  if (wei === 0n) throw new EnvError(`${name} must be above zero`);
  return wei;
}

/**
 * "https://app.example, http://localhost:3000" -> exact origins. Each must be https, or http on this machine, with no path, query or
 * wildcard. Anything else stops the start: a mistyped allowlist must not quietly allow nothing, or something wider.
 */
export function parseCorsOrigins(text: string | undefined): string[] {
  const out: string[] = [];
  for (const raw of (text ?? "").split(",").map((t) => t.trim()).filter(Boolean)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new EnvError("refusing to start: SLUICE_FACILITATOR_CORS_ORIGINS holds something that is not an origin");
    }
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    const plain = url.origin === raw && !url.username && !url.password && /^[a-z0-9.-]+$/i.test(url.hostname);
    if (!plain || !(url.protocol === "https:" || (url.protocol === "http:" && local))) {
      throw new EnvError("refusing to start: each SLUICE_FACILITATOR_CORS_ORIGINS entry must be an https origin (or http on this machine) with no path");
    }
    if (!out.includes(url.origin)) out.push(url.origin);
  }
  return out;
}

const TRUE = new Set(["1", "true", "yes", "on"]);
const FALSE = new Set(["", "0", "false", "no", "off"]);

/** "1" or "true" turns a flag on; "0", "false" or nothing leaves it off. Anything else stops the start, so a typo cannot leave a safety off. */
export function parseFlag(name: string, text: string | undefined): boolean {
  const v = (text ?? "").trim().toLowerCase();
  if (TRUE.has(v)) return true;
  if (FALSE.has(v)) return false;
  throw new EnvError(`refusing to start: ${name} must be 1 or 0`);
}

/**
 * A QUSDC cap that can only be lowered: "0.05" -> 50000 units. Above the default it stops the start, so none of these settings can
 * widen what the service accepts, whatever the cap's ceiling in code is.
 */
function loweredQusdc(name: string, text: string | undefined, fallback: bigint): bigint | undefined {
  const raw = text?.trim();
  if (!raw) return undefined;
  const m = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(raw);
  const units = m ? BigInt(m[1] as string) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0") : 0n;
  if (units === 0n) throw new EnvError(`refusing to start: ${name} must be a plain amount of QUSDC above zero, with at most six decimals`);
  if (units > fallback) throw new EnvError(`refusing to start: ${name} can only lower the cap, which is ${fallback / 1_000_000n} QUSDC`);
  return units;
}

/** The settings that lower the QUSDC caps, and the cap each one lowers. */
const QUSDC_CAPS = [
  ["SLUICE_FACILITATOR_MAX_ONBOARD_QUSDC", "maxOnboardAmount"],
  ["SLUICE_FACILITATOR_PAYER_DAILY_QUSDC", "payerDailyAmount"],
  ["SLUICE_FACILITATOR_DAILY_QUSDC", "globalDailyAmount"],
] as const;

function whole(name: string, text: string | undefined, fallback: number, min: number, max: number): number {
  const raw = text?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) {
    throw new EnvError(`refusing to start: ${name} must be a whole number from ${min} to ${max}`);
  }
  return n;
}

const HOST = /^(\d{1,3}(\.\d{1,3}){3}|localhost|[a-z0-9.-]+)$/i;

export function readEnv(env: Env): FacilitatorEnv {
  const network = env.SLUICE_NETWORK?.trim();
  if (network !== "mainnet" && network !== "testnet" && network !== "local") {
    throw new EnvError("refusing to start: set SLUICE_NETWORK to mainnet, testnet or local");
  }
  if (network !== "local") {
    const approved = env.SLUICE_APPROVE?.trim();
    if (approved !== "facilitator") {
      const shown = approved && /^[A-Za-z0-9_-]{1,24}$/.test(approved) ? `approves "${approved}"` : "does not approve it";
      throw new EnvError(`refusing to start on ${network}: SLUICE_APPROVE must equal "facilitator" (it ${shown})`);
    }
    if (!env.SLUICE_MAX_QIE?.trim()) {
      throw new EnvError("refusing to start: set SLUICE_MAX_QIE, the most QIE the relayer may spend in a day");
    }
  }
  const rpcUrl = (env.SLUICE_RPC_URL?.trim() || (network === "local" ? "" : RPC[network])).trim();
  if (!rpcUrl) throw new EnvError("refusing to start: set SLUICE_RPC_URL for a local node");
  if (!rpcUrl.startsWith("https://") && !LOCAL.test(rpcUrl)) throw new EnvError("refusing to start: SLUICE_RPC_URL must be https");
  if (network === "local" && !LOCAL.test(rpcUrl)) throw new EnvError("refusing to start: a local run needs an http://127.0.0.1 RPC");

  const router = env.SLUICE_ROUTER?.trim();
  if (!router || !/^0x[0-9a-fA-F]{40}$/.test(router)) throw new EnvError("refusing to start: SLUICE_ROUTER must be the router's address");
  const key = env.SLUICE_RELAYER_KEY?.trim();
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new EnvError("refusing to start: SLUICE_RELAYER_KEY must be a 0x-prefixed 32-byte hex key");

  const statePath = env.SLUICE_FACILITATOR_STATE?.trim() || undefined;
  if (network !== "local" && !statePath) {
    throw new EnvError(`refusing to start on ${network}: set SLUICE_FACILITATOR_STATE to a file on a disk that survives restarts, because a queue kept only in memory is lost when the process stops`);
  }

  const requested: Partial<Caps> = {};
  if (env.SLUICE_MAX_QIE?.trim()) requested.dailyBudgetWei = qieToWei(env.SLUICE_MAX_QIE, "SLUICE_MAX_QIE");
  if (env.SLUICE_FACILITATOR_MAX_TOPUP_QIE?.trim()) requested.maxTopUpWei = qieToWei(env.SLUICE_FACILITATOR_MAX_TOPUP_QIE, "SLUICE_FACILITATOR_MAX_TOPUP_QIE");
  if (env.SLUICE_FACILITATOR_MAX_TOPUP_PER_ADDRESS_QIE?.trim()) {
    requested.topUpPerAddressDailyWei = qieToWei(env.SLUICE_FACILITATOR_MAX_TOPUP_PER_ADDRESS_QIE, "SLUICE_FACILITATOR_MAX_TOPUP_PER_ADDRESS_QIE");
  } else if (requested.maxTopUpWei !== undefined && requested.maxTopUpWei > DEFAULT_CAPS.topUpPerAddressDailyWei) {
    requested.topUpPerAddressDailyWei = requested.maxTopUpWei; // one top-up of the size asked for, per address per day
  }
  for (const [name, cap] of QUSDC_CAPS) {
    const lowered = loweredQusdc(name, env[name], DEFAULT_CAPS[cap]);
    if (lowered !== undefined) requested[cap] = lowered;
  }
  let caps: Caps;
  try {
    caps = resolveCaps(requested);
  } catch (err) {
    throw new EnvError(`refusing to start: ${err instanceof Error ? err.message : "bad caps"}. The ceiling for the daily budget is ${HARD_CAPS.dailyBudgetWei / 10n ** 18n} QIE`);
  }
  if (caps.topUpPerAddressDailyWei < caps.maxTopUpWei) {
    throw new EnvError("refusing to start: the daily top-up cap for one address is below a single top-up, so no zero-QIE start could ever be funded");
  }
  const host = env.SLUICE_FACILITATOR_HOST?.trim() || "127.0.0.1";
  if (!HOST.test(host)) throw new EnvError("refusing to start: SLUICE_FACILITATOR_HOST is not an address");
  const level = env.SLUICE_FACILITATOR_LOG_LEVEL?.trim() || "info";
  if (level !== "debug" && level !== "info" && level !== "warn" && level !== "error") {
    throw new EnvError("refusing to start: SLUICE_FACILITATOR_LOG_LEVEL must be debug, info, warn or error");
  }
  const lowBalance = env.SLUICE_FACILITATOR_LOW_BALANCE_QIE?.trim();
  const port = Number(env.SLUICE_FACILITATOR_PORT?.trim() || 8402);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new EnvError("refusing to start: SLUICE_FACILITATOR_PORT is not a port");

  const metrics = env.SLUICE_FACILITATOR_METRICS_TOKEN?.trim() || undefined;
  if (metrics !== undefined && !/^[A-Za-z0-9._~+/=-]{24,200}$/.test(metrics)) {
    throw new EnvError("refusing to start: SLUICE_FACILITATOR_METRICS_TOKEN must be 24 to 200 characters of letters, digits and . _ ~ + / = -");
  }

  const out: FacilitatorEnv = {
    network,
    chainId: CHAIN[network],
    rpcUrl,
    rpcNamed: Boolean(env.SLUICE_RPC_URL?.trim()) || network === "local",
    router,
    relayerKey: () => key,
    metricsToken: () => metrics,
    port,
    caps,
    statePath,
    publicUrl: env.SLUICE_FACILITATOR_URL?.trim() || undefined,
    corsOrigins: parseCorsOrigins(env.SLUICE_FACILITATOR_CORS_ORIGINS),
    host,
    killSwitch: parseFlag("SLUICE_FACILITATOR_KILL_SWITCH", env.SLUICE_FACILITATOR_KILL_SWITCH),
    killFile: env.SLUICE_FACILITATOR_KILL_FILE?.trim() || undefined,
    maxBodyBytes: whole("SLUICE_FACILITATOR_MAX_BODY_BYTES", env.SLUICE_FACILITATOR_MAX_BODY_BYTES, 64 * 1024, 1024, 1024 * 1024),
    ipPerMinute: whole("SLUICE_FACILITATOR_RATE_LIMIT_IP", env.SLUICE_FACILITATOR_RATE_LIMIT_IP, 240, 1, 100_000),
    payerPerMinute: whole("SLUICE_FACILITATOR_RATE_LIMIT_PAYER", env.SLUICE_FACILITATOR_RATE_LIMIT_PAYER, 60, 1, 100_000),
    trustedProxyHops: whole("SLUICE_FACILITATOR_TRUST_PROXY_HOPS", env.SLUICE_FACILITATOR_TRUST_PROXY_HOPS, 0, 0, 5),
    lowBalanceWei: lowBalance ? qieToWei(lowBalance, "SLUICE_FACILITATOR_LOW_BALANCE_QIE") : undefined,
    shutdownMs: whole("SLUICE_FACILITATOR_SHUTDOWN_MS", env.SLUICE_FACILITATOR_SHUTDOWN_MS, 30_000, 1_000, 300_000),
    flushMs: whole("SLUICE_FACILITATOR_FLUSH_MS", env.SLUICE_FACILITATOR_FLUSH_MS, 15_000, 250, 600_000),
    rpcTimeoutMs: whole("SLUICE_FACILITATOR_RPC_TIMEOUT_MS", env.SLUICE_FACILITATOR_RPC_TIMEOUT_MS, 20_000, 1_000, 120_000),
    logLevel: level,
  };
  Object.defineProperty(out, "relayerKey", { enumerable: false, value: out.relayerKey });
  Object.defineProperty(out, "metricsToken", { enumerable: false, value: out.metricsToken });
  return out;
}

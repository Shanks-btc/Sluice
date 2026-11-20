// The server side of the demo page's risk check. It runs the same token_risk_check logic as the paid example tool, in read-only mode:
// eth_call, eth_getCode and eth_getStorageAt on the public RPC, and GET requests to the public explorer. It signs and sends nothing,
// holds no key, and reads no secret.
//
// Guards: POST only; a small JSON body; an address in the exact 0x-and-40-hex form (and with a valid checksum if it has mixed case);
// a rate limit per caller and one for the whole server; a timeout on the whole check; no stack trace or upstream message in any answer.
import { JsonRpcProvider, FetchRequest, Network, getAddress } from "ethers";
import { PUBLIC_EXPLORER, PUBLIC_RPC, explorerClient, rpcFromProvider } from "@sluice/paid-tools/rpc";
import type { ExplorerGet, Rpc } from "@sluice/paid-tools/rpc";
import { tokenRiskCheck } from "@sluice/paid-tools/tokenRisk";
import { parseWebUrl } from "./config";
import { RateLimiter, callerKey } from "./rate-limit";

export const MAX_BODY_CHARS = 512;
export const CHECK_TIMEOUT_MS = 25_000;
export const QUSDC_EXAMPLE = "0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5";

export type RiskDeps = { rpc: Rpc; explorer?: ExplorerGet };

const json = (status: number, body: unknown, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });

export type ParsedBody = { ok: true; address: string } | { ok: false; status: number; error: string };

/** The body must be {"address": "0x…"} and nothing else the check would use. */
export function parseRiskBody(text: string): ParsedBody {
  if (text.length > MAX_BODY_CHARS) return { ok: false, status: 413, error: "request_too_large" };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, error: "invalid_json" };
  }
  const address = typeof body === "object" && body !== null ? (body as Record<string, unknown>).address : undefined;
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) return { ok: false, status: 400, error: "invalid_address" };
  try {
    return { ok: true, address: getAddress(address) };
  } catch {
    return { ok: false, status: 400, error: "invalid_address" };
  }
}

export type RiskHandlerOptions = {
  deps: () => RiskDeps;
  perCaller?: RateLimiter;
  global?: RateLimiter;
  timeoutMs?: number;
};

/** The route's logic, with the chain access and the clocks injected so a test can drive it without a network. */
export function makeRiskHandler(options: RiskHandlerOptions): (request: Request) => Promise<Response> {
  const perCaller = options.perCaller ?? new RateLimiter({ limit: 6, windowMs: 60_000 });
  const global = options.global ?? new RateLimiter({ limit: 60, windowMs: 60_000, maxKeys: 1 });
  const timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS;

  return async (request) => {
    if (request.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" }, { allow: "POST" });
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      return json(415, { ok: false, error: "json_required" });
    }
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_BODY_CHARS * 4) return json(413, { ok: false, error: "request_too_large" });

    const caller = perCaller.take(callerKey(request.headers));
    const all = global.take("all");
    if (!caller.ok || !all.ok) {
      const wait = !caller.ok ? caller.retryAfterSeconds : (all as { retryAfterSeconds: number }).retryAfterSeconds;
      return json(429, { ok: false, error: "rate_limited", retryAfterSeconds: wait }, { "retry-after": String(wait) });
    }

    const parsed = parseRiskBody((await request.text()).slice(0, MAX_BODY_CHARS + 1));
    if (!parsed.ok) return json(parsed.status, { ok: false, error: parsed.error });

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      });
      const result = await Promise.race([tokenRiskCheck(options.deps(), parsed.address), timeout]);
      return json(200, { ok: true, result });
    } catch (err) {
      return json(err instanceof Error && err.message === "timeout" ? 504 : 502, { ok: false, error: "check_failed" });
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

/** The public RPC and explorer, or the addresses in SLUICE_RPC_URL and SLUICE_EXPLORER_URL (https, or on this machine). */
export function depsFromEnv(env: Record<string, string | undefined> = process.env): RiskDeps {
  const rpcUrl = parseWebUrl(env["SLUICE_RPC_URL"])?.toString() ?? PUBLIC_RPC;
  const explorerUrl = parseWebUrl(env["SLUICE_EXPLORER_URL"])?.toString() ?? PUBLIC_EXPLORER;
  const net = Network.from(1990);
  const request = new FetchRequest(rpcUrl);
  request.timeout = 10_000;
  const provider = new JsonRpcProvider(request, net, { staticNetwork: net, cacheTimeout: -1 });
  return { rpc: rpcFromProvider(provider), explorer: explorerClient(explorerUrl) };
}

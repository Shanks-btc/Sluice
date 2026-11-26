// The host check: ask the hosted facilitator and the hosted tool server for /health, and say PASS, WARN or FAIL for each thing that has to
// be true before anyone is pointed at them. Read-only: every request is a GET of /health with no body, no cookie and no credential, and it
// follows no redirect. It sends nothing to the chain and holds no key.
//
// With a web origin it also asks each service, as a browser page on that origin would, whether the origin may read the answer, and whether
// an origin that is not listed may not. That is how the "never a wildcard" setting is checked from outside.
import { formatEther, getAddress } from "ethers";

export const MAINNET_CHAIN_ID = 1990;
/** The most a /health answer may hold. It is a few hundred bytes. */
const MAX_BODY_CHARS = 1_048_576;
/** An origin nobody lists. A service that answers it with a header allows more than it should. */
export const STRANGER_ORIGIN = "https://hostcheck-not-listed.invalid";

export type Level = "PASS" | "WARN" | "FAIL";
export type Who = "setup" | "facilitator" | "tool server";
export type Line = { level: Level; who: Who; text: string };

const line = (level: Level, who: Who, text: string): Line => ({ level, who, text });

// ------------------------------------------------------------------------------------------------------------------ addresses

/** A service's address as typed: https (http only for this machine), the address alone, no user name and no path. Never repeats what was typed. */
export function parseServiceUrl(flag: string, raw: string | undefined): { origin?: string; problem?: string } {
  const text = raw?.trim();
  if (!text) return { problem: `${flag} is missing` };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { problem: `${flag} is not a web address` };
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return { problem: `${flag} must be https (plain http is for this machine only)` };
  if (url.username || url.password) return { problem: `${flag} must not hold a user name or a password` };
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) return { problem: `${flag} must be the address alone, with no path: this command asks for /health itself` };
  return { origin: url.origin };
}

/** The web app's origin: scheme, host and optional port, exactly, with no path, no trailing slash and no wildcard. */
export function parseWebOrigin(flag: string, raw: string | undefined): { origin?: string; problem?: string } {
  const text = raw?.trim();
  if (!text) return { problem: `${flag} is missing` };
  if (text.includes("*")) return { problem: `${flag} must be one exact origin: a wildcard is never right` };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { problem: `${flag} is not an origin` };
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return { problem: `${flag} must be https (plain http is for this machine only)` };
  if (url.origin !== text) return { problem: `${flag} must be exactly the scheme, the host and the port, with no path and no trailing slash` };
  return { origin: url.origin };
}

/** An address that is the same address however it is capitalised. */
function sameAddress(a: unknown, b: string | undefined): boolean {
  if (typeof a !== "string" || !b || !/^0x[0-9a-fA-F]{40}$/.test(a)) return false;
  return a.toLowerCase() === b.toLowerCase();
}
const isAddress = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0{40}$/.test(a);
/** Any 32-byte hex value: a key looks like this, and /health carries none (its only hashes are 20-byte addresses). */
const HOLDS_32_BYTES = /[0-9a-fA-F]{64}/;

// ---------------------------------------------------------------------------------------------------------------------- asking

export type Got = { ok: true; status: number; json?: unknown; text: string; allowOrigin: string | null } | { ok: false; reason: string };

function reasonOf(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError" || name === "AbortError") return "no answer in time";
  const cause = (err as { cause?: { code?: unknown } } | undefined)?.cause;
  const code = typeof cause?.code === "string" && /^[A-Z0-9_]{3,40}$/.test(cause.code) ? cause.code : undefined;
  return code ? `could not connect (${code})` : "could not connect";
}

/** One GET of /health. Nothing else is ever asked: the path is fixed here, and the method is always GET. */
async function getHealth(fetchImpl: typeof fetch, origin: string, timeoutMs: number, headers: Record<string, string> = {}): Promise<Got> {
  try {
    const res = await fetchImpl(`${origin}/health`, { method: "GET", redirect: "manual", headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    if (text.length > MAX_BODY_CHARS) return { ok: false, reason: "the answer is far larger than a /health answer ever is" };
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { ok: true, status: res.status, json, text, allowOrigin: res.headers.get("access-control-allow-origin") };
  } catch (err) {
    return { ok: false, reason: reasonOf(err) };
  }
}

// ------------------------------------------------------------------------------------------------------------------- checking

export type Expect = { router?: string; routerSource?: string; chainId: number; network: string };

/** The lines every service shares: it answered, with 200, in JSON, and the answer holds nothing that could be a key. Undefined body: stop. */
function opening(got: Got, who: Who): { lines: Line[]; body?: Record<string, unknown> } {
  if (!got.ok) return { lines: [line("FAIL", who, `GET /health failed: ${got.reason}`)] };
  if (got.status >= 300 && got.status < 400) {
    return { lines: [line("FAIL", who, `GET /health answered a redirect (HTTP ${got.status}): none is followed, because a check that is passed on to another address does not check this one`)] };
  }
  if (got.status === 503) {
    return { lines: [line("FAIL", who, "GET /health answered HTTP 503: the service says it is not well (it cannot write its queue, or it is shutting down)")], body: asRecord(got.json) };
  }
  if (got.status !== 200) return { lines: [line("FAIL", who, `GET /health answered HTTP ${got.status}, not 200`)] };
  const body = asRecord(got.json);
  if (!body) return { lines: [line("FAIL", who, "GET /health answered 200, but not with a JSON object")] };
  const lines = [line("PASS", who, "GET /health answered HTTP 200 with JSON")];
  lines.push(
    HOLDS_32_BYTES.test(got.text)
      ? line("FAIL", who, "the answer holds a 32-byte value, which /health never carries and a key would look like: read the answer yourself, and if it is a key, rotate it")
      : line("PASS", who, "the answer holds no 32-byte value, so no key"),
  );
  return { lines, body };
}

const asRecord = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

function chainLine(who: Who, body: Record<string, unknown>, expect: Expect): Line {
  const n = typeof body.chainId === "number" ? body.chainId : typeof body.chainId === "string" && /^\d+$/.test(body.chainId) ? Number(body.chainId) : undefined;
  if (n === undefined) return line("FAIL", who, "chainId is missing");
  return n === expect.chainId ? line("PASS", who, `chainId is ${n}`) : line("FAIL", who, `chainId is ${n}, not ${expect.chainId}`);
}

function routerLine(who: Who, body: Record<string, unknown>, expect: Expect): Line {
  if (!expect.router) return line("FAIL", who, "there is no router to compare with: give --router, set SLUICE_ROUTER, or run this where deployment.json is");
  if (!isAddress(body.router)) return line("FAIL", who, "router is missing or is not an address");
  return sameAddress(body.router, expect.router)
    ? line("PASS", who, `router is ${getAddress(body.router)}, the one expected (${expect.routerSource ?? "given"})`)
    : line("FAIL", who, `router is ${getAddress(body.router)}, but the one expected is ${expect.router} (${expect.routerSource ?? "given"})`);
}

/** The facilitator's /health: ok, the chain, the router, the kill switch, the queue, and the relayer's balance. */
export function checkFacilitator(got: Got, expect: Expect): Line[] {
  const who: Who = "facilitator";
  const { lines, body } = opening(got, who);
  if (!body || !got.ok || got.status !== 200) return lines;
  lines.push(body.ok === true ? line("PASS", who, "ok is true") : line("FAIL", who, "ok is not true"));
  lines.push(chainLine(who, body, expect));
  lines.push(routerLine(who, body, expect));
  lines.push(
    body.killSwitch === false
      ? line("PASS", who, "killSwitch is false")
      : body.killSwitch === true
        ? line("FAIL", who, "killSwitch is true: the facilitator refuses new payments and settles nothing until it is turned off")
        : line("FAIL", who, "killSwitch is missing"),
  );
  const store = asRecord(body.store);
  lines.push(store?.healthy === true ? line("PASS", who, "store.healthy is true: the queue can be written") : line("FAIL", who, "store.healthy is not true: the queue cannot be written"));
  lines.push(body.draining === true ? line("FAIL", who, "draining is true: the service is shutting down") : line("PASS", who, "it is not shutting down"));

  let balance: bigint | undefined;
  if (typeof body.relayerBalanceWei === "string" && /^\d+$/.test(body.relayerBalanceWei)) balance = BigInt(body.relayerBalanceWei);
  const relayer = isAddress(body.relayer) ? getAddress(body.relayer) : undefined;
  if (balance === undefined || !relayer) lines.push(line("FAIL", who, "the relayer's address or balance is missing"));
  else if (balance > 0n) lines.push(line("PASS", who, `relayer ${relayer} holds ${formatEther(balance)} QIE, above zero`));
  else lines.push(line("FAIL", who, `relayer ${relayer} holds no QIE: it cannot send a batch`));
  if (body.lowBalance === true) {
    const threshold = typeof body.lowBalanceThresholdWei === "string" && /^\d+$/.test(body.lowBalanceThresholdWei) ? ` of ${formatEther(BigInt(body.lowBalanceThresholdWei))} QIE` : "";
    lines.push(line("WARN", who, `lowBalance is true: the relayer holds less than its threshold${threshold}. It still settles while it has QIE and budget, and it needs topping up`));
  } else if (body.lowBalance === false) {
    lines.push(line("PASS", who, "lowBalance is false"));
  }
  if (typeof body.relayerQusdcUnits === "string" && body.relayerQusdcUnits !== "0") lines.push(line("WARN", who, "the relayer holds QUSDC, which it should never do: move it out"));
  const alerts = Array.isArray(body.alerts) ? body.alerts : [];
  if (alerts.length === 0) lines.push(line("PASS", who, "no alerts"));
  else {
    const kinds = [...new Set(alerts.map((a) => (typeof asRecord(a)?.kind === "string" ? String(asRecord(a)?.kind).slice(0, 40) : "unknown")))].slice(0, 6);
    lines.push(line("WARN", who, `${alerts.length} alert${alerts.length === 1 ? "" : "s"}: ${kinds.join(", ")}`));
  }
  return lines;
}

/** The tool server's /health: that it is the tool server, on the right network, chain and router, with a payee and priced tools. */
export function checkToolServer(got: Got, expect: Expect): Line[] {
  const who: Who = "tool server";
  const { lines, body } = opening(got, who);
  if (!body || !got.ok || got.status !== 200) return lines;
  lines.push(body.ok === true ? line("PASS", who, "ok is true") : line("FAIL", who, "ok is not true"));
  lines.push(body.service === "sluice-paid-tools" ? line("PASS", who, "service is sluice-paid-tools") : line("FAIL", who, "service is not sluice-paid-tools: this is not the tool server"));
  lines.push(body.network === expect.network ? line("PASS", who, `network is ${expect.network}`) : line("FAIL", who, `network is ${typeof body.network === "string" ? body.network.slice(0, 20) : "missing"}, not ${expect.network}`));
  lines.push(chainLine(who, body, expect));
  lines.push(routerLine(who, body, expect));
  lines.push(isAddress(body.payee) ? line("PASS", who, `payee is ${getAddress(body.payee)}`) : line("FAIL", who, "payee is missing, zero or not an address: nobody would be paid"));
  const tools = Array.isArray(body.tools) ? body.tools.map(asRecord) : [];
  const priced = tools.filter((t): t is Record<string, unknown> => !!t && typeof t.name === "string" && typeof t.price === "string" && /^\d+(\.\d{1,6})?$/.test(t.price) && Number(t.price) > 0);
  lines.push(
    priced.length > 0 && priced.length === tools.length
      ? line("PASS", who, `${priced.length} tool${priced.length === 1 ? "" : "s"} priced: ${priced.map((t) => `${String(t.name).slice(0, 40)}=${String(t.price)}`).join(", ")}`)
      : line("FAIL", who, "the tools are missing, or one has no price above zero"),
  );
  return lines;
}

/** Asks one service, as a page on `webOrigin` would, whether that origin may read its answers, and whether a stranger's origin may not. */
async function checkCors(who: Who, setting: string, origin: string, webOrigin: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<Line[]> {
  const listed = await getHealth(fetchImpl, origin, timeoutMs, { origin: webOrigin });
  const out: Line[] = [];
  if (!listed.ok) return [line("FAIL", who, `the origin check failed: ${listed.reason}`)];
  if (listed.allowOrigin === webOrigin) out.push(line("PASS", who, `a page on ${webOrigin} may read its answers: access-control-allow-origin is that origin, exactly`));
  else if (listed.allowOrigin === "*") out.push(line("FAIL", who, `access-control-allow-origin is *, which lets any page read its answers: set ${setting} to ${webOrigin} alone`));
  else if (listed.allowOrigin === null) out.push(line("FAIL", who, `a page on ${webOrigin} cannot read its answers: set ${setting} to ${webOrigin}`));
  else out.push(line("FAIL", who, `access-control-allow-origin is ${listed.allowOrigin.slice(0, 80)}, not ${webOrigin}: set ${setting} to ${webOrigin}`));
  const stranger = await getHealth(fetchImpl, origin, timeoutMs, { origin: STRANGER_ORIGIN });
  if (!stranger.ok) out.push(line("FAIL", who, `the stranger-origin check failed: ${stranger.reason}`));
  else if (stranger.allowOrigin === null) out.push(line("PASS", who, "an origin that is not listed gets no access-control-allow-origin header"));
  else out.push(line("FAIL", who, `an origin that is not listed got access-control-allow-origin: ${stranger.allowOrigin.slice(0, 80)}: the list is too wide`));
  return out;
}

// ----------------------------------------------------------------------------------------------------------------------- run

export type HostCheckOptions = {
  facilitator: string;
  tools: string;
  router?: string;
  routerSource?: string;
  /** The web app's origin. When given, both services are asked whether it may read their answers. */
  origin?: string;
  fetchImpl?: typeof fetch;
  /** A test of a local stack may expect another chain or network. The command never offers these: it is for mainnet. */
  expectedChainId?: number;
  expectedNetwork?: string;
  timeoutMs?: number;
};

export async function checkHost(o: HostCheckOptions): Promise<Line[]> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const timeoutMs = o.timeoutMs ?? 15_000;
  const expect: Expect = { router: o.router, routerSource: o.routerSource, chainId: o.expectedChainId ?? MAINNET_CHAIN_ID, network: o.expectedNetwork ?? "mainnet" };
  const [f, t] = await Promise.all([getHealth(fetchImpl, o.facilitator, timeoutMs), getHealth(fetchImpl, o.tools, timeoutMs)]);
  const lines = [...checkFacilitator(f, expect), ...checkToolServer(t, expect)];
  const relayer = f.ok ? asRecord(f.json)?.relayer : undefined;
  const payee = t.ok ? asRecord(t.json)?.payee : undefined;
  if (isAddress(relayer) && isAddress(payee) && sameAddress(relayer, payee)) {
    lines.push(line("WARN", "setup", "the tool server's payee is the relayer's address: earnings would be credited to the key that only pays gas, and it should never hold QUSDC"));
  }
  if (o.origin) {
    lines.push(...(await checkCors("facilitator", "SLUICE_FACILITATOR_CORS_ORIGINS", o.facilitator, o.origin, fetchImpl, timeoutMs)));
    lines.push(...(await checkCors("tool server", "SLUICE_TOOLS_CORS_ORIGINS", o.tools, o.origin, fetchImpl, timeoutMs)));
  }
  return lines;
}

export function summarize(lines: Line[]): { pass: number; warn: number; fail: number } {
  return { pass: lines.filter((l) => l.level === "PASS").length, warn: lines.filter((l) => l.level === "WARN").length, fail: lines.filter((l) => l.level === "FAIL").length };
}

export function formatLines(lines: Line[]): string[] {
  return lines.map((l) => `${l.level.padEnd(4)}  ${l.who.padEnd(11)}  ${l.text}`);
}

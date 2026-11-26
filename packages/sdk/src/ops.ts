// What the facilitator and the tool server share for running as a service: a request id on every request, a private metrics path that
// needs a bearer token, and counters rendered as plain text (the Prometheus text format, which any scraper reads).
//
// Nothing here holds a key, an address of a payer or an amount. A request id is random and means nothing; a counter is a number.
import { randomUUID, timingSafeEqual } from "node:crypto";

/** What a request id may look like when a caller supplies one. Anything else is replaced, so a log line cannot be forged through it. */
export const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** The caller's `x-request-id` if it is well formed, otherwise a new one. */
export function requestIdFor(incoming: string | readonly string[] | undefined, make: () => string = randomUUID): string {
  const value = Array.isArray(incoming) ? incoming[0] : incoming;
  return typeof value === "string" && REQUEST_ID.test(value) ? value : make();
}

/** True when `header` is `Bearer <token>` for exactly this token. False when no token is configured, so an unset token opens nothing. */
export function bearerMatches(header: string | undefined, token: string | undefined): boolean {
  if (!token || typeof header !== "string") return false;
  const m = /^Bearer (\S{1,400})$/.exec(header);
  if (!m) return false;
  const given = Buffer.from(m[1] as string);
  const wanted = Buffer.from(token);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/** The routes a counter may name. Any other path counts as "other", so a client cannot make the counter grow by inventing paths. */
export function routeLabel(path: string, known: readonly string[]): string {
  for (const k of known) if (path === k) return k;
  return path.startsWith("/status/") && known.includes("/status") ? "/status" : "other";
}

const statusClass = (status: number): string => `${Math.floor(status / 100)}xx`;

/** Requests counted by route and status class. */
export class RequestCounter {
  private readonly counts = new Map<string, number>();

  record(route: string, status: number): void {
    const key = `${route}|${statusClass(status)}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  total(): number {
    let n = 0;
    for (const v of this.counts.values()) n += v;
    return n;
  }

  /** Lines for `name`, sorted so the output is the same for the same counts. */
  lines(name: string): string[] {
    const out = [`# TYPE ${name} counter`];
    for (const key of [...this.counts.keys()].sort()) {
      const [route, klass] = key.split("|") as [string, string];
      out.push(`${name}{route="${route}",status="${klass}"} ${this.counts.get(key)}`);
    }
    return out;
  }
}

export type Gauge = { name: string; value: number | bigint | boolean | null | undefined; labels?: Record<string, string>; help?: string };

const safeLabel = (text: string): string => text.replace(/[^A-Za-z0-9_.:-]/g, "_");

/** One gauge per line. A value that is not known is left out, never written as zero. */
export function renderGauges(gauges: readonly Gauge[]): string[] {
  const out: string[] = [];
  const typed = new Set<string>();
  for (const g of gauges) {
    if (g.value === null || g.value === undefined) continue;
    if (!typed.has(g.name)) {
      if (g.help) out.push(`# HELP ${g.name} ${g.help.replace(/\n/g, " ")}`);
      out.push(`# TYPE ${g.name} gauge`);
      typed.add(g.name);
    }
    const labels = g.labels && Object.keys(g.labels).length > 0 ? `{${Object.entries(g.labels).map(([k, v]) => `${safeLabel(k)}="${safeLabel(v)}"`).join(",")}}` : "";
    out.push(`${g.name}${labels} ${typeof g.value === "boolean" ? (g.value ? 1 : 0) : String(g.value)}`);
  }
  return out;
}

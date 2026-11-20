// A small fixed-window rate limiter for the server routes, kept in memory. On a host that runs several instances each keeps its own
// counts, so this is a guard against a runaway client, not a hard quota. A key is a hash of the caller's address, never the address.
import { createHash } from "node:crypto";

export type LimiterOptions = {
  /** Requests allowed per window per key. */
  limit: number;
  windowMs: number;
  /** The most keys held at once. The oldest are dropped first, so memory stays bounded under a flood of new callers. */
  maxKeys?: number;
  now?: () => number;
};

export type Take = { ok: true } | { ok: false; retryAfterSeconds: number };

export class RateLimiter {
  private readonly hits = new Map<string, { start: number; count: number }>();
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(private readonly options: LimiterOptions) {
    this.now = options.now ?? Date.now;
    this.maxKeys = options.maxKeys ?? 5_000;
  }

  take(key: string): Take {
    const now = this.now();
    const entry = this.hits.get(key);
    if (!entry || now - entry.start >= this.options.windowMs) {
      if (!entry && this.hits.size >= this.maxKeys) {
        const oldest = this.hits.keys().next().value;
        if (oldest !== undefined) this.hits.delete(oldest);
      }
      this.hits.delete(key);
      this.hits.set(key, { start: now, count: 1 });
      return { ok: true };
    }
    if (entry.count >= this.options.limit) {
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.start + this.options.windowMs - now) / 1000)) };
    }
    entry.count += 1;
    return { ok: true };
  }

  get size(): number {
    return this.hits.size;
  }
}

/** A stable key for a caller, from the first address in X-Forwarded-For (set by the host). Hashed, so no address is held. */
export function callerKey(headers: { get(name: string): string | null }): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const raw = forwarded || headers.get("x-real-ip")?.trim() || "unknown";
  return createHash("sha256").update(raw.slice(0, 100)).digest("hex").slice(0, 24);
}

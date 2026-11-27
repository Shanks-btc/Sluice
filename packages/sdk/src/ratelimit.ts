// Rate limiting for the facilitator's HTTP face, and the rule for which address a request came from.
//
// A fixed window per key (an IP address, a payer address). It lives in memory: a restart starts the counts again, which is fine for
// a limit whose job is to stop a flood, and is why the caps that guard QIE and QUSDC (caps.ts) are kept in the journal instead.
// A service that runs as many short-lived copies keeps the counts in its database instead (RedisRateLimiter in redis.ts).

export type LimitResult = { ok: true } | { ok: false; retryAfterSeconds: number };

/** What a server asks before it serves a caller: this one in memory, or one that every copy of the server shares. */
export interface Limiter {
  hit(key: string): LimitResult | Promise<LimitResult>;
}

export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  /**
   * @param max      requests one key may make in a window
   * @param windowMs the length of a window
   * @param maxKeys  the most keys remembered; past it the oldest are forgotten, so a flood of new keys cannot grow memory
   */
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!Number.isInteger(max) || max <= 0) throw new Error("the rate limit must be a positive whole number");
    if (!Number.isInteger(windowMs) || windowMs <= 0) throw new Error("the rate-limit window must be a positive whole number of milliseconds");
  }

  hit(key: string): LimitResult {
    const t = this.now();
    const k = key.toLowerCase();
    const w = this.windows.get(k);
    if (!w || t - w.start >= this.windowMs) {
      if (!w && this.windows.size >= this.maxKeys) this.evict(t);
      this.windows.delete(k); // re-inserted below, so the map stays in order of window start
      this.windows.set(k, { start: t, count: 1 });
      return { ok: true };
    }
    if (w.count >= this.max) return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((w.start + this.windowMs - t) / 1000)) };
    w.count += 1;
    return { ok: true };
  }

  private evict(t: number): void {
    for (const [k, w] of this.windows) if (t - w.start >= this.windowMs) this.windows.delete(k);
    // Still full: every window is live. Drop the oldest tenth.
    if (this.windows.size >= this.maxKeys) {
      let drop = Math.max(1, Math.floor(this.maxKeys / 10));
      for (const k of this.windows.keys()) {
        this.windows.delete(k);
        if (--drop <= 0) break;
      }
    }
  }

  size(): number {
    return this.windows.size;
  }
}

/**
 * The address a request came from. With `trustedHops` at 0 that is the socket's own address, and the X-Forwarded-For header is
 * ignored, because anyone can send one. Behind a proxy that appends the address it saw (a VPS's nginx, Railway's edge), set
 * `trustedHops` to the number of such proxies: the address that many places from the right end of the header is the client's. A
 * header with fewer entries than that is not believed, and the socket address is used.
 */
export function clientAddress(socketAddress: string | undefined, forwardedFor: string | string[] | undefined, trustedHops: number): string {
  const socket = (socketAddress ?? "unknown").replace(/^::ffff:/, "");
  if (trustedHops <= 0) return socket;
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(",") : (forwardedFor ?? "");
  const parts = header.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length < trustedHops) return socket;
  const picked = (parts[parts.length - trustedHops] as string).replace(/^::ffff:/, "");
  return /^[0-9a-fA-F:.]{2,45}$/.test(picked) ? picked : socket;
}

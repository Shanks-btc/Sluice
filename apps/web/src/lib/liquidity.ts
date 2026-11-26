// How much QUSDC the QIEDEX pool holds, read from the chain just now, for the security page. A swap that is a large share of this moves the
// price, which is why it is shown next to the risks. Sluice itself does not swap: a refund or a withdrawal returns QUSDC from the router.
//
// It reads the pool's reserves with read-only calls (the same read the dex_quote example tool makes). A read that fails is said to have
// failed; no number is ever filled in. QIEDEX's address is known on QIE mainnet only.
import { formatUnits } from "ethers";
import { QIEDEX, dexQuote } from "@sluice/paid-tools/dexQuote";
import type { Rpc } from "@sluice/paid-tools/rpc";

export type Liquidity =
  | { ok: true; qusdcUnits: bigint; qusdc: string; pair: string; readAt: number }
  | { ok: false; reason: string };

/** The QUSDC side of the QUSDC / WQIE pool. `now` is in milliseconds. */
export async function readQusdcLiquidity(rpc: Rpc, now: () => number = Date.now): Promise<Liquidity> {
  try {
    const quote = await dexQuote(rpc, { tokenIn: QIEDEX.qusdc, tokenOut: "QIE", amountIn: "1" }, QIEDEX);
    const hop = quote.hops[0];
    if (!hop || quote.hops.length !== 1 || hop.tokenIn.toLowerCase() !== QIEDEX.qusdc.toLowerCase()) {
      return { ok: false, reason: "QIEDEX has no direct QUSDC pool to read." };
    }
    const units = BigInt(hop.reserveIn);
    return { ok: true, qusdcUnits: units, qusdc: Number(formatUnits(units, 6)).toLocaleString("en-US", { maximumFractionDigits: 2 }), pair: hop.pair, readAt: now() };
  } catch {
    return { ok: false, reason: "The pool could not be read just now." };
  }
}

/** Keeps a successful reading for `ttlMs`, so a page that many people open makes one read. A failure is not kept. */
export function cachedLiquidity(read: () => Promise<Liquidity>, ttlMs = 300_000, now: () => number = Date.now): () => Promise<Liquidity> {
  let held: { at: number; value: Liquidity } | undefined;
  return async () => {
    if (held && now() - held.at < ttlMs) return held.value;
    const value = await read();
    if (value.ok) held = { at: now(), value };
    return value;
  };
}

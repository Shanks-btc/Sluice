// dex_quote: what swapping a given size on QIEDEX would return right now, with slippage and price impact.
//
// QIEDEX is a Uniswap V2 layout on QIE (measured: the router's getAmountsOut equals the constant-product formula with a
// 0.3% fee). This reads the pool's reserves from the chain, computes the output itself, and compares it with the router's
// own answer, so a pool or router that behaves differently shows up as `matchesRouter: false` instead of a wrong quote.
// Read-only: it never sends a swap.
import { AbiCoder, Interface, getAddress, parseUnits, formatUnits } from "ethers";
import { selectorOf } from "./bytecode";
import { tryCall } from "./rpc";
import type { Rpc } from "./rpc";

/** QIEDEX on QIE mainnet, found and checked on 2026-11-19: the router's factory() and WETH() answer these. */
export const QIEDEX = {
  factory: "0x8E23128a5511223bE6c0d64106e2D4508C08398C",
  router: "0x08cd2e72e156D8563B4351eb4065C262A9f553Ef",
  wqie: "0x0087904D95BEe9E5F24dc8852804b547981A9139",
  qusdc: "0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5",
} as const;

export type DexConfig = { factory: string; router: string; wqie: string };

const coder = AbiCoder.defaultAbiCoder();
const factoryIface = new Interface(["function getPair(address,address) view returns (address)"]);
const pairIface = new Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)",
]);
const routerIface = new Interface(["function getAmountsOut(uint256,address[]) view returns (uint256[])"]);

/** The Uniswap V2 fee: 997 of every 1000 of the input counts. */
const FEE_NUMERATOR = 997n;
const FEE_DENOMINATOR = 1000n;

export function amountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const withFee = amountIn * FEE_NUMERATOR;
  return (withFee * reserveOut) / (reserveIn * FEE_DENOMINATOR + withFee);
}

export type Hop = {
  pair: string;
  tokenIn: string;
  tokenOut: string;
  reserveIn: string;
  reserveOut: string;
  amountIn: string;
  amountOut: string;
  /** How far this hop's output falls short of the pool's marginal rate (fee excluded from the comparison), in basis points. */
  priceImpactBps: number;
};

export type DexQuote = {
  tokenIn: { address: string; symbol?: string; decimals: number };
  tokenOut: { address: string; symbol?: string; decimals: number };
  amountIn: string;
  amountOut: string;
  amountOutUnits: string;
  minAmountOut: string;
  slippageBps: number;
  /** Shortfall against the pool's marginal rate, with the fee left out: how much the trade size itself moves the price. */
  priceImpactBps: number;
  /** Shortfall against the pool's fee-free spot price: price impact and the pool fee together. */
  costVsSpotBps: number;
  /** Tokens out per token in, as executed. */
  executionPrice: string;
  /** Tokens out per token in at the pool's current marginal price, with no fee. */
  spotPrice: string;
  feeBps: number;
  path: string[];
  hops: Hop[];
  matchesRouter: boolean;
  routerAmountOutUnits?: string;
  warnings: string[];
  note: string;
};

type Meta = { symbol?: string; decimals: number };

async function tokenMeta(rpc: Rpc, address: string): Promise<Meta | undefined> {
  const d = await tryCall(rpc, address, selectorOf("decimals()"));
  if (!d) return undefined;
  const decimals = Number(coder.decode(["uint8"], d)[0]);
  const s = await tryCall(rpc, address, selectorOf("symbol()"));
  let symbol: string | undefined;
  try {
    symbol = s ? (coder.decode(["string"], s)[0] as string) : undefined;
  } catch {
    symbol = undefined;
  }
  return { symbol, decimals };
}

async function pairFor(rpc: Rpc, cfg: DexConfig, a: string, b: string): Promise<string | undefined> {
  const out = await tryCall(rpc, cfg.factory, factoryIface.encodeFunctionData("getPair", [a, b]));
  if (!out) return undefined;
  const pair = getAddress(coder.decode(["address"], out)[0] as string);
  return /^0x0{40}$/.test(pair) ? undefined : pair;
}

async function reservesFor(rpc: Rpc, pair: string, tokenIn: string): Promise<{ reserveIn: bigint; reserveOut: bigint } | undefined> {
  const [t0, r] = await Promise.all([tryCall(rpc, pair, pairIface.encodeFunctionData("token0")), tryCall(rpc, pair, pairIface.encodeFunctionData("getReserves"))]);
  if (!t0 || !r) return undefined;
  const token0 = getAddress(coder.decode(["address"], t0)[0] as string);
  const [r0, r1] = coder.decode(["uint112", "uint112", "uint32"], r) as unknown as [bigint, bigint, bigint];
  return token0 === tokenIn ? { reserveIn: r0, reserveOut: r1 } : { reserveIn: r1, reserveOut: r0 };
}

const bps = (n: bigint) => Number(n);

export class DexQuoteError extends Error {}

/**
 * `tokenIn` and `tokenOut` are addresses, or "QIE" for the native coin (priced as WQIE, which is 1:1). `amountIn` is a
 * decimal in tokenIn's own units. The route is the direct pool, or through WQIE when there is none.
 */
export async function dexQuote(
  rpc: Rpc,
  input: { tokenIn: string; tokenOut: string; amountIn: string; slippageBps?: number },
  cfg: DexConfig = QIEDEX,
): Promise<DexQuote> {
  const resolve = (t: string) => (t.trim().toUpperCase() === "QIE" ? getAddress(cfg.wqie) : getAddress(t));
  const tokenIn = resolve(input.tokenIn);
  const tokenOut = resolve(input.tokenOut);
  if (tokenIn === tokenOut) throw new DexQuoteError("tokenIn and tokenOut are the same token");
  const slippageBps = input.slippageBps ?? 50;
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5000) throw new DexQuoteError("slippageBps must be a whole number from 0 to 5000");

  const [inMeta, outMeta] = await Promise.all([tokenMeta(rpc, tokenIn), tokenMeta(rpc, tokenOut)]);
  if (!inMeta) throw new DexQuoteError(`${tokenIn} is not a token (no decimals())`);
  if (!outMeta) throw new DexQuoteError(`${tokenOut} is not a token (no decimals())`);
  let amountInUnits: bigint;
  try {
    amountInUnits = parseUnits(input.amountIn, inMeta.decimals);
  } catch {
    throw new DexQuoteError(`amountIn must be a decimal with at most ${inMeta.decimals} places`);
  }
  if (amountInUnits <= 0n) throw new DexQuoteError("amountIn must be above zero");

  // Route: direct, or through WQIE.
  const wqie = getAddress(cfg.wqie);
  let path = [tokenIn, tokenOut];
  let pairs: string[] = [];
  const direct = await pairFor(rpc, cfg, tokenIn, tokenOut);
  if (direct) pairs = [direct];
  else if (tokenIn !== wqie && tokenOut !== wqie) {
    const a = await pairFor(rpc, cfg, tokenIn, wqie);
    const b = await pairFor(rpc, cfg, wqie, tokenOut);
    if (a && b) {
      path = [tokenIn, wqie, tokenOut];
      pairs = [a, b];
    }
  }
  if (pairs.length === 0) throw new DexQuoteError("QIEDEX has no pool for this pair, directly or through WQIE");

  // Walk the route with the pool formula, tracking the marginal (spot) price and the impact on each hop.
  const hops: Hop[] = [];
  let amount = amountInUnits;
  // Two running ratios across the hops: the fee-free spot rate, and the marginal rate after the fee.
  let spotN = 1n;
  let spotD = 1n;
  let marginN = 1n;
  let marginD = 1n;
  const warnings: string[] = [];
  for (let i = 0; i < pairs.length; i++) {
    const hopIn = path[i] as string;
    const hopOut = path[i + 1] as string;
    const r = await reservesFor(rpc, pairs[i] as string, hopIn);
    if (!r) throw new DexQuoteError("could not read a pool's reserves");
    const out = amountOut(amount, r.reserveIn, r.reserveOut);
    const idealOut = (amount * r.reserveOut * FEE_NUMERATOR) / (r.reserveIn * FEE_DENOMINATOR);
    const impact = idealOut > 0n ? ((idealOut - out) * 10_000n) / idealOut : 0n;
    hops.push({
      pair: pairs[i] as string,
      tokenIn: hopIn,
      tokenOut: hopOut,
      reserveIn: r.reserveIn.toString(),
      reserveOut: r.reserveOut.toString(),
      amountIn: amount.toString(),
      amountOut: out.toString(),
      priceImpactBps: bps(impact),
    });
    if (amount * 100n > r.reserveIn) warnings.push(`This trade is more than 1% of the pool's ${hopIn === tokenIn ? "input" : "intermediate"} reserve, so the price moves a lot.`);
    spotN *= r.reserveOut;
    spotD *= r.reserveIn;
    marginN *= r.reserveOut * FEE_NUMERATOR;
    marginD *= r.reserveIn * FEE_DENOMINATOR;
    amount = out;
  }
  const outUnits = amount;
  if (outUnits === 0n) throw new DexQuoteError("this amount would return zero");

  // Price impact: how far the output falls short of the marginal rate after the fee. Cost versus spot adds the fee.
  const idealMargin = (amountInUnits * marginN) / marginD;
  const impact = idealMargin > 0n ? ((idealMargin - outUnits) * 10_000n) / idealMargin : 0n;
  const idealSpot = (amountInUnits * spotN) / spotD;
  const costVsSpot = idealSpot > 0n ? ((idealSpot - outUnits) * 10_000n) / idealSpot : 0n;
  if (impact > 100n) warnings.push(`Price impact is ${Number(impact) / 100}%.`);
  const minOut = (outUnits * BigInt(10_000 - slippageBps)) / 10_000n;

  // Ask the router the same question.
  let routerOut: bigint | undefined;
  const routerRaw = await tryCall(rpc, cfg.router, routerIface.encodeFunctionData("getAmountsOut", [amountInUnits, path]));
  if (routerRaw) {
    const arr = routerIface.decodeFunctionResult("getAmountsOut", routerRaw)[0] as bigint[];
    routerOut = arr[arr.length - 1];
  }
  const matchesRouter = routerOut === outUnits;
  if (routerOut !== undefined && !matchesRouter) warnings.push("The router's own quote differs from the pool formula. Trust the router's number, and treat this quote as approximate.");
  if (routerOut === undefined) warnings.push("The router could not be asked, so the quote rests on the pool formula alone.");

  const decimalOut = formatUnits(outUnits, outMeta.decimals);
  const price = (num: bigint, den: bigint) => {
    // price of one tokenIn in tokenOut, 10 significant places, as a string
    const scaled = (num * 10n ** BigInt(inMeta.decimals + 10)) / (den * 10n ** BigInt(outMeta.decimals));
    return formatUnits(scaled, 10);
  };
  return {
    tokenIn: { address: tokenIn, ...(inMeta.symbol ? { symbol: inMeta.symbol } : {}), decimals: inMeta.decimals },
    tokenOut: { address: tokenOut, ...(outMeta.symbol ? { symbol: outMeta.symbol } : {}), decimals: outMeta.decimals },
    amountIn: input.amountIn,
    amountOut: decimalOut,
    amountOutUnits: outUnits.toString(),
    minAmountOut: formatUnits(minOut, outMeta.decimals),
    slippageBps,
    priceImpactBps: bps(impact),
    costVsSpotBps: bps(costVsSpot),
    executionPrice: price(outUnits, amountInUnits),
    spotPrice: price(spotN, spotD),
    feeBps: Number(((FEE_DENOMINATOR - FEE_NUMERATOR) * 10_000n) / FEE_DENOMINATOR),
    path,
    hops,
    matchesRouter,
    ...(routerOut === undefined ? {} : { routerAmountOutUnits: routerOut.toString() }),
    warnings,
    note: "Read from the chain at the latest block. A swap sent later can get a different price. minAmountOut is the output at the stated slippage tolerance: a swap that returns less should be refused.",
  };
}

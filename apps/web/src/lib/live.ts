// Small pieces of the live demo and the builder's test call that are plain logic: what to read for the balances, the cap on how much a
// session may hold, and the arguments a tool call is made with. Kept apart from the components so each rule has a test.
import { formatUsdc } from "./format";
import type { ChainReader } from "./reads";

export type Balances = { qusdc: bigint; prepaid: bigint; qie: bigint; allowance: bigint };

/** The four numbers the live pages show and plan from: QUSDC in the wallet, prepaid in the router, QIE for gas, and the router's allowance. */
export async function readBalances(reader: ChainReader, account: string): Promise<Balances> {
  const [qusdc, prepaid, qie, allowance] = await Promise.all([
    reader.token.getFunction("balanceOf")(account) as Promise<bigint>,
    reader.router.getFunction("payerBalance")(account) as Promise<bigint>,
    reader.provider.getBalance(account),
    reader.token.getFunction("allowance")(account, reader.routerAddress) as Promise<bigint>,
  ]);
  return { qusdc, prepaid, qie, allowance };
}

/**
 * The limit on how much the live pages will put in: one deposit may not pass the cap, and the prepaid balance after it may not either.
 * The contracts have no such limit; this is the page's own, so that a first try with real money stays small.
 */
export function checkDepositCap(amount: bigint, prepaid: bigint, capUnits: number): string | undefined {
  const cap = BigInt(capUnits);
  if (amount > cap) return `This page lets one session deposit at most ${formatUsdc(cap)} QUSDC. Enter ${formatUsdc(cap)} or less.`;
  if (prepaid + amount > cap) {
    const room = cap > prepaid ? cap - prepaid : 0n;
    return room === 0n
      ? `This page keeps the prepaid balance at or below ${formatUsdc(cap)} QUSDC, and yours is ${formatUsdc(prepaid)}. Use it, or take some back, before depositing more.`
      : `This page keeps the prepaid balance at or below ${formatUsdc(cap)} QUSDC, and yours is ${formatUsdc(prepaid)}, so you can add up to ${formatUsdc(room)} more.`;
  }
  return undefined;
}

/** The arguments a tool takes, as text to start from: an address for the two tools that read one, the example amounts for a quote. */
export function defaultArgs(tool: string, tokenAddress: string): string {
  if (tool === "dex_quote") return JSON.stringify({ tokenIn: "QIE", tokenOut: tokenAddress, amountIn: "1" });
  return JSON.stringify({ address: tokenAddress });
}

export const MAX_ARGS_CHARS = 2_000;

export type ArgsResult = { ok: true; args: Record<string, string | number | boolean> } | { ok: false; reason: string };

/** What the person typed as a tool's arguments: one flat JSON object of short strings, numbers and booleans, and nothing else. */
export function parseToolArgs(text: string): ArgsResult {
  const t = text.trim();
  if (t === "") return { ok: true, args: {} };
  if (t.length > MAX_ARGS_CHARS) return { ok: false, reason: `The arguments are longer than ${MAX_ARGS_CHARS} characters.` };
  let value: unknown;
  try {
    value = JSON.parse(t);
  } catch {
    return { ok: false, reason: 'The arguments must be JSON, like {"address":"0x…"}.' };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, reason: "The arguments must be one JSON object." };
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 10) return { ok: false, reason: "A call takes at most ten arguments." };
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(k)) return { ok: false, reason: `"${k.slice(0, 20)}" is not a valid argument name.` };
    if (typeof v === "string") {
      if (v.length > 200) return { ok: false, reason: `The value of "${k}" is longer than 200 characters.` };
      out[k] = v;
    } else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "boolean") out[k] = v;
    else return { ok: false, reason: `The value of "${k}" must be a string, a number or true or false.` };
  }
  return { ok: true, args: out };
}

/** A tool's answer as text for the page: pretty JSON, cut at `max` characters. Shown as text, never as markup. */
export function showOutput(output: unknown, max = 3_000): string {
  const text = typeof output === "string" ? output : JSON.stringify(output, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters not shown)` : text;
}

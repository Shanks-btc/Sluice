// Amounts, addresses and times, shown the same way everywhere. QUSDC has 6 decimals and QIE has 18.
import { formatQusdc, parseQusdc } from "@sluice/sdk/protocol";

export const QUSDC_UNIT = 1_000_000n;

/** 1234567n -> "1.234567". Always six decimals, so a column lines up. */
export const formatUsdc = (units: bigint): string => formatQusdc(units);

export function formatQie(wei: bigint, places = 6): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, "0").slice(0, places);
  return `${whole}.${frac}`;
}

export function formatGwei(wei: bigint): string {
  const whole = wei / 1_000_000_000n;
  const frac = (wei % 1_000_000_000n).toString().padStart(9, "0").slice(0, 3);
  return `${whole}.${frac}`;
}

export function shortAddress(address: string): string {
  return /^0x[0-9a-fA-F]{40}$/.test(address) ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

export function shortHash(hash: string): string {
  return /^0x[0-9a-fA-F]{64}$/.test(hash) ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : hash;
}

/** Unix seconds -> "2026-12-01 10:00:00 UTC". */
export function formatUtc(seconds: number | bigint): string {
  const ms = Number(seconds) * 1000;
  if (!Number.isFinite(ms)) return "unknown";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "unknown";
  return `${d.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

export type AmountResult = { ok: true; units: bigint } | { ok: false; reason: string };

/**
 * A QUSDC amount typed by a person. Plain decimals only: digits, an optional point and at most six places. No sign, no exponent, no
 * separators, and not zero. `max` is a limit in units (a balance, say) that the amount may not pass.
 */
export function parseAmountInput(text: string, max?: bigint): AmountResult {
  const t = text.trim();
  if (t === "") return { ok: false, reason: "Enter an amount." };
  if (!/^\d{1,12}(\.\d{1,6})?$/.test(t)) {
    return { ok: false, reason: "Use digits with at most six decimal places, like 12.5." };
  }
  let units: bigint;
  try {
    units = parseQusdc(t);
  } catch {
    // The SDK refuses a price of zero by throwing; here that is a message.
    return { ok: false, reason: "The amount must be above zero." };
  }
  if (units <= 0n) return { ok: false, reason: "The amount must be above zero." };
  if (max !== undefined && units > max) return { ok: false, reason: `That is more than the ${formatUsdc(max)} available.` };
  return { ok: true, units };
}

export const isAddress = (text: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(text.trim());

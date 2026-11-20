// QUSDC has 6 decimals. Amounts in docs are written as exact decimals with six places, like "0.010000".

export const QUSDC_DECIMALS = 6;
const SCALE = 10n ** BigInt(QUSDC_DECIMALS);

/** 10000n -> "0.010000". */
export function formatQusdc(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / SCALE;
  const frac = (abs % SCALE).toString().padStart(QUSDC_DECIMALS, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/** "0.010000" -> 10000n. Accepts only an exact decimal with six places. */
export function parseQusdc(text: string): bigint {
  const match = /^(\d+)\.(\d{6})$/.exec(text.trim());
  if (!match) throw new Error(`not an exact QUSDC amount with six decimals: ${JSON.stringify(text)}`);
  return BigInt(match[1] as string) * SCALE + BigInt(match[2] as string);
}

// Hard caps. These are constants in code, not settings: a configuration can lower a cap, never raise it above
// its ceiling, and a request to exceed a ceiling is refused when the service starts.
//
// The ceilings come from measurements in docs/GAS.md and docs/PREBUILD-VERIFICATION.md: a batch of 50 intents
// from different payers to different builders used 3,291,239 gas; QIE's gas price was 1.125 gwei; the first
// approve and deposit together can use about 160,000 gas; the relayer was designed to hold at most about 1 QIE.

export type Caps = {
  /** Gas limit for any one transaction the relayer signs. */
  gasLimitPerTx: bigint;
  /** The highest gas price, in wei, the relayer will pay. Above it the relayer waits. */
  maxGasPriceWei: bigint;
  /** QIE the relayer may spend per UTC day, gas and top-ups together. */
  dailyBudgetWei: bigint;
  /** Intents in one batchSettle. */
  maxBatchSize: number;
  /** The most QIE the relayer will send to a wallet for the zero-QIE start, in one top-up. */
  maxTopUpWei: bigint;
  /** The most QIE the relayer will send to one address in a UTC day, all of its top-ups together. */
  topUpPerAddressDailyWei: bigint;
  /** The most QUSDC, in units, one zero-QIE start may deposit. */
  maxOnboardAmount: bigint;
  /** Intents one payer may have queued per UTC day. */
  payerDailyIntents: number;
  /** QUSDC units one payer may have queued per UTC day. */
  payerDailyAmount: bigint;
  /** Intents all payers together may have queued per UTC day. */
  globalDailyIntents: number;
  /** QUSDC units all payers together may have queued per UTC day. */
  globalDailyAmount: bigint;
  /** Zero-QIE starts one payer may use per UTC day. */
  onboardPerPayerPerDay: number;
  /** Relayed withdrawals and refunds one account may use per UTC day. */
  relayPerAccountPerDay: number;
};

const QIE = 10n ** 18n;
const USDC = 10n ** 6n;

/** The ceilings. Nothing in a configuration can exceed these. */
export const HARD_CAPS: Readonly<Caps> = Object.freeze({
  gasLimitPerTx: 4_000_000n,
  maxGasPriceWei: 5_000_000_000n,
  dailyBudgetWei: 2n * QIE,
  maxBatchSize: 50,
  maxTopUpWei: 1_500_000_000_000_000n, // 0.0015 QIE
  topUpPerAddressDailyWei: 3_000_000_000_000_000n, // 0.003 QIE
  maxOnboardAmount: 100n * USDC,
  payerDailyIntents: 20_000,
  payerDailyAmount: 1_000n * USDC,
  globalDailyIntents: 200_000,
  globalDailyAmount: 10_000n * USDC,
  onboardPerPayerPerDay: 3,
  relayPerAccountPerDay: 10,
});

/** The values used when nothing is configured. Every one is at or below its ceiling. */
export const DEFAULT_CAPS: Readonly<Caps> = Object.freeze({
  gasLimitPerTx: 4_000_000n,
  maxGasPriceWei: 2_000_000_000n,
  dailyBudgetWei: QIE / 2n,
  maxBatchSize: 50,
  maxTopUpWei: 1_000_000_000_000_000n, // 0.001 QIE
  topUpPerAddressDailyWei: 1_000_000_000_000_000n, // 0.001 QIE: one top-up of the default size per address per day
  maxOnboardAmount: 10n * USDC,
  payerDailyIntents: 2_000,
  payerDailyAmount: 50n * USDC,
  globalDailyIntents: 20_000,
  globalDailyAmount: 500n * USDC,
  onboardPerPayerPerDay: 1,
  relayPerAccountPerDay: 3,
});

export class CapConfigError extends Error {}

/** Applies a configuration on top of the defaults. Throws if any value is above its ceiling or not positive. */
export function resolveCaps(requested: Partial<Caps> = {}): Caps {
  const caps: Caps = { ...DEFAULT_CAPS, ...requested };
  for (const key of Object.keys(HARD_CAPS) as Array<keyof Caps>) {
    const value = caps[key];
    const ceiling = HARD_CAPS[key];
    if (typeof value === "bigint" ? value <= 0n : !(value > 0)) throw new CapConfigError(`${key} must be above zero`);
    if (value > ceiling) throw new CapConfigError(`${key} is above its hard ceiling of ${String(ceiling)}`);
  }
  return caps;
}

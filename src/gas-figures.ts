// The gas each operation used when it was measured on a fork of QIE mainnet, copied from docs/GAS.md (a test holds this file to that
// document, so the two cannot drift). The funding plan, the pre-flight check and the dry-run all budget from these numbers.
//
// They are measurements, not promises: on the live chain the gas can differ a little with the state it meets.

export const MEASURED_GAS = {
  deployRouter: 3_158_652n,
  approve: 46_973n,
  depositFirst: 112_937n,
  settleFirst: 110_078n,
  authorize: 119_499n,
  settleByAgentFirst: 93_204n,
  revoke: 27_315n,
  withdraw: 71_538n,
  refund: 54_477n,
  topUpTransfer: 21_000n,
  /** A batch of 50 intents, each from a different payer to a different builder: the most expensive batch measured. */
  batch50Worst: 3_291_319n,
} as const;

/** The eight transactions of scripts/live/smoke.ts, with the gas each used when measured. */
export const SMOKE_STEPS_GAS: ReadonlyArray<readonly [string, bigint]> = [
  ["approve", MEASURED_GAS.approve],
  ["deposit", MEASURED_GAS.depositFirst],
  ["settle (payer-signed)", MEASURED_GAS.settleFirst],
  ["authorize agent", MEASURED_GAS.authorize],
  ["settle (agent-signed)", MEASURED_GAS.settleByAgentFirst],
  ["revoke agent", MEASURED_GAS.revoke],
  ["withdraw", MEASURED_GAS.withdraw],
  ["refund", MEASURED_GAS.refund],
];

export const SMOKE_GAS_TOTAL = SMOKE_STEPS_GAS.reduce((sum, [, gas]) => sum + gas, 0n);

/** The QIE a number of gas units costs at a gas price, in wei, with a margin of `marginPercent` percent on top. */
export const costWei = (gas: bigint, gasPrice: bigint, marginPercent = 0n): bigint => (gas * gasPrice * (100n + marginPercent)) / 100n;

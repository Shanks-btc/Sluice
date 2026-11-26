// The funding calculator: how much QIE each address needs for the mainnet deploy, the smoke run and the funded run, and what buying QUSDC
// from QIEDEX's pool would cost at three sizes. Read-only: it reads the gas price, the block and the pool's reserves (and balances, if it
// is given addresses), and prints the block and the time it read them at. It reads no price in dollars, so it states none.
//
// The gas figures are the ones measured on a fork and listed in docs/GAS.md (src/gas-figures.ts is held to that document by a test), at the
// gas price just read, with a margin on top (3x by default). The pool maths is Uniswap V2's with its 0.3% fee, the layout QIEDEX has (the
// dex_quote tool measured that the router's answers equal this formula); the calculator also asks the router, and says so if they differ.
import { AbiCoder, Interface, getAddress, toQuantity } from "ethers";
import { ONBOARD_APPROVE_GAS, ONBOARD_DEPOSIT_GAS } from "@sluice/sdk";
import { QIEDEX } from "../examples/paid-tools/src/dexQuote";
import type { Rpc } from "./evidence";
import { MEASURED_GAS, SMOKE_GAS_TOTAL, costWei } from "./gas-figures";
import { formatQie } from "./guard";
import { DEFAULT_SMOKE_AMOUNTS } from "./live";
import { RpcRefused } from "./readrpc";
import { formatQusdc } from "./units";

/** Every method the calculator may call. */
export const FUNDING_READ_ONLY_METHODS: ReadonlySet<string> = new Set(["eth_chainId", "eth_blockNumber", "eth_gasPrice", "eth_getBalance", "eth_call", "eth_getBlockByNumber"]);

export const DEFAULT_RUN_QUSDC = 10_000_000n; // 10 QUSDC
export const DEFAULT_MARGIN = 3n;
/** The relayer's QIE budget for a day, when SLUICE_MAX_QIE is not set: below it, the facilitator's /health reports a low balance. */
export const DEFAULT_DAILY_BUDGET_WEI = 5n * 10n ** 17n; // 0.5 QIE
/** The sizes of QUSDC whose purchase from the pool is priced. */
export const PRICED_SIZES: readonly bigint[] = [10_000_000n, 25_000_000n, 100_000_000n];

const QIE = 10n ** 18n;

// ------------------------------------------------------------------------------------------------------------------- the pool maths

export type Reserves = { pair: string; qusdc: bigint; wqie: bigint };

/**
 * The QIE (as WQIE, which is 1:1) to put in to take `out` QUSDC from the pool: Uniswap V2's getAmountIn,
 * `floor(reserveIn * out * 1000 / ((reserveOut - out) * 997)) + 1`. Undefined when the pool cannot supply `out`.
 */
export function amountIn(out: bigint, reserveIn: bigint, reserveOut: bigint): bigint | undefined {
  if (out <= 0n || reserveIn <= 0n || reserveOut <= 0n || out >= reserveOut) return undefined;
  return (reserveIn * out * 1000n) / ((reserveOut - out) * 997n) + 1n;
}

export type Purchase = {
  qusdc: bigint;
  /** WQIE (QIE) to put in; undefined if the pool cannot supply that much. */
  qieIn?: bigint;
  /** How much dearer than the pool's marginal price this is, with the 0.3% fee counted, in basis points. */
  costVsSpotBps?: bigint;
  /** The share of the pool's QUSDC this takes, in basis points. */
  poolShareBps?: bigint;
};

export function purchase(out: bigint, r: Reserves): Purchase {
  const qieIn = amountIn(out, r.wqie, r.qusdc);
  if (qieIn === undefined) return { qusdc: out };
  // The marginal price is reserveIn / reserveOut QIE for each QUSDC, so `out` QUSDC at that price costs out * reserveIn / reserveOut.
  const costVsSpotBps = (qieIn * r.qusdc * 10_000n) / (out * r.wqie) - 10_000n;
  return { qusdc: out, qieIn, costVsSpotBps, poolShareBps: (out * 10_000n) / r.qusdc };
}

// ------------------------------------------------------------------------------------------------------------------- the plan

export type PlanInput = {
  gasPrice: bigint;
  /** The funded run's size in QUSDC units (the owner's deposit and spend). */
  runQusdc: bigint;
  margin: bigint;
  dailyBudgetWei: bigint;
};

export type FundingPlan = {
  margin: bigint;
  deployerGas: bigint;
  /** What the deployer needs for the deploy and the smoke run, at the gas price, times the margin. */
  deployerQieWei: bigint;
  /** The smoke run's deposit: the QUSDC the deployer key must hold. */
  deployerQusdc: bigint;
  /** Gas the relayer pays across the funded run, by step. */
  relayerSteps: ReadonlyArray<readonly [string, bigint]>;
  relayerGas: bigint;
  /** The QIE the facilitator sends the zero-QIE owner so that the owner's two signed transactions can be paid for. */
  relayerTopUpWei: bigint;
  relayerRunQieWei: bigint;
  /** Five of the largest batches measured: the pre-flight check's floor. */
  relayerFloorWei: bigint;
  /** What to hold: the largest of the run's need, the floor and a day's budget. */
  relayerHoldWei: bigint;
  ownerQusdc: bigint;
  /** All the QUSDC to acquire: the owner's and the deployer's. */
  totalQusdc: bigint;
};

export function planFunding(p: PlanInput): FundingPlan {
  const deployerGas = MEASURED_GAS.deployRouter + SMOKE_GAS_TOTAL;
  // The funded run through a facilitator, for an owner with no QIE: the top-up transfer, the agent's authorisation by signature, one batch
  // of up to ten intents (the dearest ten measured: each from a different payer to a different builder), and a builder's withdrawal and the
  // owner's refund, each by signature.
  const relayerSteps: ReadonlyArray<readonly [string, bigint]> = [
    ["QIE top-up transfer to the owner", MEASURED_GAS.topUpTransfer],
    ["authorize the agent by signature", MEASURED_GAS.authorizeBySig],
    ["settle a batch of up to 10 intents (3 paid calls on 2 tools fit well inside)", MEASURED_GAS.batch10Worst],
    ["withdraw the builder's earnings by signature", MEASURED_GAS.withdrawBySig],
    ["refund the owner's unspent balance by signature", MEASURED_GAS.refundBySig],
  ];
  const relayerGas = relayerSteps.reduce((sum, [, gas]) => sum + gas, 0n);
  // The two transactions the owner signs are sent by the facilitator after it tops the owner up with the QIE their gas limits can use, at a
  // price a tenth above the network's (what pnpm client:owner signs with).
  const relayerTopUpWei = costWei(ONBOARD_APPROVE_GAS + ONBOARD_DEPOSIT_GAS, p.gasPrice, 10n);
  const relayerRunQieWei = costWei(relayerGas, p.gasPrice, (p.margin - 1n) * 100n) + relayerTopUpWei * p.margin;
  const relayerFloorWei = costWei(MEASURED_GAS.batch50Worst * 5n, p.gasPrice);
  const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);
  const deployerQusdc = DEFAULT_SMOKE_AMOUNTS.deposit;
  return {
    margin: p.margin,
    deployerGas,
    deployerQieWei: costWei(deployerGas, p.gasPrice, (p.margin - 1n) * 100n),
    deployerQusdc,
    relayerSteps,
    relayerGas,
    relayerTopUpWei,
    relayerRunQieWei,
    relayerFloorWei,
    relayerHoldWei: max(relayerRunQieWei, max(relayerFloorWei, p.dailyBudgetWei)),
    ownerQusdc: p.runQusdc,
    totalQusdc: p.runQusdc + deployerQusdc,
  };
}

// ------------------------------------------------------------------------------------------------------------------- reading

export type FundingReads = {
  chainId: number;
  block: number;
  /** The block's time, in seconds since 1970. */
  timestamp: number;
  gasPrice: bigint;
  /** Undefined when the pool could not be read: nothing is then priced, and nothing is guessed. */
  reserves?: Reserves;
  /** What QIEDEX's own router says for each priced size, to check the formula against. */
  routerIn?: ReadonlyMap<bigint, bigint>;
  /** QIE and QUSDC held by the addresses given, if any. */
  balances: Array<{ label: string; address: string; qieWei: bigint; qusdc: bigint }>;
};

const coder = AbiCoder.defaultAbiCoder();
const factory = new Interface(["function getPair(address,address) view returns (address)"]);
const pairIface = new Interface(["function token0() view returns (address)", "function getReserves() view returns (uint112,uint112,uint32)"]);
const dexRouter = new Interface(["function getAmountsIn(uint256,address[]) view returns (uint256[])"]);
const erc20 = new Interface(["function balanceOf(address) view returns (uint256)"]);

async function ask(rpc: Rpc, to: string, data: string, block: string): Promise<string | undefined> {
  try {
    const out = await rpc("eth_call", [{ to, data }, block]);
    return typeof out === "string" && out !== "0x" ? out : undefined;
  } catch (err) {
    if (err instanceof RpcRefused) return undefined;
    throw err;
  }
}

/** Reads everything at one block. Throws only when the chain cannot be read; an unreadable pool is reported as absent. */
export async function readFundingInputs(rpc: Rpc, addresses: ReadonlyArray<{ label: string; address: string }> = [], sizes: readonly bigint[] = PRICED_SIZES): Promise<FundingReads> {
  const chainId = Number(BigInt(String(await rpc("eth_chainId", []))));
  const head = (await rpc("eth_getBlockByNumber", ["latest", false])) as { number: string; timestamp: string } | null;
  if (!head) throw new Error("the latest block could not be read");
  const block = Number(BigInt(head.number));
  const at = toQuantity(block);
  const gasPrice = BigInt(String(await rpc("eth_gasPrice", [])));

  let reserves: Reserves | undefined;
  let routerIn: Map<bigint, bigint> | undefined;
  const pairOut = await ask(rpc, QIEDEX.factory, factory.encodeFunctionData("getPair", [QIEDEX.qusdc, QIEDEX.wqie]), at);
  if (pairOut) {
    const pair = getAddress(String(coder.decode(["address"], pairOut)[0]));
    const [t0, r] = await Promise.all([ask(rpc, pair, pairIface.encodeFunctionData("token0"), at), ask(rpc, pair, pairIface.encodeFunctionData("getReserves"), at)]);
    if (!/^0x0{40}$/.test(pair) && t0 && r) {
      const token0 = getAddress(String(coder.decode(["address"], t0)[0]));
      const [r0, r1] = coder.decode(["uint112", "uint112", "uint32"], r) as unknown as [bigint, bigint, bigint];
      reserves = token0 === getAddress(QIEDEX.qusdc) ? { pair, qusdc: r0, wqie: r1 } : { pair, qusdc: r1, wqie: r0 };
      routerIn = new Map();
      for (const size of sizes) {
        const raw = await ask(rpc, QIEDEX.router, dexRouter.encodeFunctionData("getAmountsIn", [size, [QIEDEX.wqie, QIEDEX.qusdc]]), at);
        if (!raw) continue;
        const arr = dexRouter.decodeFunctionResult("getAmountsIn", raw)[0] as bigint[];
        if (arr[0] !== undefined) routerIn.set(size, arr[0]);
      }
    }
  }

  const balances: FundingReads["balances"] = [];
  for (const a of addresses) {
    const qieWei = BigInt(String(await rpc("eth_getBalance", [getAddress(a.address), at])));
    const raw = await ask(rpc, QIEDEX.qusdc, erc20.encodeFunctionData("balanceOf", [getAddress(a.address)]), at);
    balances.push({ label: a.label, address: getAddress(a.address), qieWei, qusdc: raw ? (erc20.decodeFunctionResult("balanceOf", raw)[0] as bigint) : 0n });
  }
  return { chainId, block, timestamp: Number(BigInt(head.timestamp)), gasPrice, ...(reserves ? { reserves } : {}), ...(routerIn ? { routerIn } : {}), balances };
}

// ------------------------------------------------------------------------------------------------------------------- printing

/** QIE as a decimal rounded UP to six places, so a need is never printed lower than it is. */
export function ceilQie(wei: bigint, places = 6): string {
  const unit = 10n ** BigInt(18 - places);
  const up = ((wei + unit - 1n) / unit) * unit;
  const whole = up / QIE;
  const frac = (up % QIE).toString().padStart(18, "0").slice(0, places);
  return `${whole}.${frac}`;
}

const gwei = (wei: bigint): string => {
  const whole = wei / 10n ** 9n;
  const frac = (wei % 10n ** 9n).toString().padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
};
const percent = (bps: bigint): string => `${bps / 100n}.${(bps % 100n).toString().padStart(2, "0")}%`;
const isoTime = (seconds: number): string => new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
const count = (n: bigint): string => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export type FormatOptions = { runQusdc: bigint; margin: bigint; dailyBudgetWei: bigint };

/** The lines the command prints. Every number in them is computed from `reads`; none is typed in. */
export function formatFunding(reads: FundingReads, o: FormatOptions): string[] {
  const plan = planFunding({ gasPrice: reads.gasPrice, runQusdc: o.runQusdc, margin: o.margin, dailyBudgetWei: o.dailyBudgetWei });
  const out: string[] = [];
  const bal = (label: string) => reads.balances.find((b) => b.label === label);
  const shortfall = (need: bigint, have: bigint): string => (have >= need ? "enough already" : `send at least ${ceilQie(need - have)} more`);

  out.push(`Funding for mainnet (chain ${reads.chainId}), read from QIE at block ${reads.block}, ${isoTime(reads.timestamp)} UTC. Gas price ${gwei(reads.gasPrice)} gwei.`);
  out.push("Read-only: nothing is sent. No dollar price is read or used, so none is given. Gas figures are the ones measured on a fork (docs/GAS.md), times a margin of " + `${plan.margin}x.`);
  out.push("");
  out.push("(a) QIE for each address");
  const dep = bal("deployer");
  out.push(`  Deployer${dep ? ` ${dep.address}` : ""}`);
  out.push(`    needs ${ceilQie(plan.deployerQieWei)} QIE: deploy ${count(MEASURED_GAS.deployRouter)} + smoke run ${count(SMOKE_GAS_TOTAL)} = ${count(plan.deployerGas)} gas x ${gwei(reads.gasPrice)} gwei x ${plan.margin}`);
  if (dep) out.push(`    holds ${ceilQie(dep.qieWei)} QIE and ${formatQusdc(dep.qusdc)} QUSDC: ${shortfall(plan.deployerQieWei, dep.qieWei)}`);
  out.push(`    needs ${formatQusdc(plan.deployerQusdc)} QUSDC for the smoke run's deposit (it takes back all but the 1% fee on 0.15)${dep ? `: ${dep.qusdc >= plan.deployerQusdc ? "enough already" : `send at least ${formatQusdc(plan.deployerQusdc - dep.qusdc)} QUSDC more`}` : ""}`);
  const rel = bal("relayer");
  out.push(`  Relayer${rel ? ` ${rel.address}` : ""}`);
  for (const [step, gas] of plan.relayerSteps) out.push(`    ${count(gas).padStart(9)} gas  ${step}`);
  out.push(`    ${count(plan.relayerGas).padStart(9)} gas in all x ${gwei(reads.gasPrice)} gwei x ${plan.margin}, plus the top-up of ${ceilQie(plan.relayerTopUpWei)} QIE sent to the owner (x ${plan.margin}) = ${ceilQie(plan.relayerRunQieWei)} QIE for the funded run`);
  out.push(`    to hold: ${ceilQie(plan.relayerHoldWei)} QIE, the largest of the run's need, five of the largest batches (${ceilQie(plan.relayerFloorWei)}, the pre-flight floor) and a day's budget (${formatQie(o.dailyBudgetWei)}, below which /health reports a low balance)`);
  if (rel) out.push(`    holds ${ceilQie(rel.qieWei)} QIE: ${shortfall(plan.relayerHoldWei, rel.qieWei)}`);
  out.push(`  Owner of the funded run (starts with no QIE, so the facilitator pays): no QIE needed`);
  out.push("");
  out.push(`(b) QUSDC: ${formatQusdc(plan.ownerQusdc)} for the owner's funded run (the cap is ${formatQusdc(o.runQusdc)} unless SLUICE_MAX_QUSDC is set) and ${formatQusdc(plan.deployerQusdc)} for the deployer's smoke run = ${formatQusdc(plan.totalQusdc)} QUSDC`);
  let poolQie: bigint | undefined;
  if (!reads.reserves) {
    out.push("  QIEDEX's QUSDC/WQIE pool could not be read at this block, so nothing is priced and nothing is guessed. Get QUSDC another way, or run this again.");
  } else {
    const r = reads.reserves;
    out.push(`  QIEDEX pool ${r.pair}: ${formatQusdc(r.qusdc)} QUSDC and ${ceilQie(r.wqie)} WQIE in its reserves at block ${reads.block}`);
    out.push("  Buying QUSDC from it with QIE (QIE in; price paid per QUSDC; how much dearer than the pool's own price at its current balance; share of the pool's QUSDC taken):");
    const sizes = [...new Set([...PRICED_SIZES, plan.totalQusdc])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const size of sizes) {
      const p = purchase(size, r);
      if (p.qieIn === undefined) {
        out.push(`    ${formatQusdc(size).padStart(11)} QUSDC: the pool cannot supply that much`);
        continue;
      }
      const router = reads.routerIn?.get(size);
      const note = router === undefined ? "" : router === p.qieIn ? "; the pool's own router gives the same figure" : `; the pool's own router gives ${ceilQie(router)} QIE, which differs from this formula: trust the router`;
      out.push(`    ${formatQusdc(size).padStart(11)} QUSDC: ${ceilQie(p.qieIn)} QIE in; ${ceilQie((p.qieIn * 1_000_000n) / size, 6)} QIE per QUSDC; ${percent(p.costVsSpotBps ?? 0n)} above the pool's price; ${percent(p.poolShareBps ?? 0n)} of the pool${note}`);
      if (size === plan.totalQusdc) poolQie = router ?? p.qieIn;
    }
    out.push("  Formula: QIE in = floor(reserveQIE x out x 1000 / ((reserveQUSDC - out) x 997)) + 1, the constant-product rule with a 0.3% fee. Above the pool's price = QIE in / (out x reserveQIE / reserveQUSDC) - 1.");
  }
  out.push("");
  if (poolQie !== undefined) {
    const total = plan.deployerQieWei + plan.relayerHoldWei + poolQie;
    out.push(`TOTAL: ${ceilQie(plan.deployerQieWei)} QIE to the deployer + ${ceilQie(plan.relayerHoldWei)} QIE to the relayer + ${ceilQie(poolQie)} QIE to buy ${formatQusdc(plan.totalQusdc)} QUSDC from the pool = ${ceilQie(total)} QIE, before any QIE you keep for your own wallet.`);
  } else {
    out.push(`TOTAL QIE for gas: ${ceilQie(plan.deployerQieWei + plan.relayerHoldWei)} QIE (${ceilQie(plan.deployerQieWei)} to the deployer + ${ceilQie(plan.relayerHoldWei)} to the relayer), plus ${formatQusdc(plan.totalQusdc)} QUSDC, which is not priced because the pool was not read.`);
  }
  return out;
}

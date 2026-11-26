// The gate every script in scripts/live/ passes before it touches a network.
//
// A live script refuses to start unless ALL of these hold:
//   1. SLUICE_NETWORK is "mainnet" or "testnet" (there is no default, so no script runs by accident)
//   2. SLUICE_APPROVE equals the script's own name (approving "deploy" does not approve "smoke")
//   3. the caps are valid: SLUICE_MAX_QUSDC (default 10) and SLUICE_MAX_QIE (default 5), and neither
//      is above the hard ceiling (100 QUSDC, 50 QIE) that only an edit to this file can change
//   4. the script's own worst-case plan fits inside both caps
//   5. SLUICE_KEY is present and shaped like a private key
//   6. the RPC is https (plain http only for the local machine)
//
// Messages never contain the key or any other secret. The approval object hides the key behind a function so
// that logging or serialising the approval cannot print it.
import { NETWORKS } from "./evidence";
import type { Network } from "./evidence";
import { formatQusdc } from "./units";

/** QUSDC on QIE mainnet. Six decimals. */
export const QUSDC_ADDRESS = "0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5";

const QIE = 10n ** 18n;
export const DEFAULT_MAX_QUSDC = 10_000_000n; // 10 QUSDC
export const DEFAULT_MAX_QIE_WEI = 5n * QIE; // 5 QIE
export const CEILING_QUSDC = 100_000_000n; // 100 QUSDC
export const CEILING_QIE_WEI = 50n * QIE; // 50 QIE
/** A gas price above this makes a script stop rather than pay it. QIE's price is about 1.125 gwei. */
export const MAX_GAS_PRICE_WEI = 50_000_000_000n; // 50 gwei

export class GuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardError";
  }
}

export type Caps = {
  maxQusdc: bigint;
  maxQieWei: bigint;
  /** The most QIE any one transaction may cost, at its gas limit and gas price. Optional: set by SLUICE_MAX_TX_QIE. */
  maxTxQieWei?: bigint;
};

/** What a script says it may spend, at worst. QUSDC leaves the signer's wallet; QIE is gas. */
export type Plan = { qusdc: bigint; qieWei: bigint; summary: string };

export type Approval = {
  script: string;
  network: Network;
  chainId: number;
  rpcUrl: string;
  caps: Caps;
  /** The private key. A function, so that printing or serialising the approval never shows it. */
  privateKey: () => string;
};

/** "10" or "2.5" to base units. Accepts plain decimals only, never zero, never signs, hex or exponents. */
export function parseAmount(text: string, decimals: number, name: string): bigint {
  const match = new RegExp(`^(\\d+)(?:\\.(\\d{1,${decimals}}))?$`).exec(text.trim());
  if (!match) throw new GuardError(`${name} must be a plain positive decimal with at most ${decimals} decimal places`);
  const whole = BigInt(match[1] as string);
  const frac = BigInt((match[2] ?? "").padEnd(decimals, "0") || "0");
  const value = whole * 10n ** BigInt(decimals) + frac;
  if (value === 0n) throw new GuardError(`${name} must be above zero`);
  return value;
}

export function formatQie(wei: bigint): string {
  const whole = wei / QIE;
  const frac = (wei % QIE).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** The per-script spending caps, from the environment or the defaults, never above the ceilings. */
export function readCaps(env: Record<string, string | undefined>): Caps {
  const rawQusdc = env.SLUICE_MAX_QUSDC?.trim();
  const rawQie = env.SLUICE_MAX_QIE?.trim();
  const maxQusdc = rawQusdc ? parseAmount(rawQusdc, 6, "SLUICE_MAX_QUSDC") : DEFAULT_MAX_QUSDC;
  const maxQieWei = rawQie ? parseAmount(rawQie, 18, "SLUICE_MAX_QIE") : DEFAULT_MAX_QIE_WEI;
  if (maxQusdc > CEILING_QUSDC) {
    throw new GuardError(`SLUICE_MAX_QUSDC is above the hard ceiling of ${formatQusdc(CEILING_QUSDC)} QUSDC`);
  }
  if (maxQieWei > CEILING_QIE_WEI) {
    throw new GuardError(`SLUICE_MAX_QIE is above the hard ceiling of ${formatQie(CEILING_QIE_WEI)} QIE`);
  }
  const rawTx = env.SLUICE_MAX_TX_QIE?.trim();
  const maxTxQieWei = rawTx ? parseAmount(rawTx, 18, "SLUICE_MAX_TX_QIE") : undefined;
  if (maxTxQieWei !== undefined && maxTxQieWei > maxQieWei) {
    throw new GuardError("SLUICE_MAX_TX_QIE is above SLUICE_MAX_QIE, so it could never apply");
  }
  return { maxQusdc, maxQieWei, ...(maxTxQieWei !== undefined ? { maxTxQieWei } : {}) };
}

const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/;

/**
 * Throws a GuardError unless the script is fully approved. Call it first, before opening any connection or
 * reading any key. Returns what the script needs to proceed.
 */
export function requireApproval(
  script: string,
  env: Record<string, string | undefined>,
  plan: Plan,
): Approval {
  const network = env.SLUICE_NETWORK?.trim();
  if (network !== "mainnet" && network !== "testnet") {
    throw new GuardError(`refusing to run ${script}: set SLUICE_NETWORK to mainnet or testnet`);
  }
  const approved = env.SLUICE_APPROVE?.trim();
  if (!approved) {
    throw new GuardError(`refusing to run ${script}: set SLUICE_APPROVE=${script} to approve this script`);
  }
  if (approved !== script) {
    // Echo the value only if it looks like a script name, so a secret pasted here by mistake is never repeated.
    const shown = /^[A-Za-z0-9_-]{1,24}$/.test(approved) ? `approves "${approved}", not "${script}"` : `does not approve "${script}"`;
    throw new GuardError(`refusing to run ${script}: SLUICE_APPROVE ${shown}`);
  }
  const caps = readCaps(env);
  if (plan.qusdc > caps.maxQusdc) {
    throw new GuardError(
      `refusing to run ${script}: it may move ${formatQusdc(plan.qusdc)} QUSDC, above the cap of ${formatQusdc(caps.maxQusdc)}`,
    );
  }
  if (plan.qieWei > caps.maxQieWei) {
    throw new GuardError(
      `refusing to run ${script}: it may spend ${formatQie(plan.qieWei)} QIE on gas, above the cap of ${formatQie(caps.maxQieWei)}`,
    );
  }
  const key = env.SLUICE_KEY?.trim();
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new GuardError(`refusing to run ${script}: SLUICE_KEY must be set to a 0x-prefixed 32-byte hex key`);
  }
  const rpcUrl = (env.SLUICE_RPC_URL?.trim() || NETWORKS[network].rpc).trim();
  if (!rpcUrl.startsWith("https://") && !LOCAL.test(rpcUrl)) {
    throw new GuardError(`refusing to run ${script}: SLUICE_RPC_URL must be https`);
  }
  const approval: Approval = {
    script,
    network,
    chainId: NETWORKS[network].chainId,
    rpcUrl,
    caps,
    privateKey: () => key,
  };
  // Make the key invisible to JSON.stringify, console.log and util.inspect.
  Object.defineProperty(approval, "privateKey", { enumerable: false, value: approval.privateKey });
  return approval;
}

/** Replaces the private key, with or without its 0x, in any text before it is printed. */
export function redact(text: string, env: Record<string, string | undefined>): string {
  const key = env.SLUICE_KEY?.trim();
  if (!key) return text;
  const bare = key.replace(/^0x/i, "");
  return text.split(key).join("[redacted]").split(bare).join("[redacted]");
}

/** What was actually spent during a run, checked before each transaction is sent. */
export class SpendMeter {
  private qusdcMoved = 0n;
  private qieSpent = 0n;
  private qieReserved = 0n;

  constructor(readonly caps: Caps) {}

  get movedQusdc(): bigint {
    return this.qusdcMoved;
  }
  get spentQie(): bigint {
    return this.qieSpent;
  }

  /** Call before QUSDC leaves the signer's wallet. Throws if it would pass the QUSDC cap. */
  beforeQusdc(amount: bigint): void {
    if (amount <= 0n) throw new GuardError("a QUSDC amount must be above zero");
    if (this.qusdcMoved + amount > this.caps.maxQusdc) {
      throw new GuardError(
        `stopping: moving ${formatQusdc(amount)} QUSDC more would pass the cap of ${formatQusdc(this.caps.maxQusdc)}`,
      );
    }
    this.qusdcMoved += amount;
  }

  /** Call before sending a transaction. Reserves its worst-case gas cost; throws if that passes the QIE cap. */
  beforeSend(gasLimit: bigint, gasPrice: bigint): void {
    if (gasPrice > MAX_GAS_PRICE_WEI) {
      throw new GuardError(`stopping: gas price is above ${MAX_GAS_PRICE_WEI / 1_000_000_000n} gwei`);
    }
    const worst = gasLimit * gasPrice;
    if (this.caps.maxTxQieWei !== undefined && worst > this.caps.maxTxQieWei) {
      throw new GuardError(`stopping: one transaction could cost ${formatQie(worst)} QIE, above the cap of ${formatQie(this.caps.maxTxQieWei)} QIE for a single transaction`);
    }
    if (this.qieSpent + this.qieReserved + worst > this.caps.maxQieWei) {
      throw new GuardError(`stopping: the next transaction could pass the cap of ${formatQie(this.caps.maxQieWei)} QIE`);
    }
    this.qieReserved += worst;
  }

  /**
   * Call after the transaction is mined, with the gas it really used and the price it really paid.
   * If a send fails or times out, this is not called and the worst-case reservation stays counted, because
   * the transaction may still have been broadcast.
   */
  afterSend(gasLimit: bigint, gasPrice: bigint, gasUsed: bigint, effectivePrice: bigint): void {
    this.qieReserved -= gasLimit * gasPrice;
    this.qieSpent += gasUsed * effectivePrice;
  }
}

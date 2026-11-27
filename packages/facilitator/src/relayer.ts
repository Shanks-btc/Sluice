// The relayer: the one hot key. Every transaction it signs goes through this class, which enforces the caps.
//
//   - contract calls may only go to the router or the vault (the allowlist);
//   - a QIE transfer may only be a capped top-up for the zero-QIE start;
//   - gas limit, gas price and a per-UTC-day QIE budget are checked before anything is signed;
//   - only the holder of the relayer lock sends, whether the copies of the service share one process or only a database, and it reads
//     the relayer's pending nonce from the chain while it holds the lock;
//   - the day's budget and the day's top-ups to one address are set aside in the ledger before anything is signed, so a restart, or
//     another copy of the service, cannot spend them again;
//   - an alert fires when half of the day's budget is used, and again when it is gone;
//   - the key is held in a private field and never printed, logged or serialised.
//
// The relayer never holds QUSDC, is not the router's owner and is not its fee recipient. The service checks
// the last two when it starts; the first is by construction (it never asks for a relayer fee) and is reported
// in /health.
import { inspect } from "node:util";
import { Wallet, getAddress } from "ethers";
import type { Provider, TransactionReceipt } from "ethers";
import type { Caps } from "./caps";
import { ERRORS } from "@sluice/sdk";
import { LocalLedger, RELAYER_LOCK } from "./ledger";
import type { Ledger, Lock } from "./ledger";
import { MemoryStore } from "./store";

export class CapError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CapError";
  }
}

export type Alert = {
  at: number;
  kind: "budget_50" | "budget_exhausted" | "holds_qusdc" | "low_balance" | "store_unavailable" | "kill_switch";
  message: string;
};

export type RelayerOptions = {
  /** The signing key. Used once to build the wallet and then dropped. */
  key: string;
  provider: Provider;
  caps: Caps;
  /** The only contracts the relayer will call. */
  allowlist: string[];
  now?: () => number;
  onAlert?: (alert: Alert) => void;
  /** Where the lock, the day's budget and the day's top-ups are kept. Left out, this process's memory. */
  ledger?: Ledger;
  /** How long the lock lasts if its holder never lets go. It must be longer than a holder can run. */
  lockTtlMs?: number;
  /** How long a send waits for the lock before it gives up. */
  lockWaitMs?: number;
  /** How long to wait for a receipt. */
  receiptTimeoutMs?: number;
  /** Asked at the last moment before signing: false stops the send (the kill switch). */
  maySend?: () => Promise<boolean>;
};

const TRANSFER_GAS = 21_000n;
/** The least life the lock must have left at the moment of signing. */
export const LOCK_MARGIN_MS = 5_000;
/** Returned by withLock when someone else holds the lock for longer than the caller will wait. */
export const BUSY: unique symbol = Symbol("relayer busy");

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class Relayer {
  readonly address: string;
  readonly #wallet: Wallet;
  readonly #provider: Provider;
  readonly #caps: Caps;
  readonly #allow: Set<string>;
  readonly #now: () => number;
  readonly #onAlert?: (alert: Alert) => void;
  readonly #ledger: Ledger;
  readonly #lockTtlMs: number;
  readonly #lockWaitMs: number;
  readonly #receiptTimeoutMs: number;
  readonly #maySend?: () => Promise<boolean>;
  #day = "";
  readonly #fired = new Set<string>();
  /** The alerts this copy of the service raised. The ledger keeps those of every copy. */
  readonly alerts: Alert[] = [];
  /** One holder of the lock at a time inside this process, in the order they asked. */
  #tail: Promise<unknown> = Promise.resolve();
  #waiting = 0;

  constructor(options: RelayerOptions) {
    this.#provider = options.provider;
    this.#wallet = new Wallet(options.key, options.provider);
    this.address = this.#wallet.address;
    this.#caps = options.caps;
    this.#allow = new Set(options.allowlist.map((a) => getAddress(a)));
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.#onAlert = options.onAlert;
    this.#ledger = options.ledger ?? new LocalLedger(new MemoryStore());
    this.#lockTtlMs = options.lockTtlMs ?? 300_000;
    this.#lockWaitMs = options.lockWaitMs ?? 180_000;
    this.#receiptTimeoutMs = options.receiptTimeoutMs ?? 120_000;
    this.#maySend = options.maySend;
  }

  // Nothing about the key can leak through logging, JSON or the REPL.
  toJSON(): { address: string } {
    return { address: this.address };
  }
  [inspect.custom](): string {
    return `Relayer(${this.address})`;
  }

  get allowlist(): string[] {
    return [...this.#allow];
  }

  private today(): string {
    const day = new Date(this.#now() * 1000).toISOString().slice(0, 10);
    if (day !== this.#day) {
      this.#day = day;
      this.#fired.clear();
    }
    return day;
  }

  async budget(): Promise<{ day: string; budgetWei: bigint; spentWei: bigint; reservedWei: bigint; remainingWei: bigint }> {
    const day = this.today();
    const { spentWei, reservedWei } = await this.#ledger.budget(day);
    const used = spentWei + reservedWei;
    return { day, budgetWei: this.#caps.dailyBudgetWei, spentWei, reservedWei, remainingWei: this.#caps.dailyBudgetWei > used ? this.#caps.dailyBudgetWei - used : 0n };
  }

  /** Raises an alert once a day: in this process at once, and in the ledger for every copy to read. */
  raise(kind: Alert["kind"], message: string): Promise<void> {
    const day = this.today();
    if (this.#fired.has(kind)) return Promise.resolve();
    this.#fired.add(kind);
    const alert: Alert = { at: this.#now(), kind, message };
    this.alerts.push(alert);
    if (this.alerts.length > 50) this.alerts.shift();
    this.#onAlert?.(alert);
    // A ledger that cannot be written is itself what some alerts are about: the alert is in the log either way.
    return this.#ledger.raiseAlert(day, alert).catch(() => undefined);
  }

  private async checkThresholds(used: bigint): Promise<void> {
    const budget = this.#caps.dailyBudgetWei;
    if (used * 2n >= budget) await this.raise("budget_50", "the relayer has used half of today's QIE budget");
    if (used >= budget) await this.raise("budget_exhausted", "the relayer's QIE budget for today is used up");
  }

  /** The gas price to pay now, or a CapError if the network's price is above the ceiling. */
  async gasPrice(): Promise<bigint> {
    const fee = await this.#provider.getFeeData();
    const price = fee.gasPrice;
    if (price === null || price === undefined) throw new CapError(ERRORS.unexpectedSettle, "the node gave no gas price");
    if (price > this.#caps.maxGasPriceWei) {
      throw new CapError(ERRORS.capGasPrice, `gas price ${price} is above the relayer's ceiling of ${this.#caps.maxGasPriceWei}`);
    }
    return price;
  }

  /**
   * Runs `work` while holding the relayer lock, and lets the lock go however `work` ends. In one process the holders take turns; across
   * copies the ledger's lock decides. BUSY when the lock cannot be had within `waitMs`; with 0 it does not wait at all.
   */
  async withLock<T>(work: (lock: Lock) => Promise<T>, waitMs: number = this.#lockWaitMs): Promise<T | typeof BUSY> {
    if (waitMs <= 0 && this.#waiting > 0) return BUSY;
    this.#waiting += 1;
    const run = async (): Promise<T | typeof BUSY> => {
      const until = Date.now() + waitMs;
      let lock = await this.#ledger.lock(RELAYER_LOCK, this.#lockTtlMs);
      while (!lock && Date.now() < until) {
        await sleep(Math.min(100, Math.max(1, until - Date.now())));
        lock = await this.#ledger.lock(RELAYER_LOCK, this.#lockTtlMs);
      }
      if (!lock) return BUSY;
      try {
        return await work(lock);
      } finally {
        // A release that cannot be written leaves the lock to expire.
        await lock.release().catch(() => undefined);
      }
    };
    const next = this.#tail.then(run, run);
    this.#tail = next.catch(() => undefined);
    try {
      return await next;
    } finally {
      this.#waiting -= 1;
    }
  }

  private async locked<T>(lock: Lock | undefined, work: (lock: Lock) => Promise<T>): Promise<T> {
    if (lock) return work(lock);
    const out = await this.withLock(work);
    if (out === BUSY) throw new CapError("relayer_busy", "the relayer is busy with another transaction; try again");
    return out;
  }

  /** One send under the lock: the budget is set aside before anything is signed, and settled after. */
  private async send(
    lock: Lock,
    cost: (price: bigint) => bigint,
    build: (price: bigint, nonce: number) => Promise<{ hash: string; wait: () => Promise<TransactionReceipt | null> }>,
    valueOf: (receipt: TransactionReceipt) => bigint,
  ): Promise<TransactionReceipt> {
    const day = this.today();
    const price = await this.gasPrice();
    const worst = cost(price);
    const reservation = await this.#ledger.reserveBudget(day, worst, this.#caps.dailyBudgetWei);
    if (!reservation.ok) {
      await this.raise("budget_exhausted", "the relayer's QIE budget for today would be exceeded");
      throw new CapError(ERRORS.capBudget, "the relayer's QIE budget for today would be exceeded");
    }
    await this.checkThresholds(reservation.spentWei + reservation.reservedWei);
    let sent: { hash: string; wait: () => Promise<TransactionReceipt | null> };
    try {
      // Read while the lock is held, so no other holder can be choosing the same one.
      const nonce = await this.#provider.getTransactionCount(this.address, "pending");
      if (!(await lock.held(LOCK_MARGIN_MS))) throw new CapError("lock_lost", "the relayer lock was lost, so nothing was signed");
      if (this.#maySend && !(await this.#maySend())) throw new CapError(ERRORS.killSwitch, "the operator has stopped all sends");
      sent = await build(price, nonce);
    } catch (err) {
      // Refused before anything could have been broadcast: release the reservation.
      await this.#ledger.releaseBudget(day, worst);
      throw err;
    }
    // From here the transaction may be on the network, so the reservation stays counted until a receipt says otherwise.
    const receipt = await sent.wait();
    if (!receipt) throw new CapError(ERRORS.unexpectedSettle, "no receipt for the relayer's transaction yet");
    await this.#ledger.spendBudget(day, worst, valueOf(receipt));
    const after = await this.#ledger.budget(day);
    await this.checkThresholds(after.spentWei + after.reservedWei);
    return receipt;
  }

  /**
   * A call to the router or the vault. Anything else is refused before anything is signed.
   *
   * `onBroadcast` is told the transaction's hash as soon as the node has it, before the wait for a receipt, so a caller that keeps
   * a record can write the hash down. If it fails, the failure is swallowed here: the transaction is already on the network, and the
   * caller's own record (which can no longer be written) is what failed, not the transaction.
   *
   * `lock` is the relayer lock a caller already holds; left out, the lock is taken for this send.
   */
  async sendCall(call: { to: string; data: string; gasLimit: bigint }, onBroadcast?: (hash: string) => void | Promise<void>, lock?: Lock): Promise<TransactionReceipt> {
    const to = getAddress(call.to);
    if (!this.#allow.has(to)) throw new CapError("destination_not_allowed", `${to} is not on the relayer's allowlist`);
    if (call.gasLimit <= 0n || call.gasLimit > this.#caps.gasLimitPerTx) {
      throw new CapError("gas_limit_not_allowed", `gas limit ${call.gasLimit} is above the relayer's cap of ${this.#caps.gasLimitPerTx}`);
    }
    return this.locked(lock, (held) =>
      this.send(
        held,
        (price) => call.gasLimit * price,
        async (price, nonce) => {
          const tx = await this.#wallet.sendTransaction({ type: 0, to, data: call.data, value: 0n, gasLimit: call.gasLimit, gasPrice: price, nonce });
          try {
            await onBroadcast?.(tx.hash);
          } catch {
            // see above
          }
          return { hash: tx.hash, wait: () => tx.wait(1, this.#receiptTimeoutMs) };
        },
        (receipt) => receipt.gasUsed * receipt.gasPrice,
      ),
    );
  }

  /** A capped QIE top-up to a wallet that is starting with no QIE. The only transfer of QIE the relayer ever makes. */
  async sendTopUp(to: string, valueWei: bigint, lock?: Lock): Promise<TransactionReceipt> {
    const dest = getAddress(to);
    if (this.#allow.has(dest) || dest === this.address) throw new CapError("destination_not_allowed", "a top-up cannot go to the relayer or an allowlisted contract");
    if (valueWei <= 0n || valueWei > this.#caps.maxTopUpWei) {
      throw new CapError("top_up_not_allowed", `a top-up of ${valueWei} wei is outside the relayer's cap of ${this.#caps.maxTopUpWei}`);
    }
    return this.locked(lock, async (held) => {
      // The per-address daily cap is held here as well as in the service: both are in the ledger, and this one is the last check before
      // a key signs, so a caller that forgets the service's check still cannot send one address more than the cap.
      const day = this.today();
      if (!(await this.#ledger.reserveTopUp(day, dest, valueWei, this.#caps.topUpPerAddressDailyWei))) {
        throw new CapError("top_up_address_cap", `top-ups to this address would pass the cap of ${this.#caps.topUpPerAddressDailyWei} wei a day`);
      }
      let broadcast = false;
      try {
        return await this.send(
          held,
          (price) => valueWei + TRANSFER_GAS * price,
          async (price, nonce) => {
            const tx = await this.#wallet.sendTransaction({ type: 0, to: dest, value: valueWei, gasLimit: TRANSFER_GAS, gasPrice: price, nonce });
            broadcast = true;
            return { hash: tx.hash, wait: () => tx.wait(1, this.#receiptTimeoutMs) };
          },
          (receipt) => valueWei + receipt.gasUsed * receipt.gasPrice,
        );
      } catch (err) {
        if (!broadcast) await this.#ledger.releaseTopUp(day, dest, valueWei); // nothing left, so nothing is counted
        throw err;
      }
    });
  }

  /** The relayer's own QIE balance, so an operator can see when to top it up. */
  async balance(): Promise<bigint> {
    return this.#provider.getBalance(this.address);
  }
}

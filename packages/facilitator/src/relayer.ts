// The relayer: the one hot key. Every transaction it signs goes through this class, which enforces the caps.
//
//   - contract calls may only go to the router or the vault (the allowlist);
//   - a QIE transfer may only be a capped top-up for the zero-QIE start;
//   - gas limit, gas price and a per-UTC-day QIE budget are checked before anything is signed;
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
};

const TRANSFER_GAS = 21_000n;

export class Relayer {
  readonly address: string;
  readonly #wallet: Wallet;
  readonly #provider: Provider;
  readonly #caps: Caps;
  readonly #allow: Set<string>;
  readonly #now: () => number;
  readonly #onAlert?: (alert: Alert) => void;
  #day = "";
  #spent = 0n;
  #reserved = 0n;
  /** QIE sent to each address today, in wei. */
  #topUps = new Map<string, bigint>();
  readonly #fired = new Set<string>();
  readonly alerts: Alert[] = [];
  /** A transaction in flight at a time: the relayer's nonce is not shared. */
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: RelayerOptions) {
    this.#provider = options.provider;
    this.#wallet = new Wallet(options.key, options.provider);
    this.address = this.#wallet.address;
    this.#caps = options.caps;
    this.#allow = new Set(options.allowlist.map((a) => getAddress(a)));
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.#onAlert = options.onAlert;
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

  private rollDay(): void {
    const day = new Date(this.#now() * 1000).toISOString().slice(0, 10);
    if (day !== this.#day) {
      this.#day = day;
      this.#spent = 0n;
      this.#reserved = 0n;
      this.#topUps = new Map();
      this.#fired.clear();
    }
  }

  budget(): { day: string; budgetWei: bigint; spentWei: bigint; reservedWei: bigint; remainingWei: bigint } {
    this.rollDay();
    const used = this.#spent + this.#reserved;
    return {
      day: this.#day,
      budgetWei: this.#caps.dailyBudgetWei,
      spentWei: this.#spent,
      reservedWei: this.#reserved,
      remainingWei: this.#caps.dailyBudgetWei > used ? this.#caps.dailyBudgetWei - used : 0n,
    };
  }

  private alert(kind: Alert["kind"], message: string): void {
    if (this.#fired.has(kind)) return;
    this.#fired.add(kind);
    const alert: Alert = { at: this.#now(), kind, message };
    this.alerts.push(alert);
    if (this.alerts.length > 50) this.alerts.shift();
    this.#onAlert?.(alert);
  }

  raise(kind: Alert["kind"], message: string): void {
    this.alert(kind, message);
  }

  private checkThresholds(): void {
    const used = this.#spent + this.#reserved;
    const budget = this.#caps.dailyBudgetWei;
    if (used * 2n >= budget) this.alert("budget_50", "the relayer has used half of today's QIE budget");
    if (used >= budget) this.alert("budget_exhausted", "the relayer's QIE budget for today is used up");
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

  /** Runs one send at a time, with the reservation made before and settled after. */
  private async send(
    cost: (price: bigint) => bigint,
    build: (price: bigint) => Promise<{ hash: string; wait: () => Promise<TransactionReceipt | null> }>,
    valueOf: (receipt: TransactionReceipt) => bigint,
  ): Promise<TransactionReceipt> {
    const run = async (): Promise<TransactionReceipt> => {
      this.rollDay();
      const price = await this.gasPrice();
      const worst = cost(price);
      if (this.#spent + this.#reserved + worst > this.#caps.dailyBudgetWei) {
        this.alert("budget_exhausted", "the relayer's QIE budget for today would be exceeded");
        throw new CapError(ERRORS.capBudget, "the relayer's QIE budget for today would be exceeded");
      }
      this.#reserved += worst;
      this.checkThresholds();
      let sent: { hash: string; wait: () => Promise<TransactionReceipt | null> };
      try {
        sent = await build(price);
      } catch (err) {
        // Refused before anything could have been broadcast: release the reservation.
        this.#reserved -= worst;
        throw err;
      }
      // From here the transaction may be on the network, so the reservation stays counted until a receipt says otherwise.
      const receipt = await sent.wait();
      if (!receipt) throw new CapError(ERRORS.unexpectedSettle, "no receipt for the relayer's transaction yet");
      this.#reserved -= worst;
      this.#spent += valueOf(receipt);
      this.checkThresholds();
      return receipt;
    };
    const next = this.#tail.then(run, run);
    this.#tail = next.catch(() => undefined);
    return next;
  }

  /**
   * A call to the router or the vault. Anything else is refused before anything is signed.
   *
   * `onBroadcast` is told the transaction's hash as soon as the node has it, before the wait for a receipt, so a caller that keeps
   * a record can write the hash down. If it throws, the throw is swallowed here: the transaction is already on the network, and the
   * caller's own record (which can no longer be written) is what failed, not the transaction.
   */
  async sendCall(call: { to: string; data: string; gasLimit: bigint }, onBroadcast?: (hash: string) => void): Promise<TransactionReceipt> {
    const to = getAddress(call.to);
    if (!this.#allow.has(to)) throw new CapError("destination_not_allowed", `${to} is not on the relayer's allowlist`);
    if (call.gasLimit <= 0n || call.gasLimit > this.#caps.gasLimitPerTx) {
      throw new CapError("gas_limit_not_allowed", `gas limit ${call.gasLimit} is above the relayer's cap of ${this.#caps.gasLimitPerTx}`);
    }
    return this.send(
      (price) => call.gasLimit * price,
      async (price) => {
        const tx = await this.#wallet.sendTransaction({ type: 0, to, data: call.data, value: 0n, gasLimit: call.gasLimit, gasPrice: price });
        try {
          onBroadcast?.(tx.hash);
        } catch {
          // see above
        }
        return { hash: tx.hash, wait: () => tx.wait(1, 120_000) };
      },
      (receipt) => receipt.gasUsed * receipt.gasPrice,
    );
  }

  /** A capped QIE top-up to a wallet that is starting with no QIE. The only transfer of QIE the relayer ever makes. */
  async sendTopUp(to: string, valueWei: bigint): Promise<TransactionReceipt> {
    const dest = getAddress(to);
    if (this.#allow.has(dest) || dest === this.address) throw new CapError("destination_not_allowed", "a top-up cannot go to the relayer or an allowlisted contract");
    if (valueWei <= 0n || valueWei > this.#caps.maxTopUpWei) {
      throw new CapError("top_up_not_allowed", `a top-up of ${valueWei} wei is outside the relayer's cap of ${this.#caps.maxTopUpWei}`);
    }
    // The per-address daily cap is held here as well as in the service: the service's count survives a restart, this one is the
    // last check before a key signs, so a caller that forgets the service's check still cannot send one address more than the cap.
    this.rollDay();
    const sent = this.#topUps.get(dest) ?? 0n;
    if (sent + valueWei > this.#caps.topUpPerAddressDailyWei) {
      throw new CapError("top_up_address_cap", `top-ups to this address would pass the cap of ${this.#caps.topUpPerAddressDailyWei} wei a day`);
    }
    const receipt = await this.send(
      (price) => valueWei + TRANSFER_GAS * price,
      async (price) => {
        const tx = await this.#wallet.sendTransaction({ type: 0, to: dest, value: valueWei, gasLimit: TRANSFER_GAS, gasPrice: price });
        return { hash: tx.hash, wait: () => tx.wait(1, 120_000) };
      },
      (receipt) => valueWei + receipt.gasUsed * receipt.gasPrice,
    );
    this.#topUps.set(dest, (this.#topUps.get(dest) ?? 0n) + valueWei);
    return receipt;
  }

  /** The relayer's own QIE balance, so an operator can see when to top it up. */
  async balance(): Promise<bigint> {
    return this.#provider.getBalance(this.address);
  }
}

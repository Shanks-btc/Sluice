// The facilitator: /verify, /settle (queue, then batchSettle), /status, the zero-QIE start and relayed signed requests.
//
// It holds no QUSDC and no authority over anyone's money: every payment is a signature the payer made, the router
// enforces it, and the relayer key only pays gas. What it does decide is what it spends of its own QIE, and that is
// capped in code (see caps.ts and relayer.ts).
import { Contract, Transaction, getAddress, id as keccakText } from "ethers";
import type { Provider, TransactionReceipt } from "ethers";
import {
  CHAIN_ID,
  ERC20_ABI,
  ERRORS,
  QUSDC_ADDRESS,
  ROUTER_ABI,
  VAULT_ABI,
  X402_VERSION,
  checkPayment,
  erc20Interface,
  errorNameOf,
  parsePayload,
  parseRequirements,
  routerInterface,
  vaultInterface,
} from "@sluice/sdk";
import type {
  ErrorCode,
  OnboardResponse,
  PaymentCheck,
  PaymentPayload,
  PaymentRequirements,
  RelayResponse,
  SettleResponse,
  StatusResponse,
  VerifyResponse,
} from "@sluice/sdk";
import { HARD_CAPS, resolveCaps } from "./caps";
import type { Caps } from "./caps";
import { KillSwitch } from "./killswitch";
import { silentLogger } from "@sluice/sdk";
import type { Logger } from "@sluice/sdk";
import { CapError, Relayer } from "./relayer";
import type { Alert } from "./relayer";
import { MemoryStore, StoreError } from "./store";
import type { IntentRecord, Store } from "./store";

type CheckOk = Extract<PaymentCheck, { ok: true }>;

class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => (release = resolve));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export type FacilitatorOptions = {
  provider: Provider;
  router: string;
  /** The relayer's signing key. Handed to the Relayer and not kept here. */
  relayerKey: string;
  caps?: Partial<Caps>;
  store?: Store;
  chainId?: number;
  asset?: string;
  /** Unix seconds. Defaults to the wall clock. */
  now?: () => number;
  /** Used to build the status URL in settle responses. */
  publicUrl?: string;
  onAlert?: (alert: Alert) => void;
  /** Stops relaying, settling and top-ups while it is on. Reads keep working. Off unless given. */
  killSwitch?: KillSwitch;
  /** Structured, scrubbed log lines. Silent unless given. */
  logger?: Logger;
  /** /health flags the relayer as low on QIE below this balance. Defaults to one full day's budget. */
  lowBalanceWei?: bigint;
};

export type FlushReport = {
  submitted: number;
  settled: number;
  skipped: number;
  expired: number;
  failed: number;
  transaction?: string;
  gasUsed?: bigint;
  /** Set when nothing was sent because a cap held. The intents stay queued. */
  held?: string;
};

const asNumber = (v: unknown): number => Number(v);

/** The name of the router error inside a failed call, if there is one. */
function revertName(err: unknown): string {
  const data = (err as { data?: unknown; info?: { error?: { data?: unknown } } } | undefined)?.data ??
    (err as { info?: { error?: { data?: unknown } } } | undefined)?.info?.error?.data;
  if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) return errorNameOf(data.slice(0, 10));
  return err instanceof Error ? err.message.slice(0, 120) : "reverted";
}

/** What an operator or a client is told when `gate` stops a request. No path, no key, no internals. */
function gateDetail(code: ErrorCode): string {
  if (code === ERRORS.killSwitch) return "the operator has stopped relaying and top-ups; reads still work";
  if (code === ERRORS.storeUnavailable) return "the facilitator cannot record what it is told, so it accepts nothing";
  return "the facilitator is shutting down";
}

/** A failure of the connection to the node, not of what was asked of it: asking again later can work. */
function isTransient(err: unknown): boolean {
  const code = (err as { code?: unknown } | undefined)?.code;
  return code === "NETWORK_ERROR" || code === "SERVER_ERROR" || code === "TIMEOUT" || code === "ECONNREFUSED" || code === "ECONNRESET";
}

export class Facilitator {
  readonly relayer: Relayer;
  readonly router: Contract;
  readonly vault: Contract;
  readonly routerAddress: string;
  readonly vaultAddress: string;
  readonly caps: Caps;
  readonly store: Store;
  private readonly provider: Provider;
  private readonly chainId: number;
  private readonly asset: string;
  private readonly now: () => number;
  private readonly publicUrl?: string;
  private readonly settleLock = new Mutex();
  private readonly flushLock = new Mutex();
  private readonly onboardLock = new Mutex();
  private readonly attempts = new Map<string, number>();
  private readonly killSwitch: KillSwitch;
  private readonly log: Logger;
  private readonly lowBalanceWei: bigint;
  private draining = false;
  private timer?: NodeJS.Timeout;

  private constructor(o: FacilitatorOptions, relayer: Relayer, router: Contract, vault: Contract, vaultAddress: string, caps: Caps) {
    this.killSwitch = o.killSwitch ?? new KillSwitch();
    this.log = o.logger ?? silentLogger;
    this.lowBalanceWei = o.lowBalanceWei ?? caps.dailyBudgetWei;
    this.provider = o.provider;
    this.relayer = relayer;
    this.router = router;
    this.vault = vault;
    this.routerAddress = getAddress(o.router);
    this.vaultAddress = vaultAddress;
    this.caps = caps;
    this.store = o.store ?? new MemoryStore();
    this.chainId = o.chainId ?? CHAIN_ID;
    this.asset = getAddress(o.asset ?? QUSDC_ADDRESS);
    this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
    this.publicUrl = o.publicUrl?.replace(/\/+$/, "");
  }

  /** Connects, reads the vault, and refuses to start if the relayer is the router's owner or fee recipient. */
  static async create(o: FacilitatorOptions): Promise<Facilitator> {
    const caps = resolveCaps(o.caps);
    const routerAddress = getAddress(o.router);
    const net = await o.provider.getNetwork();
    if (Number(net.chainId) !== (o.chainId ?? CHAIN_ID)) {
      throw new Error(`the node is on chain ${net.chainId}, not ${o.chainId ?? CHAIN_ID}`);
    }
    const routerContract = new Contract(routerAddress, ROUTER_ABI as unknown as string[], o.provider);
    const vaultAddress = getAddress((await routerContract.getFunction("vault")()) as string);
    // The asset is the token the router holds: that is the ground truth, not a setting.
    const asset = getAddress((await routerContract.getFunction("token")()) as string);
    if (o.asset !== undefined && getAddress(o.asset) !== asset) throw new Error("the asset option is not the token the router holds");
    const relayer = new Relayer({
      key: o.relayerKey,
      provider: o.provider,
      caps,
      allowlist: [routerAddress, vaultAddress],
      now: o.now,
      onAlert: o.onAlert,
    });
    const [owner, feeRecipient] = (await Promise.all([
      routerContract.getFunction("owner")(),
      routerContract.getFunction("feeRecipient")(),
    ])) as [string, string];
    if (getAddress(owner) === relayer.address) throw new Error("the relayer key must not be the router's owner");
    if (getAddress(feeRecipient) === relayer.address) throw new Error("the relayer key must not be the router's fee recipient");
    const vault = new Contract(vaultAddress, VAULT_ABI as unknown as string[], o.provider);
    const facilitator = new Facilitator({ ...o, asset }, relayer, routerContract, vault, vaultAddress, caps);
    // Whatever a stopped process left half-way is settled against the chain before the first request is served.
    await facilitator.recover().catch(() => undefined);
    return facilitator;
  }

  private get network(): string {
    return `eip155:${this.chainId}`;
  }

  /**
   * Why the facilitator must not accept or send anything right now, if it must not: it is shutting down, the operator's kill
   * switch is on, or the queue store cannot record what it is told. Checked before every action that queues, sends or spends.
   */
  private gate(): ErrorCode | undefined {
    if (this.draining) return ERRORS.facilitatorUnavailable;
    if (this.killSwitch.active()) {
      this.relayer.raise("kill_switch", "the kill switch is on: nothing is relayed, settled or topped up");
      return ERRORS.killSwitch;
    }
    if (!this.store.healthy()) {
      this.relayer.raise("store_unavailable", "the queue store cannot be written: nothing is accepted or sent until it is fixed and the service restarted");
      return ERRORS.storeUnavailable;
    }
    return undefined;
  }

  // ----------------------------------------------------------------------------------------- reading requests

  private readRequest(body: unknown): { payload: PaymentPayload; requirements: PaymentRequirements } | ErrorCode {
    if (typeof body !== "object" || body === null) return ERRORS.invalidPayload;
    const b = body as Record<string, unknown>;
    if (b.x402Version !== X402_VERSION) return ERRORS.invalidVersion;
    const payload = parsePayload(b.paymentPayload);
    if (!payload) return ERRORS.invalidPayload;
    const requirements = parseRequirements(b.paymentRequirements);
    if (!requirements) return ERRORS.invalidRequirements;
    return { payload, requirements };
  }

  private context() {
    return { chainId: this.chainId, router: this.routerAddress, asset: this.asset, now: this.now() };
  }

  /**
   * The amounts of this payer's intents that are queued or in flight and not yet in the chain's own numbers. An intent that was
   * sent in a batch which has since been mined is already taken out of the balance and counted in the session's `spent`, so counting
   * it again as pending would refuse a payment the payer can afford. Its nonce says whether it has been mined. Every read is made at
   * the same block (`block`), so the nonces, the balance and the session all describe one moment: an intent mined at or before that
   * block is in all three, one mined after it is in none.
   */
  private async pendingBeyondChain(payer: string, signer: string, block: number): Promise<{ forPayer: bigint; forAgent: bigint }> {
    const open = this.store.openOf(payer);
    const flights = open.filter((r) => r.status === "submitted");
    const mined = await Promise.all(flights.map((r) => this.router.getFunction("nonceUsed")(r.payer, r.nonce, { blockTag: block }) as Promise<boolean>));
    const counted = new Set(flights.filter((_r, i) => mined[i]).map((r) => r.id));
    let forPayer = 0n;
    let forAgent = 0n;
    for (const r of open) {
      if (counted.has(r.id)) continue;
      forPayer += BigInt(r.amount);
      if (r.signer.toLowerCase() === signer.toLowerCase()) forAgent += BigInt(r.amount);
    }
    return { forPayer, forAgent };
  }

  /** What only the chain knows: the nonce, the payer's balance net of what is already queued, and an agent's session. */
  private async chainState(check: CheckOk): Promise<ErrorCode | undefined> {
    const { intent, signer } = check;
    const block = await this.provider.getBlockNumber();
    const at = { blockTag: block };
    const pending = await this.pendingBeyondChain(intent.payer, signer, block);
    const [used, balance] = (await Promise.all([
      this.router.getFunction("nonceUsed")(intent.payer, intent.nonce, at),
      this.router.getFunction("payerBalance")(intent.payer, at),
    ])) as [boolean, bigint];
    if (used) return ERRORS.nonceUsed;
    if (balance < pending.forPayer + intent.amount) return ERRORS.insufficientFunds;
    if (signer !== intent.payer) {
      const s = (await this.vault.getFunction("sessionOf")(intent.payer, signer, at)) as {
        budget: bigint;
        spent: bigint;
        perCallCap: bigint;
        expiry: bigint;
        id: bigint;
      };
      if (s.id === 0n) return ERRORS.sessionNotFound;
      if (BigInt(this.now()) > s.expiry) return ERRORS.sessionExpired;
      if (intent.amount > s.perCallCap) return ERRORS.perCallCap;
      if (s.spent + pending.forAgent + intent.amount > s.budget) return ERRORS.budgetExceeded;
      const allowed = (await this.vault.getFunction("isToolAllowed")(intent.payer, signer, intent.payee, intent.toolId, at)) as boolean;
      if (!allowed) return ERRORS.toolNotAllowed;
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------------------------- /verify

  async verify(body: unknown): Promise<VerifyResponse> {
    const req = this.readRequest(body);
    if (typeof req === "string") return { isValid: false, invalidReason: req };
    const check = checkPayment(req.payload, req.requirements, this.context());
    const payer = req.payload.payload.authorization.payer;
    if (!check.ok) return { isValid: false, invalidReason: check.code, payer };
    // A "valid" answer tells a tool server to go ahead and do the work. While the facilitator cannot settle, that work would go
    // unpaid, so it says no.
    const blocked = this.gate();
    if (blocked) return { isValid: false, invalidReason: blocked, payer };
    if (this.store.get(check.digest)) return { isValid: false, invalidReason: ERRORS.intentReplayed, payer };
    try {
      const problem = await this.chainState(check);
      if (problem) return { isValid: false, invalidReason: problem, payer };
    } catch {
      return { isValid: false, invalidReason: ERRORS.unexpectedVerify, payer };
    }
    return { isValid: true, payer: check.intent.payer, extra: { id: check.digest, signer: check.signer } };
  }

  // ---------------------------------------------------------------------------------------------- /settle

  private day(): string {
    return new Date(this.now() * 1000).toISOString().slice(0, 10);
  }

  private view(record: IntentRecord): SettleResponse {
    return {
      success: true,
      payer: record.payer,
      transaction: record.transaction ?? "",
      network: this.network,
      amount: record.amount,
      extensions: {
        sluice: {
          id: record.id,
          status: record.status,
          ...(this.publicUrl ? { statusUrl: `${this.publicUrl}/status/${record.id}` } : {}),
        },
      },
    };
  }

  /** Queues a payment. It does not send a transaction: `flush` does, in a batch. The same intent queues once. */
  async settle(body: unknown): Promise<SettleResponse> {
    const network = this.network;
    const req = this.readRequest(body);
    if (typeof req === "string") return { success: false, errorReason: req, transaction: "", network };
    const check = checkPayment(req.payload, req.requirements, this.context());
    const payer = req.payload.payload.authorization.payer;
    if (!check.ok) return { success: false, errorReason: check.code, payer, transaction: "", network };

    // Nothing is queued, charged or counted while the facilitator is stopped or cannot write down what it was told.
    const blocked = this.gate();
    if (blocked) {
      this.log.warn("settle refused", { reason: blocked, payer });
      return { success: false, errorReason: blocked, payer, transaction: "", network };
    }

    return this.settleLock.run(async () => {
      const existing = this.store.get(check.digest);
      if (existing) return this.view(existing); // idempotent: the same intent is one record, however often it is sent
      const sameNonce = this.store.byNonce(check.intent.payer, check.intent.nonce);
      if (sameNonce) return { success: false, errorReason: ERRORS.nonceUsed, payer, transaction: "", network };

      let problem: ErrorCode | undefined;
      try {
        problem = await this.chainState(check);
      } catch {
        problem = ERRORS.unexpectedSettle;
      }
      if (problem) return { success: false, errorReason: problem, payer, transaction: "", network };

      const day = this.day();
      const amount = check.intent.amount;
      const payerKey = `intent:${day}:${check.intent.payer.toLowerCase()}`;
      const globalKey = `intent:${day}:*`;
      const p = this.store.usage(payerKey);
      const g = this.store.usage(globalKey);
      if (p.count + 1 > this.caps.payerDailyIntents || p.amount + amount > this.caps.payerDailyAmount) {
        return { success: false, errorReason: ERRORS.capPayerDaily, payer, transaction: "", network };
      }
      if (g.count + 1 > this.caps.globalDailyIntents || g.amount + amount > this.caps.globalDailyAmount) {
        return { success: false, errorReason: ERRORS.capGlobalDaily, payer, transaction: "", network };
      }

      const at = this.now();
      const record: IntentRecord = {
        id: check.digest,
        payer: check.intent.payer,
        payee: check.intent.payee,
        signer: check.signer,
        amount: amount.toString(),
        toolId: check.intent.toolId,
        nonce: check.intent.nonce,
        deadline: check.intent.deadline.toString(),
        signature: check.signature,
        status: "queued",
        createdAt: at,
        updatedAt: at,
      };
      try {
        // One write: the intent and the counters that count it are on disk together or not at all.
        this.store.putMany([record], [[payerKey, amount], [globalKey, amount]]);
      } catch (err) {
        if (err instanceof StoreError) {
          this.log.error("the queue store refused a write", { code: err.code });
          return { success: false, errorReason: ERRORS.storeUnavailable, payer, transaction: "", network };
        }
        throw err;
      }
      this.log.info("intent queued", { id: record.id, payer: record.payer, payee: record.payee, toolId: record.toolId, amount: record.amount });
      return this.view(record);
    });
  }

  status(id: string): StatusResponse | undefined {
    const r = this.store.get(id.toLowerCase()) ?? this.store.get(id);
    if (!r) return undefined;
    return {
      id: r.id,
      status: r.status,
      payer: r.payer,
      payee: r.payee,
      amount: r.amount,
      ...(r.transaction ? { transaction: r.transaction } : {}),
      ...(r.blockNumber !== undefined ? { blockNumber: r.blockNumber } : {}),
      ...(r.reason ? { reason: r.reason } : {}),
    };
  }

  // ------------------------------------------------------------------------------------------------- flush
  //
  // The order of a batch is what makes a stop at any moment safe. The batch is written down as `submitted` (with the block number
  // it was sent from) before the transaction exists, its hash is written down the moment the node has it, and only then does the
  // wait for the receipt begin. A process that stops anywhere in that sequence leaves a journal that says what it was doing, and
  // `reconcile` finishes the job from the chain: a receipt settles each intent by its event, an unused nonce with nothing in flight
  // puts it back in the queue, a used nonce is looked up as a Settled event. The router burns a nonce once, so even the worst case,
  // a batch sent twice, settles each intent once and skips the second with NonceUsed.

  private next(r: IntentRecord, status: IntentRecord["status"], extra: Partial<IntentRecord> = {}): IntentRecord {
    return { ...r, ...extra, status, updatedAt: this.now() };
  }

  /** Sends one batchSettle for the oldest queued intents. Returns what the chain said about each. */
  async flush(): Promise<FlushReport> {
    return this.flushLock.run(async () => {
      const report: FlushReport = { submitted: 0, settled: 0, skipped: 0, expired: 0, failed: 0 };
      const blocked = this.gate();
      if (blocked) {
        report.held = blocked;
        return report;
      }
      try {
        await this.reconcile(this.store.submitted(), report, false); // what an earlier run left in flight
        return await this.sendNext(report);
      } catch (err) {
        if (err instanceof StoreError) {
          this.log.error("the queue store refused a write; nothing more is sent", { code: err.code });
          report.held = ERRORS.storeUnavailable;
          return report;
        }
        throw err;
      }
    });
  }

  /** Finishes what a stopped process left in flight, from the chain. Run once when the service is created. */
  async recover(): Promise<FlushReport> {
    return this.flushLock.run(async () => {
      const report: FlushReport = { submitted: 0, settled: 0, skipped: 0, expired: 0, failed: 0 };
      const open = this.store.submitted();
      if (open.length === 0) return report;
      this.log.info("recovering intents that were in flight when the service stopped", { count: open.length });
      try {
        await this.reconcile(open, report, false);
      } catch (err) {
        if (!(err instanceof StoreError)) throw err;
        this.log.error("the queue store refused a write during recovery", { code: err.code });
      }
      this.log.info("recovery finished", { settled: report.settled, skipped: report.skipped, failed: report.failed, stillInFlight: this.store.submitted().length });
      return report;
    });
  }

  private async sendNext(report: FlushReport): Promise<FlushReport> {
    const now = BigInt(this.now());
    let batch: IntentRecord[] = [];
    const expired: IntentRecord[] = [];
    for (const r of this.store.queued(this.caps.maxBatchSize)) {
      if (BigInt(r.deadline) < now) expired.push(this.next(r, "expired", { reason: "the deadline passed before the intent was submitted" }));
      else batch.push(r);
    }
    if (expired.length > 0) {
      this.store.putMany(expired);
      report.expired += expired.length;
    }
    if (batch.length === 0) return report;

    // Find a batch that fits the gas cap: halve it until the estimate is under the ceiling.
    let data = this.encodeBatch(batch);
    let gas: bigint;
    for (;;) {
      try {
        gas = await this.provider.estimateGas({ from: this.relayer.address, to: this.routerAddress, data });
      } catch (err) {
        if (isTransient(err)) {
          this.log.warn("the node could not be reached to estimate a batch; it stays queued");
          return report; // not the intents' fault: they are not counted against
        }
        for (const r of batch) this.failAttempt(r, revertName(err), report);
        return report;
      }
      const limit = (gas * 12n) / 10n;
      if (limit <= this.caps.gasLimitPerTx || batch.length === 1) {
        gas = limit;
        break;
      }
      batch = batch.slice(0, Math.ceil(batch.length / 2));
      data = this.encodeBatch(batch);
    }

    let fromBlock: number;
    try {
      fromBlock = await this.provider.getBlockNumber();
    } catch {
      this.log.warn("the node could not be reached to read its block number; the batch stays queued");
      return report;
    }
    const batchId = keccakText(batch.map((r) => r.id).join(",")).slice(0, 18);
    let current = batch.map((r) => this.next(r, "submitted", { batch: batchId, fromBlock }));
    this.store.putMany(current); // before the transaction exists. If this write fails, nothing is sent.

    let receipt: TransactionReceipt;
    try {
      receipt = await this.relayer.sendCall({ to: this.routerAddress, data, gasLimit: gas }, (hash) => {
        current = current.map((r) => ({ ...r, transaction: hash }));
        this.store.putMany(current); // the hash, as soon as the node has it
        this.log.info("batch broadcast", { batch: batchId, transaction: hash, intents: current.length });
      });
    } catch (err) {
      if (err instanceof CapError) {
        this.store.putMany(batch); // a cap held before anything was signed: the intents go back to the queue as they were
        report.held = err.code;
        this.log.warn("a cap held the batch", { cap: err.code, batch: batchId });
        return report;
      }
      // Not confirmed in time, or refused by the node. It may or may not be on the network: the chain says which.
      this.log.warn("the batch was not confirmed; checking the chain", { batch: batchId });
      await this.reconcile(current, report, true);
      return report;
    }
    report.submitted = batch.length;
    report.transaction = receipt.hash;
    report.gasUsed = receipt.gasUsed;
    this.applyReceipt(current, receipt, report);
    this.log.info("batch confirmed", { batch: batchId, transaction: receipt.hash, settled: report.settled, skipped: report.skipped, failed: report.failed, gasUsed: receipt.gasUsed });
    return report;
  }

  /** What the router said about each intent in a confirmed batch, by payer and nonce. */
  private outcomes(logs: ReadonlyArray<{ address: string; topics: readonly string[]; data: string }>): Map<string, { status: "settled" | "skipped"; reason?: string; fee?: string }> {
    const outcome = new Map<string, { status: "settled" | "skipped"; reason?: string; fee?: string }>();
    for (const log of logs) {
      if (getAddress(log.address) !== this.routerAddress) continue;
      let parsed;
      try {
        parsed = routerInterface.parseLog({ topics: [...log.topics], data: log.data });
      } catch {
        continue;
      }
      if (!parsed) continue;
      if (parsed.name === "Settled") {
        outcome.set(`${String(parsed.args.payer).toLowerCase()}|${String(parsed.args.nonce).toLowerCase()}`, { status: "settled", fee: String(parsed.args.fee) });
      } else if (parsed.name === "SettleSkipped") {
        outcome.set(`${String(parsed.args.payer).toLowerCase()}|${String(parsed.args.nonce).toLowerCase()}`, {
          status: "skipped",
          reason: errorNameOf(String(parsed.args.reason)),
        });
      }
    }
    return outcome;
  }

  /** Records a confirmed batch: one write for the whole batch. */
  private applyReceipt(records: IntentRecord[], receipt: TransactionReceipt, report: FlushReport): void {
    const outcome = this.outcomes(receipt.logs);
    const common = { transaction: receipt.hash, blockNumber: asNumber(receipt.blockNumber) };
    const updates: IntentRecord[] = [];
    for (const r of records) {
      const o = outcome.get(`${r.payer.toLowerCase()}|${r.nonce.toLowerCase()}`);
      if (!o) {
        updates.push(this.next(r, "failed", { ...common, reason: "the batch confirmed with no event for this intent" }));
        report.failed += 1;
      } else if (o.status === "settled") {
        updates.push(this.next(r, "settled", { ...common, fee: o.fee }));
        report.settled += 1;
      } else {
        updates.push(this.next(r, "skipped", { ...common, reason: o.reason }));
        report.skipped += 1;
      }
    }
    this.store.putMany(updates);
  }

  /**
   * Settles intents recorded as `submitted` against the chain. For each one:
   *   1. a receipt for its transaction: the batch's events say what happened to it;
   *   2. no receipt, but the node still knows the transaction: it is waiting, so it stays `submitted`;
   *   3. its nonce is used on the router: a Settled event from the block it was sent from names the transaction;
   *   4. its nonce is unused: if the relayer has a transaction waiting (it may be this one, sent before its hash was written
   *      down) it stays `submitted`; if not, the batch never reached the network and the intent goes back to the queue.
   * A node that cannot be asked leaves everything as it was. `counted` says whether a put-back counts against the intent's three
   * tries (it does after a failed send, and not after a restart, which is nobody's fault).
   */
  private async reconcile(records: IntentRecord[], report: FlushReport, counted: boolean): Promise<void> {
    const open = records.filter((r) => r.status === "submitted");
    if (open.length === 0) return;
    const updates: IntentRecord[] = [];
    const pending: string[] = [];

    // 1. Receipts, once per transaction.
    const byHash = new Map<string, IntentRecord[]>();
    const rest: IntentRecord[] = [];
    for (const r of open) {
      if (!r.transaction) {
        rest.push(r);
        continue;
      }
      byHash.set(r.transaction, [...(byHash.get(r.transaction) ?? []), r]);
    }
    for (const [hash, group] of byHash) {
      let receipt: TransactionReceipt | null;
      try {
        receipt = await this.provider.getTransactionReceipt(hash);
      } catch {
        pending.push(...group.map((r) => r.id));
        continue;
      }
      if (!receipt) {
        rest.push(...group);
        continue;
      }
      if (receipt.status !== 1) {
        // The whole batch reverted, so none of it settled: back to the queue, and it counts as a try.
        for (const r of group) this.putBack(r, "the batch transaction reverted", updates, report, true);
        continue;
      }
      this.applyReceipt(group, receipt, report);
    }

    // 2 to 4. No receipt.
    let busy: boolean | undefined;
    const relayerBusy = async (): Promise<boolean> => {
      if (busy === undefined) {
        const [pend, latest] = await Promise.all([
          this.provider.getTransactionCount(this.relayer.address, "pending"),
          this.provider.getTransactionCount(this.relayer.address, "latest"),
        ]);
        busy = pend > latest;
      }
      return busy;
    };
    const settledLogs = new Map<string, Array<{ args: { nonce: unknown; fee: unknown }; transactionHash: string; blockNumber: number }>>();
    for (const r of rest) {
      try {
        if (r.transaction && (await this.provider.getTransaction(r.transaction))) {
          pending.push(r.id); // 2
          continue;
        }
        const used = (await this.router.getFunction("nonceUsed")(r.payer, r.nonce)) as boolean;
        if (used) {
          // 3
          const key = `${r.payer.toLowerCase()}|${r.fromBlock ?? 0}`;
          let found = settledLogs.get(key);
          if (!found) {
            const settledFilter = this.router.filters.Settled as unknown as (payer: string) => never;
            found = (await this.router.queryFilter(settledFilter(r.payer), r.fromBlock ?? 0, "latest")) as unknown as NonNullable<typeof found>;
            settledLogs.set(key, found);
          }
          const hit = found.find((l) => String(l.args.nonce).toLowerCase() === r.nonce.toLowerCase());
          if (hit) {
            updates.push(this.next(r, "settled", { transaction: hit.transactionHash, blockNumber: hit.blockNumber, fee: String(hit.args.fee) }));
            report.settled += 1;
          } else {
            updates.push(this.next(r, "skipped", { reason: "the nonce was already used on the router by a transaction this service did not record" }));
            report.skipped += 1;
          }
          continue;
        }
        if (await relayerBusy()) {
          pending.push(r.id); // 4, waiting
          continue;
        }
        this.putBack(r, "the batch never reached the network", updates, report, counted); // 4, never sent
      } catch (err) {
        if (err instanceof StoreError) throw err;
        pending.push(r.id); // the node could not be asked: leave it as it is and ask again next time
      }
    }
    if (updates.length > 0) this.store.putMany(updates);
    if (pending.length > 0) this.log.info("intents still in flight", { count: pending.length });
  }

  /** An intent whose batch did not settle it goes back to the queue, or fails after its third try. */
  private putBack(r: IntentRecord, reason: string, updates: IntentRecord[], report: FlushReport, counted: boolean): void {
    if (counted) {
      const n = (this.attempts.get(r.id) ?? 0) + 1;
      this.attempts.set(r.id, n);
      if (n >= 3) {
        updates.push(this.next(r, "failed", { reason }));
        report.failed += 1;
        return;
      }
    }
    updates.push(this.next(r, "queued", { batch: undefined, fromBlock: undefined, transaction: undefined }));
  }

  private encodeBatch(batch: IntentRecord[]): string {
    return routerInterface.encodeFunctionData("batchSettle", [
      batch.map((r) => ({
        payer: r.payer,
        payee: r.payee,
        amount: BigInt(r.amount),
        toolId: r.toolId,
        nonce: r.nonce,
        deadline: BigInt(r.deadline),
      })),
      batch.map((r) => r.signature),
    ]);
  }

  /** An intent that could not be submitted is retried twice, then marked failed. */
  private failAttempt(r: IntentRecord, reason: string, report: FlushReport): void {
    const n = (this.attempts.get(r.id) ?? 0) + 1;
    this.attempts.set(r.id, n);
    if (n >= 3) {
      this.store.put(this.next(r, "failed", { reason }));
      report.failed += 1;
    }
  }

  /** Flushes on a timer. Safe to call once. */
  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush().catch(() => undefined), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Stops taking work and waits, for at most `timeoutMs`, for what is in progress: a batch being sent, a payment being queued, a
   * start being relayed. A batch that is still waiting for its receipt when the time is up is not lost: its hash is in the journal
   * and the next start settles it from the chain.
   */
  async drain(timeoutMs: number): Promise<{ finished: boolean }> {
    this.draining = true;
    this.stop();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const idle = Promise.all([this.flushLock.run(async () => true), this.settleLock.run(async () => true), this.onboardLock.run(async () => true)]).then(() => true);
    const finished = await Promise.race([idle, timeout]);
    if (timer) clearTimeout(timer);
    this.log.info("drained", { finished });
    return { finished };
  }

  // -------------------------------------------------------------------------------- the zero-QIE start

  /**
   * A wallet with QUSDC and no QIE starts here. It sends two pre-signed transactions, `approve(router, amount)` on
   * QUSDC and `deposit(amount)` on the router. The facilitator checks every byte of both, sends the wallet exactly
   * the QIE their gas limits can use (less what it already has), then broadcasts them in order. The wallet's
   * own key signed both, so the facilitator cannot change what they do.
   */
  async onboard(body: unknown): Promise<OnboardResponse> {
    const refuse = (detail: string): OnboardResponse => ({ ok: false, error: ERRORS.onboardRefused, detail });
    const blocked = this.gate();
    if (blocked) return { ok: false, error: blocked, detail: gateDetail(blocked) };
    if (typeof body !== "object" || body === null) return refuse("the request must be a JSON object");
    const b = body as Record<string, unknown>;
    if (typeof b.payer !== "string" || typeof b.approveTx !== "string" || typeof b.depositTx !== "string") {
      return refuse("payer, approveTx and depositTx are required");
    }
    let payer: string;
    let approve: Transaction;
    let deposit: Transaction;
    try {
      payer = getAddress(b.payer);
      approve = Transaction.from(b.approveTx);
      deposit = Transaction.from(b.depositTx);
    } catch {
      return refuse("a transaction could not be decoded");
    }

    for (const [label, tx] of [
      ["approve", approve],
      ["deposit", deposit],
    ] as const) {
      if (tx.signature === null || tx.from === null) return refuse(`${label} transaction is not signed`);
      if (getAddress(tx.from) !== payer) return refuse(`${label} transaction was not signed by the payer`);
      if (tx.type !== 0) return refuse(`${label} transaction must be a legacy (type 0) transaction`);
      if (Number(tx.chainId) !== this.chainId) return refuse(`${label} transaction is for another chain`);
      if (tx.value !== 0n) return refuse(`${label} transaction must send no QIE`);
      if (tx.gasPrice === null || tx.gasPrice > this.caps.maxGasPriceWei) return refuse(`${label} gas price is above the ceiling`);
    }
    if (approve.gasPrice !== deposit.gasPrice) return refuse("both transactions must use the same gas price");
    const gasPrice = approve.gasPrice as bigint;
    if (approve.gasLimit > 100_000n) return refuse("approve gas limit is above 100,000");
    if (deposit.gasLimit > 200_000n) return refuse("deposit gas limit is above 200,000");
    if (approve.to === null || getAddress(approve.to) !== this.asset) return refuse("approve must be sent to QUSDC");
    if (deposit.to === null || getAddress(deposit.to) !== this.routerAddress) return refuse("deposit must be sent to the router");

    let amount: bigint;
    try {
      const a = erc20Interface.parseTransaction({ data: approve.data });
      const d = routerInterface.parseTransaction({ data: deposit.data });
      if (a?.name !== "approve" || d?.name !== "deposit") return refuse("the calls must be approve and deposit");
      if (getAddress(String(a.args[0])) !== this.routerAddress) return refuse("approve must name the router as spender");
      amount = a.args[1] as bigint;
      if ((d.args[0] as bigint) !== amount) return refuse("deposit must equal the approved amount");
    } catch {
      return refuse("a transaction's call data is not approve or deposit");
    }
    if (amount <= 0n || amount > this.caps.maxOnboardAmount) return refuse(`the amount must be above zero and at most ${this.caps.maxOnboardAmount} units`);
    if (deposit.nonce !== approve.nonce + 1) return refuse("deposit must follow approve with the next nonce");

    return this.onboardLock.run(async () => {
      const token = new Contract(this.asset, ERC20_ABI as unknown as string[], this.provider);
      const [nonce, qusdc, qie, fee] = await Promise.all([
        this.provider.getTransactionCount(payer, "pending"),
        token.getFunction("balanceOf")(payer) as Promise<bigint>,
        this.provider.getBalance(payer),
        this.provider.getFeeData(),
      ]);
      if (approve.nonce !== nonce) return refuse(`the wallet's next nonce is ${nonce}, not ${approve.nonce}`);
      if (qusdc < amount) return refuse("the wallet does not hold the QUSDC it wants to deposit");
      if (fee.gasPrice !== null && fee.gasPrice !== undefined && gasPrice < fee.gasPrice) {
        return refuse(`the signed gas price is below the network's current ${fee.gasPrice}`);
      }
      const key = `onboard:${this.day()}:${payer.toLowerCase()}`;
      if (this.store.usage(key).count >= this.caps.onboardPerPayerPerDay) return refuse("this wallet has used today's zero-QIE starts");

      const need = (approve.gasLimit + deposit.gasLimit) * gasPrice;
      const topUp = need > qie ? need - qie : 0n;
      if (topUp > this.caps.maxTopUpWei) return refuse(`the top-up would be ${topUp} wei, above the cap of ${this.caps.maxTopUpWei}`);
      const topUpKey = `topup:${this.day()}:${payer.toLowerCase()}`;
      if (this.store.usage(topUpKey).amount + topUp > this.caps.topUpPerAddressDailyWei) {
        return refuse(`this wallet has used the QIE the facilitator tops up for one address in a day (${this.caps.topUpPerAddressDailyWei} wei)`);
      }

      try {
        // Counted, and the QIE it would send counted with it, before any QIE moves, so a failure part-way is not a free retry.
        this.store.putMany([], [[key, 0n], [topUpKey, topUp]]);
      } catch (err) {
        if (err instanceof StoreError) return { ok: false, error: ERRORS.storeUnavailable, detail: gateDetail(ERRORS.storeUnavailable) };
        throw err;
      }
      this.log.info("zero-QIE start", { payer, topUpWei: topUp });
      const out: OnboardResponse = { ok: false };
      try {
        if (topUp > 0n) {
          const r = await this.relayer.sendTopUp(payer, topUp);
          out.topUpTx = r.hash;
          out.topUpWei = topUp.toString();
        }
        for (const [label, raw] of [
          ["approveTx", b.approveTx as string],
          ["depositTx", b.depositTx as string],
        ] as const) {
          const sent = await this.provider.broadcastTransaction(raw);
          const receipt = await sent.wait(1, 120_000);
          out[label] = sent.hash;
          if (!receipt || receipt.status !== 1) return { ...out, ok: false, error: ERRORS.onboardRefused, detail: `${label} did not succeed` };
        }
      } catch (err) {
        const code = err instanceof CapError ? err.code : ERRORS.onboardRefused;
        return { ...out, ok: false, error: code, detail: err instanceof CapError ? err.message : "a transaction was not accepted by the node" };
      }
      return { ...out, ok: true };
    });
  }

  // ----------------------------------------------------------------------------- relayed signed requests

  /**
   * Submits a request the owner of the funds signed, so the owner needs no QIE: a withdrawal or refund (router), or the
   * authorisation or revocation of an agent session (vault). The relayer fee is always zero for withdrawals and refunds:
   * the router pays a relayer fee in QUSDC to the submitting address, and this relayer never holds QUSDC.
   */
  async relay(body: unknown): Promise<RelayResponse> {
    const refuse = (detail: string): RelayResponse => ({ ok: false, error: ERRORS.relayRefused, detail });
    const blocked = this.gate();
    if (blocked) return { ok: false, error: blocked, detail: gateDetail(blocked) };
    if (typeof body !== "object" || body === null) return refuse("the request must be a JSON object");
    const b = body as Record<string, unknown>;
    const text = (k: string): string => {
      const v = b[k];
      if (typeof v !== "string") throw new Error(`${k} is required`);
      return v;
    };
    let who: string;
    let target: string;
    let data: string;
    try {
      switch (b.kind) {
        case "withdraw":
        case "refund": {
          who = getAddress(text("account"));
          const amount = BigInt(text("amount"));
          if (amount <= 0n) return refuse("amount must be above zero");
          const fn = b.kind === "withdraw" ? "withdrawBySig" : "refundBySig";
          data = routerInterface.encodeFunctionData(fn, [who, getAddress(text("to")), amount, 0n, text("nonce"), BigInt(text("deadline")), text("signature")]);
          target = this.routerAddress;
          break;
        }
        case "authorize": {
          who = getAddress(text("payer"));
          const g = b.grant as Record<string, unknown> | undefined;
          const tools = b.tools;
          if (typeof g !== "object" || g === null || !Array.isArray(tools)) return refuse("grant and tools are required");
          if (tools.length === 0 || tools.length > 32) return refuse("tools must list between 1 and 32 tools");
          data = vaultInterface.encodeFunctionData("authorizeBySig", [
            who,
            { agent: getAddress(String(g.agent)), budget: BigInt(String(g.budget)), perCallCap: BigInt(String(g.perCallCap)), expiry: BigInt(String(g.expiry)) },
            tools.map((t: { payee: string; toolId: string }) => ({ payee: getAddress(String(t.payee)), toolId: String(t.toolId) })),
            BigInt(text("deadline")),
            text("signature"),
          ]);
          target = this.vaultAddress;
          break;
        }
        case "revoke": {
          who = getAddress(text("payer"));
          data = vaultInterface.encodeFunctionData("revokeBySig", [who, getAddress(text("agent")), BigInt(text("deadline")), text("signature")]);
          target = this.vaultAddress;
          break;
        }
        default:
          return refuse("kind must be withdraw, refund, authorize or revoke");
      }
    } catch {
      return refuse("a field is missing or malformed");
    }
    const key = `relay:${this.day()}:${who.toLowerCase()}`;
    if (this.store.usage(key).count >= this.caps.relayPerAccountPerDay) return refuse("this account has used today's relayed requests");

    let gas: bigint;
    try {
      gas = await this.provider.estimateGas({ from: this.relayer.address, to: target, data });
    } catch (err) {
      return refuse(`the contract would refuse it: ${revertName(err)}`);
    }
    try {
      this.store.addUsage(key, 0n);
    } catch (err) {
      if (err instanceof StoreError) return { ok: false, error: ERRORS.storeUnavailable, detail: gateDetail(ERRORS.storeUnavailable) };
      throw err;
    }
    try {
      const receipt = await this.relayer.sendCall({ to: target, data, gasLimit: (gas * 12n) / 10n });
      if (receipt.status !== 1) return refuse("the transaction failed");
      return { ok: true, transaction: receipt.hash };
    } catch (err) {
      return { ok: false, error: err instanceof CapError ? err.code : ERRORS.relayRefused, detail: err instanceof CapError ? err.message : "the transaction was not accepted" };
    }
  }

  // ------------------------------------------------------------------------------------------------ health

  async health() {
    const token = new Contract(this.asset, ERC20_ABI as unknown as string[], this.provider);
    const [balance, qusdc] = await Promise.all([this.relayer.balance(), token.getFunction("balanceOf")(this.relayer.address) as Promise<bigint>]);
    if (qusdc > 0n) this.relayer.raise("holds_qusdc", "the relayer address holds QUSDC, which it should never do");
    const lowBalance = balance < this.lowBalanceWei;
    if (lowBalance) this.relayer.raise("low_balance", `the relayer holds less than ${this.lowBalanceWei} wei of QIE: top it up before it cannot send`);
    const b = this.relayer.budget();
    const open = this.store.submitted();
    const storeOk = this.store.healthy();
    return {
      // False tells a container's health check to restart or replace the service: it cannot record what it is told, or it is shutting down.
      ok: storeOk && !this.draining,
      killSwitch: this.killSwitch.active(),
      draining: this.draining,
      store: { healthy: storeOk, ...(storeOk ? {} : { problem: this.store.problem() }) },
      lowBalance,
      lowBalanceThresholdWei: this.lowBalanceWei.toString(),
      inFlight: {
        count: open.length,
        oldestAgeSeconds: open.length ? Math.max(0, this.now() - Math.min(...open.map((r) => r.updatedAt))) : 0,
      },
      chainId: this.chainId,
      router: this.routerAddress,
      vault: this.vaultAddress,
      relayer: this.relayer.address,
      relayerBalanceWei: balance.toString(),
      relayerQusdcUnits: qusdc.toString(),
      budget: {
        day: b.day,
        budgetWei: b.budgetWei.toString(),
        spentWei: b.spentWei.toString(),
        reservedWei: b.reservedWei.toString(),
        remainingWei: b.remainingWei.toString(),
      },
      queued: this.store.queued(HARD_CAPS.maxBatchSize * 1000).length,
      alerts: this.relayer.alerts,
    };
  }
}

// The facilitator: /verify, /settle (queue, then batchSettle), /status, the zero-QIE start and relayed signed requests.
//
// It holds no QUSDC and no authority over anyone's money: every payment is a signature the payer made, the router
// enforces it, and the relayer key only pays gas. What it does decide is what it spends of its own QIE, and that is
// capped in code (see caps.ts and relayer.ts).
//
// Everything it remembers is in the ledger (ledger.ts), so it can be one process with a file, or many short-lived copies that share a
// database. Nothing here assumes that this copy is the one that runs: a payment is queued by one atomic write, only the holder of the
// relayer lock sends, and each write that follows a send names the lock it was made under.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Contract, Transaction, getAddress, hexlify, id as keccakText } from "ethers";
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
import { FINAL_STATUSES, LocalLedger, StaleLockError } from "./ledger";
import type { Ledger, Limit, Lock } from "./ledger";
import { BUSY, CapError, Relayer } from "./relayer";
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
  /** The file or memory store of a facilitator that is one process. Give this or `ledger`, not both. */
  store?: Store;
  /** The ledger to use instead: a database that every copy of the facilitator shares. */
  ledger?: Ledger;
  chainId?: number;
  asset?: string;
  /** Unix seconds. Defaults to the wall clock. */
  now?: () => number;
  /** Used to build the status URL in settle responses. */
  publicUrl?: string;
  onAlert?: (alert: Alert) => void;
  /** Stops relaying, settling and top-ups while it is on. Reads keep working. Off unless given. The ledger holds a second switch. */
  killSwitch?: KillSwitch;
  /** Structured, scrubbed log lines. Silent unless given. */
  logger?: Logger;
  /** /health flags the relayer as low on QIE below this balance. Defaults to one full day's budget. */
  lowBalanceWei?: bigint;
  /** The relayer lock's life and how long a send waits for it. See Relayer. */
  lockTtlMs?: number;
  lockWaitMs?: number;
  /** How long to wait for the receipt of the relayer's own transaction, and of each transaction of a zero-QIE start. */
  receiptTimeoutMs?: number;
  payerReceiptTimeoutMs?: number;
};

export type FlushReport = {
  submitted: number;
  settled: number;
  skipped: number;
  expired: number;
  failed: number;
  transaction?: string;
  gasUsed?: bigint;
  /** Set when nothing was sent because something held it: a cap, a switch, another holder of the relayer. The intents stay queued. */
  held?: string;
};

export type SweepReport = {
  batches: number;
  submitted: number;
  settled: number;
  skipped: number;
  expired: number;
  failed: number;
  /** Why the sweep stopped before the queue was empty, if it did. */
  held?: string;
  /** Intents still queued when it stopped; -1 when the ledger could not say. */
  remaining: number;
};

const emptyReport = (): FlushReport => ({ submitted: 0, settled: 0, skipped: 0, expired: 0, failed: 0 });

/** How often, and for how long, a payment is checked again because its payer's queue changed while it was being checked. */
const SETTLE_ATTEMPTS = 25;
const SETTLE_RETRY_MS = 8_000;
/** How long a capture waits for the chain, how often it looks, and how long it leaves between drains it starts itself. */
export const CAPTURE_WAIT_MS = 20_000;
const CAPTURE_POLL_MS = 200;
const DRAIN_AGAIN_MS = 1_000;
/** How many held payments one flush looks at for ones that have died, oldest first. */
const HELD_SCAN = 200;

/** Two hashes written as hex, compared in constant time. */
const sameHash = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

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
  readonly ledger: Ledger;
  private readonly provider: Provider;
  private readonly chainId: number;
  private readonly asset: string;
  private readonly now: () => number;
  private readonly publicUrl?: string;
  private readonly settleLock = new Mutex();
  private readonly flushLock = new Mutex();
  private readonly onboardLock = new Mutex();
  private readonly killSwitch: KillSwitch;
  private readonly log: Logger;
  private readonly lowBalanceWei: bigint;
  private readonly receiptTimeoutMs: number;
  private readonly payerReceiptTimeoutMs: number;
  private draining = false;
  private timer?: NodeJS.Timeout;

  private constructor(o: FacilitatorOptions, ledger: Ledger, relayer: Relayer, router: Contract, vault: Contract, vaultAddress: string, caps: Caps) {
    this.killSwitch = o.killSwitch ?? new KillSwitch();
    this.log = o.logger ?? silentLogger;
    this.lowBalanceWei = o.lowBalanceWei ?? caps.dailyBudgetWei;
    this.receiptTimeoutMs = o.receiptTimeoutMs ?? 120_000;
    this.payerReceiptTimeoutMs = o.payerReceiptTimeoutMs ?? 120_000;
    this.provider = o.provider;
    this.ledger = ledger;
    this.relayer = relayer;
    this.router = router;
    this.vault = vault;
    this.routerAddress = getAddress(o.router);
    this.vaultAddress = vaultAddress;
    this.caps = caps;
    this.chainId = o.chainId ?? CHAIN_ID;
    this.asset = getAddress(o.asset ?? QUSDC_ADDRESS);
    this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
    this.publicUrl = o.publicUrl?.replace(/\/+$/, "");
  }

  /** Connects, reads the vault, and refuses to start if the relayer is the router's owner or fee recipient. */
  static async create(o: FacilitatorOptions): Promise<Facilitator> {
    if (o.store && o.ledger) throw new Error("give a store or a ledger, not both");
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
    const ledger = o.ledger ?? new LocalLedger(o.store ?? new MemoryStore());
    let facilitator: Facilitator | undefined;
    const relayer = new Relayer({
      key: o.relayerKey,
      provider: o.provider,
      caps,
      allowlist: [routerAddress, vaultAddress],
      now: o.now,
      onAlert: o.onAlert,
      ledger,
      lockTtlMs: o.lockTtlMs,
      lockWaitMs: o.lockWaitMs,
      receiptTimeoutMs: o.receiptTimeoutMs,
      maySend: async () => (facilitator ? facilitator.maySend() : false),
    });
    const [owner, feeRecipient] = (await Promise.all([
      routerContract.getFunction("owner")(),
      routerContract.getFunction("feeRecipient")(),
    ])) as [string, string];
    if (getAddress(owner) === relayer.address) throw new Error("the relayer key must not be the router's owner");
    if (getAddress(feeRecipient) === relayer.address) throw new Error("the relayer key must not be the router's fee recipient");
    const vault = new Contract(vaultAddress, VAULT_ABI as unknown as string[], o.provider);
    facilitator = new Facilitator({ ...o, asset }, ledger, relayer, routerContract, vault, vaultAddress, caps);
    // Whatever a stopped process left half-way is settled against the chain before the first request is served.
    await facilitator.recover().catch(() => undefined);
    return facilitator;
  }

  /** The file or memory store under a local ledger. A shared ledger has none. */
  get store(): Store {
    if (!(this.ledger instanceof LocalLedger)) throw new Error("a shared ledger has no local store");
    return this.ledger.store;
  }

  private get network(): string {
    return `eip155:${this.chainId}`;
  }

  /** Writes down a refusal: in the log always, and in the ledger when it can be. */
  private async refused(what: string, reason: string, payer?: string): Promise<void> {
    const entry = { what, reason, ...(payer ? { payer } : {}) };
    this.log.warn(`${what} refused`, entry);
    await this.ledger.recordRefusal({ at: this.now(), ...entry }).catch(() => undefined);
  }

  /** True while neither switch is on. A switch that cannot be read counts as on. Asked again at the moment of every send. */
  async maySend(): Promise<boolean> {
    if (this.killSwitch.active()) return false;
    try {
      return !(await this.ledger.killSwitchOn());
    } catch {
      return false;
    }
  }

  /**
   * Why the facilitator must not accept or send anything right now, if it must not: it is shutting down, a kill switch is on (the
   * operator's in the environment or a file, or the one in the ledger), or the ledger cannot record what it is told. Checked before
   * every action that queues, sends or spends.
   */
  private async gate(): Promise<ErrorCode | undefined> {
    if (this.draining) return ERRORS.facilitatorUnavailable;
    if (this.killSwitch.active()) return this.stopped();
    let storedSwitch: boolean;
    try {
      storedSwitch = await this.ledger.killSwitchOn();
      if (!(await this.ledger.health()).ok) return this.unrecordable();
    } catch {
      return this.unrecordable();
    }
    if (storedSwitch) return this.stopped();
    return undefined;
  }

  private async stopped(): Promise<ErrorCode> {
    await this.relayer.raise("kill_switch", "the kill switch is on: nothing is relayed, settled or topped up");
    return ERRORS.killSwitch;
  }

  private async unrecordable(): Promise<ErrorCode> {
    await this.relayer.raise("store_unavailable", "the queue store cannot be written: nothing is accepted or sent until it is fixed and the service restarted");
    return ERRORS.storeUnavailable;
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
  private async pendingBeyondChain(open: IntentRecord[], signer: string, block: number): Promise<{ forPayer: bigint; forAgent: bigint }> {
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
  private async chainState(check: CheckOk, open: IntentRecord[]): Promise<ErrorCode | undefined> {
    const { intent, signer } = check;
    // The block every read below is made at. It is never older than the latest block in which an intent of this payer's is recorded as
    // settled: `open`, read before this, no longer holds that intent, so its amount must be gone from the balance read. What the node
    // answers, or the short cache the library keeps of it, can be older.
    const floor = await this.ledger.settledBlock(intent.payer);
    const block = Math.max(await this.provider.getBlockNumber(), floor);
    const at = { blockTag: block };
    const pending = await this.pendingBeyondChain(open, signer, block);
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
    if (typeof req === "string") {
      this.log.warn("verify refused", { reason: req });
      return { isValid: false, invalidReason: req };
    }
    const check = checkPayment(req.payload, req.requirements, this.context());
    const payer = req.payload.payload.authorization.payer;
    const invalid = async (reason: ErrorCode): Promise<VerifyResponse> => {
      await this.refused("verify", reason, payer);
      return { isValid: false, invalidReason: reason, payer };
    };
    if (!check.ok) return invalid(check.code);
    // A "valid" answer tells a tool server to go ahead and do the work. While the facilitator cannot settle, that work would go
    // unpaid, so it says no.
    const blocked = await this.gate();
    if (blocked) return invalid(blocked);
    try {
      if (await this.ledger.get(check.digest)) return invalid(ERRORS.intentReplayed);
      const open = await this.ledger.openOf(check.intent.payer);
      const problem = await this.chainState(check, open.records);
      if (problem) return invalid(problem);
    } catch (err) {
      return invalid(err instanceof StoreError ? ERRORS.storeUnavailable : ERRORS.unexpectedVerify);
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
  settle(body: unknown): Promise<SettleResponse> {
    return this.accept(body);
  }

  /**
   * Records a payment, with the same checks and counted against the same limits as `settle`, without putting it in the queue: nothing
   * sends it until `capture` is given the token in the answer. A tool server that holds a payment before it runs a tool knows that the
   * facilitator has it written down, and a call that fails costs the payer nothing. A held payment dies at its deadline.
   */
  async hold(body: unknown): Promise<SettleResponse> {
    const token = hexlify(randomBytes(32));
    const out = await this.accept(body, keccakText(token));
    if (!out.success || !out.extensions?.sluice) return out;
    return { ...out, extensions: { sluice: { ...out.extensions.sluice, hold: token } } };
  }

  private async accept(body: unknown, holdHash?: string): Promise<SettleResponse> {
    const network = this.network;
    const what = holdHash === undefined ? "settle" : "hold";
    const req = this.readRequest(body);
    if (typeof req === "string") {
      this.log.warn(`${what} refused`, { reason: req });
      return { success: false, errorReason: req, transaction: "", network };
    }
    const check = checkPayment(req.payload, req.requirements, this.context());
    const payer = req.payload.payload.authorization.payer;
    const refuse = async (reason: ErrorCode): Promise<SettleResponse> => {
      await this.refused(what, reason, payer);
      return { success: false, errorReason: reason, payer, transaction: "", network };
    };
    /** A record that is already there. A held one belongs to whoever holds its token, and is given to nobody else. */
    const already = async (record: IntentRecord): Promise<SettleResponse> => (holdHash !== undefined || record.status === "held" ? refuse(ERRORS.intentReplayed) : this.view(record));
    if (!check.ok) return refuse(check.code);

    // Nothing is queued, charged or counted while the facilitator is stopped or cannot write down what it was told.
    const blocked = await this.gate();
    if (blocked) return refuse(blocked);

    return this.settleLock.run(async () => {
      try {
        // Another copy of the service may change this payer's queue while it is being checked. The write then refuses, and the
        // checks are made again on what the queue holds now.
        const started = Date.now();
        for (let attempt = 0; attempt < SETTLE_ATTEMPTS && Date.now() - started < SETTLE_RETRY_MS; attempt++) {
          // A short random wait, so that copies that collided do not all try again at the same moment.
          if (attempt > 0) await new Promise<void>((resolve) => setTimeout(resolve, Math.random() * Math.min(5 * attempt, 60)));
          const existing = await this.ledger.get(check.digest);
          if (existing && (holdHash !== undefined || existing.status === "held")) return already(existing);
          if (existing) return this.view(existing); // idempotent: the same intent is one record, however often it is sent
          if (await this.ledger.byNonce(check.intent.payer, check.intent.nonce)) return refuse(ERRORS.nonceUsed);

          const open = await this.ledger.openOf(check.intent.payer);
          let problem: ErrorCode | undefined;
          try {
            problem = await this.chainState(check, open.records);
          } catch (err) {
            if (err instanceof StoreError) throw err;
            problem = ERRORS.unexpectedSettle;
          }
          if (problem) return refuse(problem);

          const day = this.day();
          const amount = check.intent.amount;
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
            status: holdHash === undefined ? "queued" : "held",
            createdAt: at,
            updatedAt: at,
            ...(holdHash === undefined ? {} : { hold: holdHash }),
          };
          const limits: Limit[] = [
            { key: `intent:${day}:${check.intent.payer.toLowerCase()}`, amount, maxCount: this.caps.payerDailyIntents, maxAmount: this.caps.payerDailyAmount },
            { key: `intent:${day}:*`, amount, maxCount: this.caps.globalDailyIntents, maxAmount: this.caps.globalDailyAmount },
          ];
          // One write: the intent and the counters that count it are recorded together or not at all.
          const out = await this.ledger.insertIntent(record, open.version, limits);
          if (out.kind === "inserted") {
            this.log.info(`intent ${record.status}`, { id: record.id, payer: record.payer, payee: record.payee, toolId: record.toolId, amount: record.amount });
            return this.view(record);
          }
          if (out.kind === "exists") return already(out.record);
          if (out.kind === "nonce") return refuse(ERRORS.nonceUsed);
          if (out.kind === "limit") return refuse(out.index === 0 ? ERRORS.capPayerDaily : ERRORS.capGlobalDaily);
        }
        this.log.warn("the payer's queue kept changing; the payment is refused and can be sent again");
        return refuse(ERRORS.unexpectedSettle);
      } catch (err) {
        if (err instanceof StoreError) {
          this.log.error("the queue store refused a write", { code: err.code });
          return refuse(ERRORS.storeUnavailable);
        }
        throw err;
      }
    });
  }

  // ---------------------------------------------------------------------------------------------- /capture

  /**
   * Releases a held payment and sees it through. The answer is success only once the chain's own record shows it settled. A payment
   * that could not be sent while this call waited is marked failed and is never sent, so a call whose answer is withheld is not charged
   * later. One that was sent and that the chain has not yet answered for is "pending": the same id and token ask again.
   * `keep` keeps work running after the answer has been given, on a platform that would otherwise stop it.
   */
  async capture(body: unknown, options: { waitMs?: number; drainMs?: number; keep?: (work: Promise<unknown>) => void } = {}): Promise<SettleResponse> {
    const asked = (typeof body === "object" && body !== null ? body : {}) as { id?: unknown; token?: unknown };
    const unsettled = (reason: ErrorCode, r?: IntentRecord): SettleResponse => ({
      success: false,
      errorReason: reason,
      transaction: r?.transaction ?? "",
      network: this.network,
      ...(r ? { payer: r.payer, extensions: { sluice: { id: r.id, status: r.status } } } : {}),
    });
    const refuse = async (reason: ErrorCode, r?: IntentRecord): Promise<SettleResponse> => {
      await this.refused("capture", reason, r?.payer);
      return unsettled(reason, r);
    };
    if (typeof asked.id !== "string" || typeof asked.token !== "string") return refuse(ERRORS.invalidPayload);
    const id = asked.id.toLowerCase();
    let record: IntentRecord | undefined;
    try {
      record = await this.ledger.get(id);
      if (!record) return refuse(ERRORS.notFound);
      if (!record.hold || !sameHash(keccakText(asked.token), record.hold)) return refuse(ERRORS.intentReplayed);
      if (record.status === "held") {
        const blocked = await this.gate();
        if (blocked) return refuse(blocked, record); // still held, so nothing is charged
        if (BigInt(record.deadline) < BigInt(this.now())) return refuse(ERRORS.expired, record);
        if (await this.ledger.releaseHold(this.next(record, "queued"))) this.log.info("held payment released", { id });
      }
      return await this.seeThrough(id, options, refuse, unsettled);
    } catch (err) {
      if (!(err instanceof StoreError)) throw err;
      // What became of the payment cannot be read, so nothing is said about it either way.
      this.log.error("the queue store could not be read while a payment was being captured", { code: err.code });
      return unsettled(ERRORS.paymentPending, record);
    }
  }

  private async seeThrough(
    id: string,
    options: { waitMs?: number; drainMs?: number; keep?: (work: Promise<unknown>) => void },
    refuse: (reason: ErrorCode, r?: IntentRecord) => Promise<SettleResponse>,
    unsettled: (reason: ErrorCode, r?: IntentRecord) => SettleResponse,
  ): Promise<SettleResponse> {
    const until = Date.now() + (options.waitMs ?? CAPTURE_WAIT_MS);
    const drain = () => {
      const state: { done: boolean; again: boolean; at: number } = { done: false, again: false, at: 0 };
      const work = this.sweep(options.drainMs ?? CAPTURE_WAIT_MS).then(
        (report) => Object.assign(state, { done: true, again: report.held === "relayer_busy" || report.held === "out_of_time", at: Date.now() }),
        () => Object.assign(state, { done: true, at: Date.now() }),
      );
      options.keep?.(work);
      return state;
    };
    const finished = async (r: IntentRecord): Promise<SettleResponse | undefined> => {
      if (r.status === "settled") return this.view(r);
      if (FINAL_STATUSES.has(r.status)) return refuse(ERRORS.paymentNotTaken, r);
      return undefined;
    };
    let current: ReturnType<typeof drain> | undefined;
    for (;;) {
      const ended = current?.done === true; // asked before the record is read, so that what it reads is what an ended drain left
      const r = (await this.ledger.get(id)) as IntentRecord;
      const done = await finished(r);
      if (done) return done;
      if (!current) current = drain();
      else if (ended) {
        // One drain that was free to send it and did not is enough: it is not sent on a later try that nobody is waiting for. Another
        // drain follows only if someone else had the relayer, or ran out of time, or the batch is waiting for the chain.
        if (r.status === "queued" && !current.again) break;
        if (Date.now() - current.at >= DRAIN_AGAIN_MS) current = drain();
      }
      if (Date.now() >= until) break;
      await new Promise<void>((resolve) => setTimeout(resolve, CAPTURE_POLL_MS));
    }
    const cancelled = await this.cancelUnsent(id);
    const last = (await this.ledger.get(id)) as IntentRecord;
    if (cancelled) return refuse(ERRORS.paymentNotTaken, last);
    return (await finished(last)) ?? unsettled(ERRORS.paymentPending, last);
  }

  /** Marks a released intent that has not been sent as failed, so that it never is. Only the holder of the relayer can know that. */
  private async cancelUnsent(id: string): Promise<boolean> {
    try {
      const out = await this.relayer.withLock(async (lock) => {
        const r = await this.ledger.get(id);
        if (r?.status !== "queued") return false;
        await this.ledger.update([this.next(r, "failed", { reason: "it could not be sent while the call waited for it, so it was not charged" })], lock);
        return true;
      }, 0);
      return out === true;
    } catch (err) {
      if (err instanceof StaleLockError || err instanceof StoreError) return false;
      throw err;
    }
  }

  async status(id: string): Promise<StatusResponse | undefined> {
    const r = (await this.ledger.get(id.toLowerCase())) ?? (await this.ledger.get(id));
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
  //
  // All of it happens while the relayer lock is held, so no other copy of the service is sending or reconciling at the same time, and
  // every write names the lock: a holder that lost it can write nothing.

  private next(r: IntentRecord, status: IntentRecord["status"], extra: Partial<IntentRecord> = {}): IntentRecord {
    return { ...r, ...extra, status, updatedAt: this.now() };
  }

  /** Runs `work` under the relayer lock, and turns what can stop it into the report's `held`. */
  private async underLock(report: FlushReport, waitMs: number | undefined, work: (lock: Lock) => Promise<void>): Promise<FlushReport> {
    try {
      const out = await this.relayer.withLock(work, waitMs);
      if (out === BUSY) {
        report.held = "relayer_busy";
        this.log.info("the relayer is busy; nothing is sent by this call");
      }
    } catch (err) {
      if (err instanceof StaleLockError) {
        report.held = "lock_lost";
        this.log.warn("the relayer lock was lost part-way; its next holder finishes from the chain");
      } else if (err instanceof StoreError) {
        this.log.error("the queue store refused a write; nothing more is sent", { code: err.code });
        report.held = ERRORS.storeUnavailable;
      } else throw err;
    }
    return report;
  }

  /** Sends one batchSettle for the oldest queued intents. Returns what the chain said about each. */
  async flush(options: { waitMs?: number } = {}): Promise<FlushReport> {
    return this.flushLock.run(async () => {
      const report = emptyReport();
      const blocked = await this.gate();
      if (blocked) {
        report.held = blocked;
        await this.refused("batch", blocked);
        return report;
      }
      return this.underLock(report, options.waitMs, async (lock) => {
        await this.reconcile(await this.ledger.submitted(), report, false, lock); // what an earlier run left in flight
        await this.sendNext(report, lock);
      });
    });
  }

  /**
   * Sends batches until the queue is empty, the relayer is someone else's, something holds the sending back, a batch makes no progress,
   * or there is not time for another one. It is what a copy that runs for one request calls, and calling it again does no harm: a
   * payment is recorded once, one holder sends at a time, and the router pays an intent once.
   *
   * The queue is looked at again after the lock is let go, so a payment that arrived while this call held the lock, and whose own call
   * found it held, is not left waiting.
   */
  async sweep(budgetMs: number): Promise<SweepReport> {
    const until = Date.now() + budgetMs;
    const oneBatch = this.receiptTimeoutMs + 10_000;
    const total: SweepReport = { batches: 0, submitted: 0, settled: 0, skipped: 0, expired: 0, failed: 0, remaining: 0 };
    for (;;) {
      if (total.batches > 0 && Date.now() + oneBatch > until) {
        total.held = "out_of_time";
        break;
      }
      const r = await this.flush({ waitMs: 0 });
      if (r.submitted > 0) total.batches += 1;
      total.submitted += r.submitted;
      total.settled += r.settled;
      total.skipped += r.skipped;
      total.expired += r.expired;
      total.failed += r.failed;
      if (r.held) {
        total.held = r.held;
        break;
      }
      const waiting = await this.ledger.queuedCount().catch(() => 0);
      if (waiting === 0 || (r.submitted === 0 && r.expired === 0)) break;
    }
    total.remaining = await this.ledger.queuedCount().catch(() => -1);
    return total;
  }

  /** Finishes what a stopped process left in flight, from the chain. Run once when the service is created. */
  async recover(): Promise<FlushReport> {
    return this.flushLock.run(async () => {
      const report = emptyReport();
      let open: IntentRecord[];
      try {
        open = await this.ledger.submitted();
      } catch (err) {
        if (!(err instanceof StoreError)) throw err;
        this.log.error("the queue store could not be read during recovery", { code: err.code });
        return report;
      }
      if (open.length === 0) return report;
      this.log.info("recovering intents that were in flight when the service stopped", { count: open.length });
      // Without waiting: if another copy holds the relayer, it is doing this itself.
      await this.underLock(report, 0, async (lock) => this.reconcile(await this.ledger.submitted(), report, false, lock));
      const left = await this.ledger.submitted().catch(() => []);
      this.log.info("recovery finished", { settled: report.settled, skipped: report.skipped, failed: report.failed, stillInFlight: left.length });
      return report;
    });
  }

  private async sendNext(report: FlushReport, lock: Lock): Promise<void> {
    const now = BigInt(this.now());
    let batch: IntentRecord[] = [];
    const expired: IntentRecord[] = [];
    for (const r of await this.ledger.queued(this.caps.maxBatchSize)) {
      if (BigInt(r.deadline) < now) expired.push(this.next(r, "expired", { reason: "the deadline passed before the intent was submitted" }));
      else batch.push(r);
    }
    // A held payment that was never released stops counting against its payer when it dies.
    for (const r of await this.ledger.held(HELD_SCAN)) {
      if (BigInt(r.deadline) < now) expired.push(this.next(r, "expired", { reason: "the deadline passed while the payment was held, and nothing was charged" }));
    }
    if (expired.length > 0) {
      await this.ledger.update(expired, lock);
      report.expired += expired.length;
    }
    if (batch.length === 0) return;

    // Find a batch that fits the gas cap: halve it until the estimate is under the ceiling.
    let data = this.encodeBatch(batch);
    let gas: bigint;
    for (;;) {
      try {
        gas = await this.provider.estimateGas({ from: this.relayer.address, to: this.routerAddress, data });
      } catch (err) {
        if (isTransient(err)) {
          this.log.warn("the node could not be reached to estimate a batch; it stays queued");
          return; // not the intents' fault: they are not counted against
        }
        await this.failAttempt(batch, revertName(err), report, lock);
        return;
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
      return;
    }
    const batchId = keccakText(batch.map((r) => r.id).join(",")).slice(0, 18);
    let current = batch.map((r) => this.next(r, "submitted", { batch: batchId, fromBlock }));
    await this.ledger.update(current, lock); // before the transaction exists. If this write fails, nothing is sent.

    let broadcast = false;
    let receipt: TransactionReceipt;
    try {
      receipt = await this.relayer.sendCall(
        { to: this.routerAddress, data, gasLimit: gas },
        async (hash) => {
          broadcast = true;
          current = current.map((r) => ({ ...r, transaction: hash }));
          this.log.info("batch broadcast", { batch: batchId, transaction: hash, intents: current.length });
          await this.ledger.update(current, lock); // the hash, as soon as the node has it
        },
        lock,
      );
    } catch (err) {
      if (err instanceof CapError && !broadcast) {
        await this.ledger.update(batch, lock); // something held it before anything was signed: the intents go back to the queue as they were
        report.held = err.code;
        await this.refused("batch", err.code);
        return;
      }
      // Not confirmed in time, or refused by the node. It may or may not be on the network: the chain says which.
      this.log.warn("the batch was not confirmed; checking the chain", { batch: batchId });
      await this.reconcile(current, report, true, lock);
      return;
    }
    report.submitted = batch.length;
    report.transaction = receipt.hash;
    report.gasUsed = receipt.gasUsed;
    await this.applyReceipt(current, receipt, report, lock);
    this.log.info("batch confirmed", { batch: batchId, transaction: receipt.hash, settled: report.settled, skipped: report.skipped, failed: report.failed, gasUsed: receipt.gasUsed });
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
  private async applyReceipt(records: IntentRecord[], receipt: TransactionReceipt, report: FlushReport, lock: Lock): Promise<void> {
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
    await this.ledger.update(updates, lock);
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
  private async reconcile(records: IntentRecord[], report: FlushReport, counted: boolean, lock: Lock): Promise<void> {
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
      await this.applyReceipt(group, receipt, report, lock);
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
    if (updates.length > 0) await this.ledger.update(updates, lock);
    if (pending.length > 0) this.log.info("intents still in flight", { count: pending.length });
  }

  /** An intent whose batch did not settle it goes back to the queue, or fails after its third try. */
  private putBack(r: IntentRecord, reason: string, updates: IntentRecord[], report: FlushReport, counted: boolean): void {
    const tries = (r.tries ?? 0) + (counted ? 1 : 0);
    if (counted && tries >= 3) {
      updates.push(this.next(r, "failed", { reason, tries }));
      report.failed += 1;
      return;
    }
    updates.push(this.next(r, "queued", { batch: undefined, fromBlock: undefined, transaction: undefined, tries: tries || undefined }));
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
  private async failAttempt(batch: IntentRecord[], reason: string, report: FlushReport, lock: Lock): Promise<void> {
    const updates = batch.map((r) => {
      const tries = (r.tries ?? 0) + 1;
      if (tries < 3) return { ...r, tries };
      report.failed += 1;
      return this.next(r, "failed", { reason, tries });
    });
    await this.ledger.update(updates, lock);
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
    // Only something shaped like an address is written to the log: anything else a caller sends could be a secret sent by mistake.
    const named = (body as { payer?: unknown } | null)?.payer;
    const claimed = typeof named === "string" && /^0x[0-9a-fA-F]{40}$/.test(named) ? named : undefined;
    const refuse = async (detail: string): Promise<OnboardResponse> => {
      await this.refused("zero-QIE start", detail, claimed);
      return { ok: false, error: ERRORS.onboardRefused, detail };
    };
    const stoppedBy = async (code: ErrorCode): Promise<OnboardResponse> => {
      await this.refused("zero-QIE start", code, claimed);
      return { ok: false, error: code, detail: gateDetail(code) };
    };
    const blocked = await this.gate();
    if (blocked) return stoppedBy(blocked);
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

      const need = (approve.gasLimit + deposit.gasLimit) * gasPrice;
      const topUp = need > qie ? need - qie : 0n;
      if (topUp > this.caps.maxTopUpWei) return refuse(`the top-up would be ${topUp} wei, above the cap of ${this.caps.maxTopUpWei}`);
      const key = `onboard:${this.day()}:${payer.toLowerCase()}`;
      const topUpKey = `topup:${this.day()}:${payer.toLowerCase()}`;
      try {
        // Counted, and the QIE it would send counted with it, before any QIE moves, so a failure part-way is not a free retry. Both
        // counters rise together or not at all, so two copies given the same wallet cannot each find room.
        const over = await this.ledger.take([
          { key, amount: 0n, maxCount: this.caps.onboardPerPayerPerDay },
          { key: topUpKey, amount: topUp, maxAmount: this.caps.topUpPerAddressDailyWei },
        ]);
        if (over === 0) return refuse("this wallet has used today's zero-QIE starts");
        if (over !== undefined) return refuse(`this wallet has used the QIE the facilitator tops up for one address in a day (${this.caps.topUpPerAddressDailyWei} wei)`);
      } catch (err) {
        if (err instanceof StoreError) return stoppedBy(ERRORS.storeUnavailable);
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
          if (!(await this.maySend())) {
            await this.refused("zero-QIE start", ERRORS.killSwitch, payer);
            return { ...out, ok: false, error: ERRORS.killSwitch, detail: gateDetail(ERRORS.killSwitch) };
          }
          const sent = await this.provider.broadcastTransaction(raw);
          const receipt = await sent.wait(1, this.payerReceiptTimeoutMs);
          out[label] = sent.hash;
          if (!receipt || receipt.status !== 1) return { ...out, ok: false, error: ERRORS.onboardRefused, detail: `${label} did not succeed` };
        }
      } catch (err) {
        const code = err instanceof CapError ? err.code : err instanceof StoreError ? ERRORS.storeUnavailable : ERRORS.onboardRefused;
        await this.refused("zero-QIE start", code, payer);
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
    let who: string | undefined;
    const refuse = async (detail: string): Promise<RelayResponse> => {
      await this.refused("relayed request", detail, who);
      return { ok: false, error: ERRORS.relayRefused, detail };
    };
    const stoppedBy = async (code: ErrorCode): Promise<RelayResponse> => {
      await this.refused("relayed request", code, who);
      return { ok: false, error: code, detail: gateDetail(code) };
    };
    const blocked = await this.gate();
    if (blocked) return stoppedBy(blocked);
    if (typeof body !== "object" || body === null) return refuse("the request must be a JSON object");
    const b = body as Record<string, unknown>;
    const text = (k: string): string => {
      const v = b[k];
      if (typeof v !== "string") throw new Error(`${k} is required`);
      return v;
    };
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
    const key = `relay:${this.day()}:${(who as string).toLowerCase()}`;
    const usedUp = "this account has used today's relayed requests";
    try {
      if ((await this.ledger.usage(key)).count >= this.caps.relayPerAccountPerDay) return refuse(usedUp);
      let gas: bigint;
      try {
        gas = await this.provider.estimateGas({ from: this.relayer.address, to: target, data });
      } catch (err) {
        return refuse(`the contract would refuse it: ${revertName(err)}`);
      }
      const out = await this.relayer.withLock(async (lock): Promise<RelayResponse> => {
        // Counted under the lock and only if there is room, so that two requests at once cannot both take the last place.
        if ((await this.ledger.take([{ key, amount: 0n, maxCount: this.caps.relayPerAccountPerDay }])) !== undefined) return refuse(usedUp);
        const receipt = await this.relayer.sendCall({ to: target, data, gasLimit: (gas * 12n) / 10n }, undefined, lock);
        if (receipt.status !== 1) return refuse("the transaction failed");
        return { ok: true, transaction: receipt.hash };
      });
      if (out === BUSY) return refuse("the relayer is busy with another transaction; send the request again");
      return out;
    } catch (err) {
      if (err instanceof StoreError) return stoppedBy(ERRORS.storeUnavailable);
      const code = err instanceof CapError ? err.code : ERRORS.relayRefused;
      await this.refused("relayed request", code, who);
      return { ok: false, error: code, detail: err instanceof CapError ? err.message : "the transaction was not accepted" };
    }
  }

  // ------------------------------------------------------------------------------------------------ health

  async health() {
    const token = new Contract(this.asset, ERC20_ABI as unknown as string[], this.provider);
    const [balance, qusdc] = await Promise.all([this.relayer.balance(), token.getFunction("balanceOf")(this.relayer.address) as Promise<bigint>]);
    if (qusdc > 0n) await this.relayer.raise("holds_qusdc", "the relayer address holds QUSDC, which it should never do");
    const lowBalance = balance < this.lowBalanceWei;
    if (lowBalance) await this.relayer.raise("low_balance", `the relayer holds less than ${this.lowBalanceWei} wei of QIE: top it up before it cannot send`);
    const store = await this.ledger.health();
    // What the ledger cannot say is given as nothing, and the switch as on: the service sends nothing while it cannot be asked.
    const day = this.day();
    let budget = { day, budgetWei: this.caps.dailyBudgetWei, spentWei: 0n, reservedWei: 0n, remainingWei: 0n };
    let open: IntentRecord[] = [];
    let queued = 0;
    let lastSettled: { blockNumber: number | null; at: number } | null = null;
    let alerts: Array<{ at: number; kind: string; message: string }> = this.relayer.alerts;
    let killSwitch = true;
    let storeOk = store.ok;
    try {
      killSwitch = this.killSwitch.active() || (await this.ledger.killSwitchOn());
      budget = await this.relayer.budget();
      open = await this.ledger.submitted();
      queued = await this.ledger.queuedCount();
      lastSettled = await this.lastSettled();
      alerts = await this.ledger.alerts();
    } catch (err) {
      if (!(err instanceof StoreError)) throw err;
      storeOk = false;
    }
    return {
      // False tells a health check to restart or replace the service: it cannot record what it is told, or it is shutting down.
      ok: storeOk && !this.draining,
      killSwitch,
      draining: this.draining,
      store: { healthy: storeOk, ...(storeOk ? {} : { problem: store.problem ?? "the queue store could not be reached" }) },
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
        day: budget.day,
        budgetWei: budget.budgetWei.toString(),
        spentWei: budget.spentWei.toString(),
        reservedWei: budget.reservedWei.toString(),
        remainingWei: budget.remainingWei.toString(),
      },
      queued,
      // When the last intent settled, and in which block, so a status page can say how long ago the service last did its work. Null until one has.
      lastSettled,
      alerts,
    };
  }

  /** The time and block of the last settlement, and nothing else: /health is public and holds no 32-byte value, so none can be taken for a key. */
  private async lastSettled(): Promise<{ blockNumber: number | null; at: number } | null> {
    const r = await this.ledger.latestSettled();
    return r ? { blockNumber: r.blockNumber ?? null, at: r.updatedAt } : null;
  }

  /**
   * Gauges for the private metrics path. Read from the ledger and the relayer, so they survive a restart. No payer, payee, amount or
   * key is in them: counts, ages and the relayer's own balance.
   */
  async metrics() {
    const h = await this.health();
    const counts = await this.ledger.countByStatus();
    const queued = await this.ledger.queued(HARD_CAPS.maxBatchSize * 1000);
    const oldestQueued = queued.length ? Math.max(0, this.now() - Math.min(...queued.map((r) => r.createdAt))) : 0;
    const last = await this.lastSettled();
    return {
      intents: counts,
      oldestQueuedAgeSeconds: oldestQueued,
      inFlight: h.inFlight.count,
      oldestInFlightAgeSeconds: h.inFlight.oldestAgeSeconds,
      killSwitch: h.killSwitch,
      lowBalance: h.lowBalance,
      draining: h.draining,
      storeHealthy: h.store.healthy,
      relayerBalanceWei: h.relayerBalanceWei,
      budgetWei: h.budget.budgetWei,
      spentWei: h.budget.spentWei,
      alerts: h.alerts.length,
      lastSettledBlock: last?.blockNumber ?? null,
      lastSettledAt: last?.at ?? null,
    };
  }
}

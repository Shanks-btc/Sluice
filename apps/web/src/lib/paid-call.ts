// A real paid call from the browser: ask a tool server for its price, show exactly what the wallet will sign, sign one payment with the
// connected wallet, send it to the tool server, and follow the intent until the facilitator settles it on chain.
//
//   1. readToolServer   GET /health: which router, which payee, which tools and prices. Refused if it is another router or chain.
//   2. planPaidCall     POST /mcp with no payment: the server answers with its price. The price is checked against this page's own
//                       settings (network, token, router, tool, a ceiling) before anything is shown, and the plan lists every field
//                       the wallet will sign in words.
//   3. PaidCallSession  confirm() then send(). send() refuses from every state but "confirmed", so a signature cannot be requested
//                       without the person pressing Confirm, and a second press cannot make a second payment.
//   4. trackSettlement  GET the facilitator's /status until the intent is settled, then read the chain for the Settled event.
//
// Nothing here holds a key. The wallet signs one typed message (docs/SPEC.md, "The signed intent"); the router checks it on chain.
import { getAddress } from "ethers";
import { routerInterface } from "@sluice/sdk/abi";
import { PAYMENT_META_KEY, PAYMENT_TYPES, SCHEME, X402_VERSION, newNonce, routerDomain, toWire, toolIdOf } from "@sluice/sdk/protocol";
import type { Intent, PaymentPayload, PaymentRequirements } from "@sluice/sdk/protocol";
import { parsePaymentRequired, resourceFor, settlementOf } from "@sluice/sdk/x402";
import { WalletError, networkState } from "./eip1193";
import { SluiceCallError } from "./errors";
import type { ErrorKind } from "./errors";
import { getStatus } from "./facilitator";
import type { FetchLike } from "./facilitator";
import { NotConfirmedError, signTyped } from "./flows";
import type { Field, FlowDeps } from "./flows";
import { formatUsdc, formatUtc, isAddress } from "./format";
import { explorerTxUrl } from "./networks";
import type { NetworkInfo } from "./networks";

// ------------------------------------------------------------------------------------------------------- http

export type HttpFetch = (
  url: string,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string; signal?: AbortSignal; credentials?: "omit"; referrerPolicy?: "no-referrer" },
) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export const MAX_REPLY_CHARS = 200_000;
export const CALL_TIMEOUT_MS = 20_000;
/** A call that carries a payment may wait for the chain before it is answered, so it is given longer than a call that asks a price. */
export const PAY_TIMEOUT_MS = 60_000;
/** How often the same signed payment is sent again while the server says it is not yet known to have settled. */
export const PAYMENT_RESENDS = 3;
const NOT_YET = new Set(["sluice_payment_pending", "payment_in_progress"]);

const defaultFetch: HttpFetch = (url, init) => fetch(url, init as RequestInit);

type Posted = { status: number; requestId?: string; json: unknown };

/** POSTs one JSON-RPC message to a tool server's /mcp and reads its answer as JSON, or as the first event of an event stream. */
async function postMcp(base: string, message: unknown, fetchImpl: HttpFetch, timeoutMs = CALL_TIMEOUT_MS): Promise<Posted> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(message),
      signal: controller.signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    const text = await res.text();
    if (text.length > MAX_REPLY_CHARS) throw new SluiceCallError("too_large", "the answer was larger than the page will read", "tool_server");
    const requestId = res.headers.get("x-request-id") ?? undefined;
    const body = text.trimStart().startsWith("event:") || text.trimStart().startsWith("data:") ? (/^data: ?(.*)$/m.exec(text)?.[1] ?? "") : text;
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      if (res.status === 429) throw new SluiceCallError("sluice_rate_limited", "too many requests", "tool_server");
      throw new SluiceCallError("unreadable", `the tool server answered with something that is not JSON (HTTP ${res.status})`, "tool_server");
    }
    if (res.status === 429) throw new SluiceCallError("sluice_rate_limited", "too many requests", "tool_server");
    return { status: res.status, requestId, json };
  } catch (err) {
    if (err instanceof SluiceCallError) throw err;
    throw new SluiceCallError("unreachable", "the tool server could not be reached from this browser", "tool_server");
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------------------------------------ the tool server

export type ToolListing = { name: string; price: string };
export type ToolServerInfo = { chainId: number; router: string; payee: string; tools: ToolListing[] };

const TOOL_NAME = /^[a-z0-9_]{1,64}$/;
const PRICE = /^\d{1,9}(\.\d{1,6})?$/;

/** Reads what a tool server says about itself, strictly: each field is checked, and anything else it sends is dropped. */
export function parseToolServerHealth(json: unknown): ToolServerInfo | undefined {
  if (typeof json !== "object" || json === null) return undefined;
  const j = json as Record<string, unknown>;
  if (j.ok !== true || typeof j.chainId !== "number" || !Number.isSafeInteger(j.chainId)) return undefined;
  if (typeof j.router !== "string" || !isAddress(j.router) || typeof j.payee !== "string" || !isAddress(j.payee)) return undefined;
  if (!Array.isArray(j.tools)) return undefined;
  const tools: ToolListing[] = [];
  for (const t of j.tools.slice(0, 64)) {
    const o = t as Record<string, unknown> | null;
    if (o && typeof o.name === "string" && TOOL_NAME.test(o.name) && typeof o.price === "string" && PRICE.test(o.price)) tools.push({ name: o.name, price: o.price });
  }
  return { chainId: j.chainId, router: getAddress(j.router), payee: getAddress(j.payee), tools };
}

export type ToolServerRead = { ok: true; info: ToolServerInfo } | { ok: false; reason: string; down: boolean };

/** Reads the tool server's /health and checks it is the one this page is set up for: the same chain and the same router. */
export async function readToolServer(toolsUrl: string, expected: { chainId: number; router: string }, fetchImpl: HttpFetch = defaultFetch): Promise<ToolServerRead> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetchImpl(`${toolsUrl}/health`, { method: "GET", headers: { accept: "application/json" }, signal: controller.signal, credentials: "omit", referrerPolicy: "no-referrer" });
    const text = await res.text();
    if (text.length > MAX_REPLY_CHARS) return { ok: false, reason: "The tool server's answer was larger than the page will read.", down: false };
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, reason: "The tool server answered with something that is not JSON.", down: true };
    }
    const info = parseToolServerHealth(json);
    if (!info) return { ok: false, reason: "That address answered, but not like a Sluice tool server.", down: false };
    if (info.chainId !== expected.chainId) return { ok: false, reason: `The tool server is on chain ${info.chainId}, and this page is on chain ${expected.chainId}.`, down: false };
    if (info.router !== getAddress(expected.router)) return { ok: false, reason: "The tool server settles through a different router than this page uses, so nothing would be paid here.", down: false };
    return { ok: true, info };
  } catch {
    return { ok: false, reason: "The tool server could not be reached from this browser.", down: true };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------------------------------------------ the quote

export type Quote = {
  tool: string;
  /** The price in QUSDC units. */
  amount: bigint;
  payTo: string;
  asset: string;
  router: string;
  toolId: string;
  network: string;
  maxTimeoutSeconds: number;
  requirements: PaymentRequirements;
};

export type PaidCallDeps = FlowDeps & {
  /** The hosted tool server, without a trailing slash. */
  toolsUrl: string;
  /** The most one call or one deposit may be, in QUSDC units. */
  sessionCapUnits: number;
  /** For the explorer link in a receipt. */
  network: NetworkInfo;
  fetchImpl?: HttpFetch;
  /** The wait before the same payment is sent again. Default 4 seconds. */
  resendDelayMs?: number;
};

/** The price a tool server asks for a call with no payment, checked against this page's own settings before it is shown. */
export async function askPrice(deps: PaidCallDeps, server: ToolServerInfo, tool: string, args: Record<string, unknown>): Promise<Quote> {
  if (!TOOL_NAME.test(tool)) throw new SluiceCallError("invalid_tool", "the tool name is not valid", "tool_server");
  const posted = await postMcp(deps.toolsUrl, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }, deps.fetchImpl ?? defaultFetch);
  const body = posted.json as { result?: unknown; error?: { message?: unknown } } | null;
  if (!body || typeof body !== "object") throw new SluiceCallError("unreadable", "the tool server's answer was not a JSON-RPC message", "tool_server");
  if (body.error) throw new SluiceCallError("rpc_error", "the tool server refused the request", "tool_server");
  const required = parsePaymentRequired(body.result);
  if (!required) {
    throw new SluiceCallError("not_priced", "the tool server did not ask for a payment for this call, so there is nothing to pay", "tool_server");
  }
  const want = required.accepts.find((a) => a.scheme === SCHEME);
  if (!want) throw new SluiceCallError("invalid_scheme", "the tool server does not accept the Sluice payment scheme", "tool_server");
  const problem = checkRequirements(deps, server, tool, want);
  if (problem) throw new SluiceCallError(problem.code, problem.message, "tool_server");
  return {
    tool,
    amount: BigInt(want.amount),
    payTo: getAddress(want.payTo),
    asset: getAddress(want.asset),
    router: getAddress(want.extra.router),
    toolId: want.extra.toolId,
    network: want.network,
    maxTimeoutSeconds: want.maxTimeoutSeconds,
    requirements: want,
  };
}

/** Every field of the price that could send money somewhere this page did not mean, checked against the page's own settings. */
export function checkRequirements(deps: Pick<PaidCallDeps, "chainId" | "reader" | "sessionCapUnits">, server: Pick<ToolServerInfo, "payee">, tool: string, r: PaymentRequirements): { code: string; message: string } | undefined {
  if (r.network !== `eip155:${deps.chainId}`) return { code: "invalid_network", message: "the price is for a different network than this page" };
  if (!/^\d{1,18}$/.test(r.amount) || BigInt(r.amount) <= 0n) return { code: "invalid_payment_requirements", message: "the price is not a positive amount" };
  if (BigInt(r.amount) > BigInt(deps.sessionCapUnits)) return { code: "over_cap", message: `the price is above the ${formatUsdc(BigInt(deps.sessionCapUnits))} QUSDC this page allows for one call` };
  if (!isAddress(r.asset) || getAddress(r.asset) !== getAddress(deps.reader.tokenAddress)) return { code: "invalid_sluice_asset", message: "the price is in a different token than the router holds" };
  if (!isAddress(r.extra.router) || getAddress(r.extra.router) !== getAddress(deps.reader.routerAddress)) return { code: "invalid_sluice_router", message: "the price names a different router" };
  if (r.extra.toolId !== toolIdOf(tool)) return { code: "sluice_tool_mismatch", message: "the price is for a different tool" };
  if (!isAddress(r.payTo) || getAddress(r.payTo) !== getAddress(server.payee)) return { code: "sluice_payee_mismatch", message: "the price names a payee other than the one the tool server declared" };
  if (!Number.isInteger(r.maxTimeoutSeconds) || r.maxTimeoutSeconds < 20) return { code: "invalid_payment_requirements", message: "the price leaves too little time to pay" };
  return undefined;
}

// ------------------------------------------------------------------------------------------------------ the plan

export type PaidCallPlan = {
  title: string;
  summary: string;
  /** What the wallet will be asked to sign, in words: the decoded typed message. */
  fields: Field[];
  steps: string[];
  warnings: string[];
  quote: Quote;
  intent: Intent;
  args: Record<string, unknown>;
  /** The prepaid balance before and after the call. */
  prepaid: { before: bigint; after: bigint };
};

export type PaidCallPlanResult = { ok: true; plan: PaidCallPlan } | { ok: false; reason: string; kind: ErrorKind };

export const INTENT_LIFETIME_SECONDS = 300;

const toolLabel = (tool: string): string => tool.replace(/_/g, " ");

export async function planPaidCall(deps: PaidCallDeps, server: ToolServerInfo, tool: string, args: Record<string, unknown>): Promise<PaidCallPlanResult> {
  if (!server.tools.some((t) => t.name === tool)) return { ok: false, reason: "The tool server does not offer that tool.", kind: "refused" };
  let quote: Quote;
  try {
    quote = await askPrice(deps, server, tool, args);
  } catch (err) {
    const e = err instanceof SluiceCallError ? err : new SluiceCallError("unreachable", "the tool server could not be reached", "tool_server");
    const kind: ErrorKind = e.stage === "tool_server" && (e.code === "unreachable" || e.code === "unreadable") ? "tool_down" : "refused";
    return { ok: false, reason: kind === "tool_down" ? "The tool server did not answer, so no price could be read. Nothing was signed." : `${capitalise(e.message)}. Nothing was signed.`, kind };
  }
  const prepaid = (await deps.reader.router.getFunction("payerBalance")(deps.account)) as bigint;
  if (prepaid < quote.amount) {
    return {
      ok: false,
      kind: "insufficient_prepaid",
      reason: `Your prepaid balance in the router is ${formatUsdc(prepaid)} QUSDC, which is less than this call's ${formatUsdc(quote.amount)} QUSDC. Deposit first.`,
    };
  }
  const lifetime = Math.min(quote.maxTimeoutSeconds, INTENT_LIFETIME_SECONDS);
  const intent: Intent = {
    payer: getAddress(deps.account),
    payee: quote.payTo,
    amount: quote.amount,
    toolId: quote.toolId,
    nonce: deps.random ? deps.random() : newNonce(),
    deadline: BigInt(deps.now() + lifetime),
  };
  // The network the site is set to, not the one a chain id suggests: a local copy of mainnet has mainnet's id and no real funds.
  const network = deps.network;
  return {
    ok: true,
    plan: {
      title: `Pay for ${toolLabel(tool)}`,
      summary: "Your wallet will sign one payment message. It sends no transaction and costs no QIE. The tool runs when the tool server accepts the payment, and the facilitator settles it on chain a few seconds later.",
      fields: [
        { label: "Action", value: `Pay for one call to ${tool}` },
        { label: "Price", value: `${formatUsdc(quote.amount)} QUSDC` },
        { label: "Paid to", value: `${quote.payTo} (the tool's builder)` },
        { label: "From", value: `${intent.payer} (your prepaid balance in the router)` },
        { label: "Prepaid balance", value: `${formatUsdc(prepaid)} QUSDC now, ${formatUsdc(prepaid - quote.amount)} QUSDC after` },
        { label: "Router", value: quote.router },
        { label: "Token", value: `${quote.asset} (QUSDC)` },
        { label: "Tool id", value: quote.toolId },
        { label: "Valid until", value: `${formatUtc(Number(intent.deadline))} (${Math.round(lifetime / 60)} minutes)` },
        { label: "Nonce", value: `${intent.nonce.slice(0, 18)}… (makes this payment usable once)` },
        { label: "Network", value: `${network.label}, chain ${deps.chainId}${network.realFunds ? " (real funds)" : " (no real funds)"}` },
        { label: "Network fee", value: "None for you. The facilitator pays the gas when it settles." },
      ],
      steps: ["Your wallet signs the payment (no transaction)", "The tool server verifies it with the facilitator and runs the tool", "The facilitator settles it on chain, and the receipt appears here"],
      warnings: ["The signature can be used once, for this price, to this payee, until it expires. It cannot move anything else.", ...(network.realFunds ? ["This spends real QUSDC from your prepaid balance."] : [])],
      quote,
      intent,
      args,
      prepaid: { before: prepaid, after: prepaid - quote.amount },
    },
  };
}

const capitalise = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

// ---------------------------------------------------------------------------------------------------- the session

export type PaidCallState = "planned" | "confirmed" | "signing" | "paying" | "paid" | "cancelled" | "failed";

export type PaidCallResult = {
  tool: string;
  amount: bigint;
  payer: string;
  payee: string;
  intent: Intent;
  signature: string;
  /** The tool's answer: structured content if it sent any, otherwise its text. */
  output: unknown;
  text: string;
  /** The facilitator's id for the intent, and where it stood when the tool server answered. */
  intentId?: string;
  status?: string;
  requestId?: string;
};

/**
 * One planned payment and its state. It moves planned -> confirmed -> signing -> paying -> paid (or failed), and to cancelled from
 * planned or confirmed. `send` refuses from every state but "confirmed", which is what stops a signature being asked for without a
 * confirm, and stops a second press from making a second payment: the first press leaves "confirmed" at once.
 */
export class PaidCallSession {
  private current: PaidCallState = "planned";
  private outcome?: PaidCallResult;
  private failure?: unknown;

  constructor(
    readonly plan: PaidCallPlan,
    private readonly deps: PaidCallDeps,
  ) {}

  get state(): PaidCallState {
    return this.current;
  }
  get result(): PaidCallResult | undefined {
    return this.outcome;
  }
  get error(): unknown {
    return this.failure;
  }

  confirm(): void {
    if (this.current !== "planned") throw new Error(`cannot confirm a payment that is ${this.current}`);
    this.current = "confirmed";
  }

  cancel(): void {
    if (this.current === "planned" || this.current === "confirmed") this.current = "cancelled";
  }

  async send(): Promise<PaidCallResult> {
    if (this.current !== "confirmed") throw new NotConfirmedError();
    this.current = "signing";
    try {
      this.outcome = await this.pay();
      this.current = "paid";
      return this.outcome;
    } catch (err) {
      this.failure = err;
      this.current = "failed";
      throw err;
    }
  }

  private async pay(): Promise<PaidCallResult> {
    const { deps, plan } = this;
    const { quote, intent } = plan;
    const walletChain = await deps.wallet.request({ method: "eth_chainId" }).catch(() => null);
    const current = typeof walletChain === "string" ? Number.parseInt(walletChain, 16) : null;
    if (networkState(current, deps.chainId) === "wrong") throw new WalletError("wrong_network", "wrong network");
    if (BigInt(deps.now()) >= intent.deadline) throw new SluiceCallError("sluice_intent_expired", "the quote ran out of time before it was signed", "wallet");

    const domain = routerDomain(quote.router, deps.chainId) as unknown as Record<string, unknown>;
    const signature = await signTyped(deps, { domain, types: PAYMENT_TYPES, primaryType: "Payment", message: toWire(intent) as unknown as Record<string, unknown> });

    const payload: PaymentPayload = {
      x402Version: X402_VERSION,
      resource: resourceFor(quote.tool),
      accepted: quote.requirements,
      payload: { signature, authorization: toWire(intent) },
    };
    this.current = "paying";
    const message = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: quote.tool, arguments: plan.args, _meta: { [PAYMENT_META_KEY]: payload } } };
    let posted: Posted;
    let result: Record<string, unknown>;
    for (let sent = 0; ; sent++) {
      try {
        posted = await postMcp(deps.toolsUrl, message, deps.fetchImpl ?? defaultFetch, PAY_TIMEOUT_MS);
      } catch (err) {
        // Sent before and answered "not yet": silence now says nothing about the payment.
        if (sent > 0) throw new SluiceCallError("sluice_payment_pending", "the payment is not yet known to have settled", "tool_server");
        // The signed payment left the page and nothing came back: it may have arrived.
        if (err instanceof SluiceCallError && (err.code === "unreachable" || err.code === "unreadable")) throw new SluiceCallError("unconfirmed", "the tool server did not answer after the payment was signed", "tool_server");
        throw err;
      }
      const body = posted.json as { result?: Record<string, unknown>; error?: unknown } | null;
      if (!body || typeof body !== "object" || body.error || typeof body.result !== "object" || body.result === null) {
        throw new SluiceCallError("rpc_error", "the tool server refused the request", "tool_server");
      }
      result = body.result;
      // The same signed payment is sent again, never a new one: the server gives its answer once the payment has settled.
      const code = (result.structuredContent as { error?: unknown } | undefined)?.error;
      if (result.isError !== true || typeof code !== "string" || !NOT_YET.has(code) || sent >= PAYMENT_RESENDS) break;
      await new Promise<void>((resolve) => setTimeout(resolve, deps.resendDelayMs ?? 4_000));
    }
    if (result.isError === true) {
      const sc = result.structuredContent as { error?: unknown } | undefined;
      const code = typeof sc?.error === "string" ? sc.error : "tool_error";
      throw new SluiceCallError(code, "the tool server did not accept the payment", "tool_server");
    }
    const settlement = settlementOf(result);
    const text = (Array.isArray(result.content) ? (result.content as Array<{ type?: string; text?: string }>).find((c) => c.type === "text")?.text : undefined) ?? "";
    if (!settlement || settlement.success !== true) {
      throw new SluiceCallError(typeof settlement?.errorReason === "string" ? settlement.errorReason : "no_settlement", "the tool answered but the payment was not accepted", "facilitator");
    }
    const sluice = settlement.extensions?.sluice;
    return {
      tool: quote.tool,
      amount: quote.amount,
      payer: intent.payer,
      payee: intent.payee,
      intent,
      signature,
      output: (result.structuredContent as unknown) ?? text,
      text,
      intentId: sluice?.id,
      status: sluice?.status,
      requestId: posted.requestId,
    };
  }
}

// -------------------------------------------------------------------------------------------------- settlement

export type Receipt = {
  transaction: string;
  blockNumber: number;
  /** Unix seconds, from the block. */
  timestamp: number;
  payer: string;
  payee: string;
  amount: bigint;
  fee: bigint;
  toolId: string;
  nonce: string;
  explorerUrl?: string;
};

export type SettlementView =
  | { state: "pending"; status: string }
  | { state: "settled"; status: string; receipt: Receipt }
  | { state: "not_settled"; status: string; reason?: string }
  | { state: "unknown"; reason: string };

const TERMINAL_BAD = new Set(["skipped", "expired", "failed"]);

/** Reads the chain for the Settled event of one intent and turns it into a receipt. Undefined when the transaction has no such event. */
export async function readReceipt(deps: Pick<PaidCallDeps, "reader" | "network">, transaction: string, nonce: string, payer: string): Promise<Receipt | undefined> {
  const receipt = await deps.reader.provider.getTransactionReceipt(transaction);
  if (!receipt || receipt.status !== 1) return undefined;
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== getAddress(deps.reader.routerAddress)) continue;
    let parsed;
    try {
      parsed = routerInterface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      continue;
    }
    if (parsed?.name !== "Settled") continue;
    if (String(parsed.args.nonce).toLowerCase() !== nonce.toLowerCase() || getAddress(String(parsed.args.payer)) !== getAddress(payer)) continue;
    const block = await deps.reader.provider.getBlock(receipt.blockNumber);
    return {
      transaction,
      blockNumber: receipt.blockNumber,
      timestamp: block?.timestamp ?? 0,
      payer: getAddress(String(parsed.args.payer)),
      payee: getAddress(String(parsed.args.payee)),
      amount: BigInt(parsed.args.amount as bigint),
      fee: BigInt(parsed.args.fee as bigint),
      toolId: String(parsed.args.toolId),
      nonce: String(parsed.args.nonce),
      explorerUrl: explorerTxUrl(transaction, deps.network),
    };
  }
  return undefined;
}

/** One look at where an intent stands: the facilitator's status, and when it says settled, the chain's own record of it. */
export async function checkSettlement(
  deps: Pick<PaidCallDeps, "reader" | "network" | "facilitatorUrl">,
  id: string,
  nonce: string,
  payer: string,
  fetchImpl?: FetchLike,
): Promise<SettlementView> {
  if (!deps.facilitatorUrl) return { state: "unknown", reason: "No facilitator address is set, so the settlement cannot be followed from here." };
  const got = await getStatus(deps.facilitatorUrl, id, fetchImpl);
  if (!got.ok) return { state: "unknown", reason: got.reason };
  const status = got.status.status ?? "unknown";
  if (status === "settled" && got.status.transaction) {
    // The facilitator's word is checked against the chain's: the receipt is built from the Settled event, never from the status.
    const receipt = await readReceipt(deps, got.status.transaction, nonce, payer).catch(() => undefined);
    return receipt ? { state: "settled", status, receipt } : { state: "pending", status: "settled, waiting for the chain to show it" };
  }
  if (TERMINAL_BAD.has(status)) return { state: "not_settled", status, reason: got.status.reason };
  return { state: "pending", status };
}

/** Looks until the intent is settled or the time is up, `pollMs` apart. */
export async function trackSettlement(
  deps: Pick<PaidCallDeps, "reader" | "network" | "facilitatorUrl">,
  id: string,
  nonce: string,
  payer: string,
  options: { pollMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void>; fetchImpl?: FetchLike; onUpdate?: (view: SettlementView) => void } = {},
): Promise<SettlementView> {
  const pollMs = options.pollMs ?? 3_000;
  const timeoutMs = options.timeoutMs ?? 180_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let waited = 0;
  let last: SettlementView = { state: "pending", status: "queued" };
  for (;;) {
    last = await checkSettlement(deps, id, nonce, payer, options.fetchImpl);
    options.onUpdate?.(last);
    if (last.state === "settled" || last.state === "not_settled") return last;
    if (waited >= timeoutMs) return last;
    await sleep(pollMs);
    waited += pollMs;
  }
}

/** The decoded signed message as plain text, for a "what did I sign" panel after the fact. */
export function describeIntent(intent: Intent): Field[] {
  return [
    { label: "Payer", value: intent.payer },
    { label: "Payee", value: intent.payee },
    { label: "Amount", value: `${formatUsdc(intent.amount)} QUSDC` },
    { label: "Tool id", value: intent.toolId },
    { label: "Nonce", value: intent.nonce },
    { label: "Deadline", value: formatUtc(Number(intent.deadline)) },
  ];
}

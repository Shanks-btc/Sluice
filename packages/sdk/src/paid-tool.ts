// paidTool: payment middleware for MCP servers.
//
// A tool declares a price in QUSDC and a payee. Called without payment it returns an MCP error result carrying
// the payment requirements (x402 over MCP, scheme "sluice-intent"). Called with params._meta["x402/payment"] it
//
//   1. checks the signed intent itself (scheme, network, router, asset, payee, tool, amount >= price, deadline,
//      signature),
//   2. asks the facilitator's /verify about what only the chain knows (the payer's router balance, the nonce,
//      and an agent's session policy),
//   3. runs the tool,
//   4. queues the payment with the facilitator's /settle, and returns the tool's result with the settlement in
//      result._meta["x402/payment-response"].
//
// A tool that fails is not charged. The same intent never charges twice and never runs a tool twice: a repeat of
// the same call returns the first result, and the same intent on a different call is refused.
import { createHash } from "node:crypto";
import { getAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FacilitatorClient, FacilitatorUnavailable } from "./facilitator-client";
import type { FacilitatorApi } from "./facilitator-client";
import { resolvePayee } from "./names";
import type { NameResolver } from "./names";
import {
  CHAIN_ID,
  DEFAULT_TIMEOUT_SECONDS,
  ERRORS,
  PRICING_META_KEY,
  QUSDC_ADDRESS,
  checkPayment,
  formatQusdc,
  parseQusdc,
  toolIdOf,
} from "./protocol";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "./protocol";
import {
  buildPaymentRequired,
  buildRequirements,
  errorResult,
  paymentRequiredResult,
  readPayment,
  resourceFor,
  withSettlement,
} from "./x402";
import type { ToolResult } from "./x402";

/** What the tool handler learns about the payment it was paid with. */
export type PaymentInfo = {
  payer: string;
  /** The key that signed: the payer, or an agent session key. */
  signer: string;
  payee: string;
  amount: bigint;
  toolId: string;
  /** The intent's EIP-712 digest, also its id at the facilitator. */
  id: string;
};

export type ToolExtra = { _meta?: Record<string, unknown>; [key: string]: unknown };

export type PaidToolSpec = {
  /** The MCP tool name. Its keccak256 is the toolId every payment for it is bound to. */
  name: string;
  /** Price in QUSDC: a decimal string such as "0.01" (at most six places), or a bigint of units. */
  price: string | bigint;
  /** An address, or a .qie name (which needs a resolver). */
  payee: string;
  description?: string;
  maxTimeoutSeconds?: number;
};

export type PaywallConfig = {
  /** A facilitator client, or the URL of one. */
  facilitator: FacilitatorApi | string;
  /** The PaymentRouter this server accepts payment through. A payment naming any other router is refused. */
  router: string;
  /** The router's AgentVault. Advertised in the requirements; optional. */
  vault?: string;
  chainId?: number;
  asset?: string;
  resolver?: NameResolver;
  store?: IdempotencyStore;
  /** Unix seconds. Defaults to the wall clock. */
  now?: () => number;
  /** Called with a short event name for logging and tests. Never receives a signature. */
  onEvent?: (event: PaywallEvent) => void;
};

export type PaywallEvent =
  | { type: "payment_required"; tool: string; reason?: string }
  | { type: "verified"; tool: string; id: string }
  | { type: "executed"; tool: string; id: string }
  | { type: "settled"; tool: string; id: string; status?: string }
  | { type: "replayed"; tool: string; id: string }
  | { type: "refused_replay"; tool: string; id: string }
  | { type: "settle_failed"; tool: string; id: string; reason: string }
  | { type: "tool_failed"; tool: string; id: string };

export type IdempotencyEntry = {
  argsHash: string;
  state: "executed" | "settled";
  result: ToolResult;
  settlement?: SettleResponse;
};

/** Remembers what each intent was used for. The default lives in memory; a server that restarts can supply its own. */
export interface IdempotencyStore {
  get(id: string): Promise<IdempotencyEntry | undefined>;
  set(id: string, entry: IdempotencyEntry): Promise<void>;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, IdempotencyEntry>();
  async get(id: string) {
    return this.entries.get(id);
  }
  async set(id: string, entry: IdempotencyEntry) {
    this.entries.set(id, entry);
  }
}

export type PaidHandler<Args> = (args: Args, extra: ToolExtra, payment: PaymentInfo) => Promise<ToolResult> | ToolResult;

/** A stable string for a value: object keys sorted, so the same arguments always hash the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const hashArgs = (args: unknown) => createHash("sha256").update(canonicalJson(args)).digest("hex");

export class Paywall {
  private readonly facilitator: FacilitatorApi;
  private readonly store: IdempotencyStore;
  private readonly inflight = new Map<string, { argsHash: string; promise: Promise<ToolResult> }>();
  private readonly chainId: number;
  private readonly asset: string;
  private readonly now: () => number;

  constructor(private readonly config: PaywallConfig) {
    this.facilitator =
      typeof config.facilitator === "string" ? new FacilitatorClient({ url: config.facilitator }) : config.facilitator;
    this.store = config.store ?? new MemoryIdempotencyStore();
    this.chainId = config.chainId ?? CHAIN_ID;
    this.asset = getAddress(config.asset ?? QUSDC_ADDRESS);
    this.now = config.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** The requirements a call to this tool must meet. The payee must already be an address. */
  requirementsFor(spec: PaidToolSpec): PaymentRequirements {
    return buildRequirements({
      toolName: spec.name,
      amount: parseQusdc(spec.price),
      payTo: spec.payee,
      router: this.config.router,
      vault: this.config.vault,
      chainId: this.chainId,
      asset: this.asset,
      maxTimeoutSeconds: spec.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
      facilitator: typeof this.config.facilitator === "string" ? this.config.facilitator : undefined,
    });
  }

  /** The advertisement for tools/list. Advisory: the price that binds is the one in the payment-required result. */
  pricingMeta(spec: PaidToolSpec): Record<string, unknown> {
    const r = this.requirementsFor(spec);
    return {
      [PRICING_META_KEY]: {
        scheme: r.scheme,
        network: r.network,
        amount: r.amount,
        price: formatQusdc(BigInt(r.amount)),
        asset: r.asset,
        payTo: r.payTo,
        router: r.extra.router,
      },
    };
  }

  /**
   * Wraps a tool handler so it is paid for. The payee must be an address here; `registerPaidTool` resolves
   * names first.
   */
  paidTool<Args = Record<string, unknown>>(spec: PaidToolSpec, handler: PaidHandler<Args>) {
    const requirements = this.requirementsFor(spec);
    const resource = resourceFor(spec.name, spec.description);
    const tool = spec.name;
    const emit = (event: PaywallEvent) => this.config.onEvent?.(event);
    const required = (reason?: string): ToolResult => {
      emit({ type: "payment_required", tool, reason });
      return paymentRequiredResult(buildPaymentRequired(resource, [requirements], reason));
    };

    const execute = async (
      payment: PaymentPayload,
      id: string,
      info: PaymentInfo,
      args: Args,
      extra: ToolExtra,
      argsHash: string,
    ): Promise<ToolResult> => {
      let entry = await this.store.get(id);
      if (!entry) {
        let result: ToolResult;
        try {
          result = await handler(args, extra, info);
        } catch (err) {
          emit({ type: "tool_failed", tool, id });
          return errorResult("tool_error", err instanceof Error ? err.message : "the tool failed");
        }
        if (result.isError) {
          emit({ type: "tool_failed", tool, id });
          return result; // a failed call is not charged
        }
        entry = { argsHash, state: "executed", result };
        await this.store.set(id, entry);
        emit({ type: "executed", tool, id });
      }
      let settlement: SettleResponse;
      try {
        settlement = await this.facilitator.settle(payment, requirements);
      } catch (err) {
        const reason = err instanceof FacilitatorUnavailable ? err.message : "settlement could not be requested";
        emit({ type: "settle_failed", tool, id, reason });
        return errorResult(ERRORS.facilitatorUnavailable, reason);
      }
      if (!settlement.success) {
        const reason = settlement.errorReason ?? ERRORS.unexpectedSettle;
        emit({ type: "settle_failed", tool, id, reason });
        // x402 over MCP: if settlement fails after the tool ran, return the payment error, not the tool's content.
        return required(reason);
      }
      const done: IdempotencyEntry = { ...entry, state: "settled", settlement };
      await this.store.set(id, done);
      emit({ type: "settled", tool, id, status: settlement.extensions?.sluice?.status });
      return withSettlement(entry.result, settlement);
    };

    return async (args: Args, extra: ToolExtra): Promise<ToolResult> => {
      const payment = readPayment(extra?._meta);
      if (payment === undefined) return required();
      if (payment === "malformed") return required(ERRORS.invalidPayload);

      const check = checkPayment(payment, requirements, {
        chainId: this.chainId,
        router: this.config.router,
        asset: this.asset,
        now: this.now(),
      });
      if (!check.ok) return required(check.code);

      const id = check.digest;
      const argsHash = hashArgs(args);
      const info: PaymentInfo = {
        payer: check.intent.payer,
        signer: check.signer,
        payee: check.intent.payee,
        amount: check.intent.amount,
        toolId: check.intent.toolId,
        id,
      };

      // The same intent is never used for two different calls, and never runs the tool twice.
      const running = this.inflight.get(id);
      if (running) {
        if (running.argsHash !== argsHash) {
          emit({ type: "refused_replay", tool, id });
          return required(ERRORS.intentReplayed);
        }
        emit({ type: "replayed", tool, id });
        return running.promise;
      }
      // The in-flight entry is registered before anything is awaited, store lookup included. A store that is slow (a database)
      // would otherwise leave a gap in which two concurrent calls with one intent both found nothing and both ran the tool.
      const promise = (async (): Promise<ToolResult> => {
        const prior = await this.store.get(id);
        if (prior && prior.argsHash !== argsHash) {
          emit({ type: "refused_replay", tool, id });
          return required(ERRORS.intentReplayed);
        }
        if (prior?.state === "settled") {
          emit({ type: "replayed", tool, id });
          return withSettlement(prior.result, prior.settlement as SettleResponse);
        }
        if (!prior) {
          // Only the chain-dependent checks are left: balance, nonce and an agent's session policy.
          let verdict;
          try {
            verdict = await this.facilitator.verify(payment, requirements);
          } catch (err) {
            return errorResult(ERRORS.facilitatorUnavailable, err instanceof Error ? err.message : "verification failed");
          }
          if (!verdict.isValid) return required(verdict.invalidReason ?? ERRORS.unexpectedVerify);
          emit({ type: "verified", tool, id });
        }
        return execute(payment, id, info, args, extra, argsHash);
      })();
      this.inflight.set(id, { argsHash, promise });
      try {
        return await promise;
      } finally {
        this.inflight.delete(id);
      }
    };
  }

  /**
   * Registers a paid tool on an MCP server: resolves the payee, wraps the handler, and advertises the price in
   * the tool's _meta. A name that cannot be resolved throws here, at start-up, not on a caller's first request.
   */
  async registerPaidTool<Args = Record<string, unknown>>(
    server: McpServer,
    spec: PaidToolSpec & { title?: string; inputSchema?: Record<string, unknown>; annotations?: Record<string, unknown> },
    handler: PaidHandler<Args>,
  ): Promise<void> {
    const payee = await resolvePayee(spec.payee, this.config.resolver);
    const resolved: PaidToolSpec = { ...spec, payee };
    const wrapped = this.paidTool<Args>(resolved, handler);
    const description = `${spec.description ?? spec.name} Costs ${formatQusdc(parseQusdc(spec.price))} QUSDC per call, paid with x402 over MCP.`;
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description,
        inputSchema: (spec.inputSchema ?? {}) as never,
        annotations: spec.annotations as never,
        _meta: this.pricingMeta(resolved),
      },
      ((args: Args, extra: ToolExtra) => wrapped(args, extra)) as never,
    );
  }

  /** The toolId a payment for `name` must carry. */
  toolId(name: string): string {
    return toolIdOf(name);
  }
}

export function createPaywall(config: PaywallConfig): Paywall {
  return new Paywall(config);
}

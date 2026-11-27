// The payment proxy. An agent runs it in front of any upstream paid MCP server (x402 over MCP, scheme sluice-intent).
// It forwards every call. When the upstream answers "payment required", it checks the price against the owner's budget,
// signs an intent with the agent's session key, retries the call once with the payment attached, and returns the result.
//
// What it refuses, and tells the agent why: a tool the owner did not list, a payee the owner did not name, a price above
// the per-call cap, a purchase that would pass the total cap, an expired budget, and requirements for any other router,
// network, asset or scheme. It signs only with the session key it was given, and refuses to start if that key is the
// owner's address.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getAddress } from "ethers";
import {
  DEFAULT_TIMEOUT_SECONDS,
  ERRORS,
  PAYMENT_META_KEY,
  X402_VERSION,
  Mutex,
  errorResult,
  formatQusdc,
  intentDigest,
  newNonce,
  parsePaymentRequired,
  settlementOf,
  signIntent,
  toWire,
} from "@sluice/sdk";
import type { Intent, PaymentPayload, PaymentRequirements, ToolResult, TypedSigner } from "@sluice/sdk";
import type { ProxyConfig, Upstream } from "./config";
import { PaymentLog } from "./log";
import { BudgetPolicy } from "./policy";

export class ProxyStartError extends Error {}

/** What the proxy needs from the upstream connection. An MCP Client satisfies it. */
export interface UpstreamClient {
  listTools(params?: { cursor?: string }): Promise<unknown>;
  callTool(params: { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> }): Promise<unknown>;
}

export type ProxyOptions = {
  config: ProxyConfig;
  /** The agent's session key. */
  signer: TypedSigner;
  upstream: UpstreamClient;
  policy?: BudgetPolicy;
  log?: PaymentLog;
  /** Unix seconds. */
  now?: () => number;
  /** The wait before the same payment is sent again, while the server says it is not yet known to have settled. Default 4 seconds. */
  resendDelayMs?: number;
};

/** The longest a signed intent stays valid, whatever the server offers. */
const MAX_DEADLINE_SECONDS = 300;
/** How often the same signed payment is sent again, and the answers that ask for it. */
const PAYMENT_RESENDS = 3;
const NOT_YET: ReadonlySet<string> = new Set([ERRORS.paymentPending, "payment_in_progress"]);

export class PaymentProxy {
  readonly policy: BudgetPolicy;
  readonly log: PaymentLog;
  private readonly lock = new Mutex();
  private readonly now: () => number;

  constructor(private readonly o: ProxyOptions) {
    if (getAddress(o.signer.address) === getAddress(o.config.payer)) {
      throw new ProxyStartError("the session key is the owner's own address. The proxy signs with a session key only, never with the owner's key");
    }
    this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
    this.policy = o.policy ?? new BudgetPolicy(o.config, this.now);
    this.log = o.log ?? new PaymentLog(o.config.logFile);
  }

  /** The agent's session key address, which the owner authorises on the AgentVault. */
  get agent(): string {
    return getAddress(this.o.signer.address);
  }

  async listTools(cursor?: string): Promise<unknown> {
    return this.o.upstream.listTools(cursor ? { cursor } : undefined);
  }

  async callTool(params: { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> }): Promise<ToolResult> {
    const first = (await this.o.upstream.callTool(params)) as ToolResult;
    // The agent attached its own payment: that is its business, pass the result through.
    if (params._meta?.[PAYMENT_META_KEY] !== undefined) return first;
    const required = parsePaymentRequired(first);
    if (!required) return first;

    const tool = params.name;
    const accepted = this.choose(required.accepts);
    if (!accepted) {
      const detail = "no offer from the server is for this proxy's scheme, network, asset and router";
      this.log.append({ event: "refused", tool, reason: "unsupported_requirements", detail });
      return refusal("unsupported_requirements", detail);
    }

    // Decide, commit and sign one payment at a time, so two concurrent calls cannot both pass the total cap.
    const signed = await this.lock.run(async () => {
      const decision = this.policy.evaluate(tool, accepted);
      if (!decision.ok) return decision;
      const intent: Intent = {
        payer: this.o.config.payer,
        payee: accepted.payTo,
        amount: decision.amount,
        toolId: accepted.extra.toolId,
        nonce: newNonce(),
        deadline: BigInt(this.now() + Math.min(accepted.maxTimeoutSeconds, DEFAULT_TIMEOUT_SECONDS, MAX_DEADLINE_SECONDS)),
      };
      this.policy.commit(decision.amount); // committed before the signature exists, and written to disk
      const signature = await signIntent(this.o.signer, this.o.config.router, intent, this.o.config.chainId);
      return { ok: true as const, intent, signature };
    });
    if (!signed.ok) {
      this.log.append({ event: "refused", tool, payee: accepted.payTo, amount: tryFormat(accepted.amount), reason: signed.code, detail: signed.detail });
      return refusal(signed.code, signed.detail);
    }

    const id = intentDigest(this.o.config.router, signed.intent, this.o.config.chainId);
    const payload: PaymentPayload = {
      x402Version: X402_VERSION,
      resource: required.resource,
      accepted,
      payload: { signature: signed.signature, authorization: toWire(signed.intent) },
    };
    const amount = formatQusdc(signed.intent.amount);
    let second: ToolResult;
    const paidParams = { ...params, _meta: { ...(params._meta ?? {}), [PAYMENT_META_KEY]: payload } };
    try {
      second = (await this.o.upstream.callTool(paidParams)) as ToolResult;
      // The same signed payment, sent again: nothing new is signed or committed. A new one would risk paying twice.
      for (let again = 0; again < PAYMENT_RESENDS && notYet(second); again++) {
        await new Promise<void>((resolve) => setTimeout(resolve, this.o.resendDelayMs ?? 4_000));
        second = (await this.o.upstream.callTool(paidParams)) as ToolResult;
      }
    } catch (err) {
      this.log.append({ event: "failed", tool, payee: accepted.payTo, amount, id, reason: "upstream_error", detail: err instanceof Error ? err.message.slice(0, 120) : undefined });
      throw err;
    }

    const settlement = settlementOf(second);
    if (!second.isError) {
      this.log.append({ event: "paid", tool, payee: accepted.payTo, amount, id, status: settlement?.extensions?.sluice?.status ?? "unknown" });
    } else {
      const why = parsePaymentRequired(second)?.error ?? String((second.structuredContent as { error?: unknown } | undefined)?.error ?? "tool_error");
      this.log.append({ event: "failed", tool, payee: accepted.payTo, amount, id, reason: why });
    }
    return second;
  }

  /** The first offer this proxy can pay: its scheme, its network, its asset and its router. */
  private choose(accepts: PaymentRequirements[]): PaymentRequirements | undefined {
    for (const a of accepts) {
      try {
        if (
          a.scheme === "sluice-intent" &&
          a.network === `eip155:${this.o.config.chainId}` &&
          getAddress(a.asset) === this.o.config.asset &&
          getAddress(a.extra.router) === this.o.config.router
        ) {
          return a;
        }
      } catch {
        // a malformed offer is skipped
      }
    }
    return undefined;
  }
}

/** True when the server says it cannot yet tell whether this payment settled. */
function notYet(result: ToolResult): boolean {
  const code = (result.structuredContent as { error?: unknown } | undefined)?.error;
  return result.isError === true && typeof code === "string" && NOT_YET.has(code);
}

function refusal(code: string, detail: string): ToolResult {
  const r = errorResult("sluice_proxy_refused", `Sluice proxy did not pay: ${detail}`);
  return { ...r, structuredContent: { error: "sluice_proxy_refused", reason: code, detail } };
}

function tryFormat(amount: string): string | undefined {
  try {
    return formatQusdc(BigInt(amount));
  } catch {
    return undefined;
  }
}

/** The MCP server an agent talks to. Tool lists pass straight through; calls go through the payment logic. */
export function createProxyServer(proxy: PaymentProxy): Server {
  const server = new Server({ name: "sluice-proxy", version: "0.2.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async (request) => (await proxy.listTools(request.params?.cursor)) as never);
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args, _meta } = request.params;
    return (await proxy.callTool({ name, arguments: args, _meta: _meta as Record<string, unknown> | undefined })) as never;
  });
  return server;
}

/** Connects to the upstream server named in the config. The session key is never passed to a child process. */
export async function connectUpstream(upstream: Upstream): Promise<Client> {
  const client = new Client({ name: "sluice-proxy", version: "0.2.0" });
  if ("url" in upstream) {
    await client.connect(new StreamableHTTPClientTransport(new URL(upstream.url)));
  } else {
    await client.connect(
      new StdioClientTransport({
        command: upstream.command,
        args: upstream.args,
        env: { ...getDefaultEnvironment(), ...(upstream.env ?? {}) },
        cwd: upstream.cwd,
        stderr: "inherit",
      }),
    );
  }
  return client;
}

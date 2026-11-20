// An HTTP client for a Sluice facilitator: POST /verify, POST /settle, GET /status/:id, and the two
// zero-QIE helpers POST /onboard and POST /relay. Request and response bodies follow the x402 facilitator
// interface (specs/x402-specification-v2.md, section 7) wherever the scheme allows.
import { ERRORS, X402_VERSION } from "./protocol";
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "./protocol";

export type StatusResponse = {
  id: string;
  status: "queued" | "submitted" | "settled" | "skipped" | "expired" | "failed";
  transaction?: string;
  blockNumber?: number;
  reason?: string;
  payer?: string;
  payee?: string;
  amount?: string;
};

export type OnboardRequest = { payer: string; approveTx: string; depositTx: string };
export type OnboardResponse = {
  ok: boolean;
  error?: string;
  detail?: string;
  topUpTx?: string;
  topUpWei?: string;
  approveTx?: string;
  depositTx?: string;
};

export type RelayRequest =
  | { kind: "withdraw" | "refund"; account: string; to: string; amount: string; nonce: string; deadline: string; signature: string }
  | {
      kind: "authorize";
      payer: string;
      grant: { agent: string; budget: string; perCallCap: string; expiry: string };
      tools: Array<{ payee: string; toolId: string }>;
      deadline: string;
      signature: string;
    }
  | { kind: "revoke"; payer: string; agent: string; deadline: string; signature: string };
export type RelayResponse = { ok: boolean; error?: string; detail?: string; transaction?: string };

/** What a tool server needs from a facilitator. */
export interface FacilitatorApi {
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
}

export type ClientOptions = { url: string; fetch?: typeof fetch; timeoutMs?: number };

export class FacilitatorClient implements FacilitatorApi {
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ClientOptions) {
    this.base = options.url.replace(/\/+$/, "");
    // A wrapper, not the global itself: a browser throws "Illegal invocation" if fetch is called as a method of another object.
    this.doFetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    // An explicit timer, cleared as soon as the answer is in. AbortSignal.timeout leaves a pending timer behind and, on
    // Node 24 for Windows, crashed the process at exit after a test run.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let status: number;
    let text: string;
    try {
      const res = await this.doFetch(`${this.base}${path}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      status = res.status;
      text = await res.text();
    } catch (cause) {
      throw new FacilitatorUnavailable("the facilitator could not be reached", cause);
    } finally {
      clearTimeout(timer);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new FacilitatorUnavailable(`the facilitator sent an unreadable response (HTTP ${status})`);
    }
    if (status >= 500) throw new FacilitatorUnavailable(`the facilitator failed (HTTP ${status})`);
    return json as T;
  }

  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    return this.call("POST", "/verify", { x402Version: X402_VERSION, paymentPayload: payload, paymentRequirements: requirements });
  }

  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    return this.call("POST", "/settle", { x402Version: X402_VERSION, paymentPayload: payload, paymentRequirements: requirements });
  }

  async status(id: string): Promise<StatusResponse | undefined> {
    const res = await this.call<StatusResponse | { error: string }>("GET", `/status/${encodeURIComponent(id)}`);
    return "error" in res ? undefined : res;
  }

  onboard(request: OnboardRequest): Promise<OnboardResponse> {
    return this.call("POST", "/onboard", request);
  }

  relay(request: RelayRequest): Promise<RelayResponse> {
    return this.call("POST", "/relay", request);
  }
}

export class FacilitatorUnavailable extends Error {
  readonly code = ERRORS.facilitatorUnavailable;
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "FacilitatorUnavailable";
  }
}

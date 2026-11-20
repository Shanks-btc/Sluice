// The simulated walkthrough on the demo page. It uses no chain and no funds. Every message in it comes from docs/spec-vectors.json (the
// spec's test vectors, signed by throwaway keys that were discarded), built and checked with the SDK's own functions, so the shapes
// shown are the shapes in docs/SPEC.md and the checks shown are the checks a paid server runs.
//
// What is simulated is what a real run would add: the facilitator's answer and the batch on the chain. They are labelled as simulated.
import vectors from "../../../../docs/spec-vectors.json";
import { checkPayment, fromWire, parsePayload, parseRequirements, PAYMENT_META_KEY, PAYMENT_RESPONSE_META_KEY, PAYMENT_TYPES } from "@sluice/sdk/protocol";
import type { PaymentCheck, PaymentPayload, PaymentRequirements, SettleResponse } from "@sluice/sdk/protocol";
import { paymentRequiredResult, withSettlement } from "@sluice/sdk/x402";

type Vector = {
  name: string;
  signer: string;
  domain: Record<string, unknown>;
  message: Record<string, string>;
  digest: string;
  signature: string;
  payload: unknown;
  expect: { ok?: boolean; error?: string; signer?: string };
};

export const VECTORS = vectors as unknown as {
  verifierNow: number;
  addresses: Record<string, string>;
  paymentRequired: { x402Version: number; resource: { url: string; description?: string }; accepts: unknown[] };
  paymentVectors: { valid: Vector[]; invalid: Vector[] };
  toolIds: Array<{ toolName: string; toolId: string }>;
};

export const SIMULATION_BANNER = "Simulated — no real funds, no chain";

export type Check = { label: string; pass: boolean; detail: string };

export type SimStep = {
  id: "call" | "payment_required" | "sign" | "retry" | "verify" | "result" | "settle";
  actor: "Agent" | "Paid tool" | "Facilitator" | "Router";
  title: string;
  explain: string;
  /** The label above the message, in the style of the spec. */
  label: string;
  body: unknown;
  checks?: Check[];
};

/** The vector the walkthrough plays: an agent's session key signing for its owner. */
export const WALKTHROUGH_VECTOR_NAME = "an agent session key signs for the payer";

export function walkthroughVector(): Vector {
  const found = VECTORS.paymentVectors.valid.find((v) => v.name === WALKTHROUGH_VECTOR_NAME);
  if (!found) throw new Error("the walkthrough vector is missing from docs/spec-vectors.json");
  return found;
}

const requirementsOf = (): PaymentRequirements => {
  const parsed = parseRequirements(VECTORS.paymentRequired.accepts[0]);
  if (!parsed) throw new Error("the spec's payment-required vector is not a valid offer");
  return parsed;
};

export const FEE_BPS_ASSUMED = 100;

/** The router's fee rule from docs/SPEC.md section 5: fee = floor(amount × feeBps / 10000), taken from the builder's side. */
export function splitFee(amount: bigint, feeBps: number): { fee: bigint; toBuilder: bigint } {
  const fee = (amount * BigInt(feeBps)) / 10_000n;
  return { fee, toBuilder: amount - fee };
}

/** The checks a paid server runs, as a list a person can read. */
export function describeCheck(result: PaymentCheck): Check[] {
  if (result.ok) {
    return [
      { label: "Scheme, network, asset and router match the offer", pass: true, detail: "sluice-intent on eip155:1990, the offered router and asset" },
      { label: "The terms are the ones offered", pass: true, detail: "accepted equals the offer, field by field" },
      { label: "Payee, tool and amount", pass: true, detail: "payee is the builder, the tool id is the tool's, the amount is at least the price" },
      { label: "Deadline", pass: true, detail: "in the future and within what the offer allows" },
      { label: "Signature", pass: true, detail: `65 bytes, low s, recovers to ${result.signer}` },
    ];
  }
  return [{ label: "Refused", pass: false, detail: `${result.code}: ${result.detail}` }];
}

export function buildSimulation(): SimStep[] {
  const v = walkthroughVector();
  const requirements = requirementsOf();
  const payload = parsePayload(v.payload);
  if (!payload) throw new Error("the walkthrough vector's payload is not valid");
  const tool = VECTORS.toolIds.find((t) => t.toolId === requirements.extra.toolId);
  const toolName = tool?.toolName ?? "tool";
  const required = { x402Version: VECTORS.paymentRequired.x402Version, resource: VECTORS.paymentRequired.resource, accepts: [requirements] };
  const request = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: toolName, arguments: { text: "hello" } } };
  const retry = { ...request, id: 2, params: { ...request.params, _meta: { [PAYMENT_META_KEY]: payload } } };
  const verdict = checkPayment(payload, requirements, { chainId: 1990, router: String(requirements.extra.router), now: VECTORS.verifierNow });
  const amount = BigInt(requirements.amount);
  const { fee, toBuilder } = splitFee(amount, FEE_BPS_ASSUMED);
  const settlement: SettleResponse = {
    success: true,
    payer: v.message.payer,
    transaction: "",
    network: requirements.network,
    amount: v.message.amount,
    extensions: { sluice: { id: v.digest, status: "queued" } },
  };
  const result = withSettlement({ content: [{ type: "text", text: "hello" }] }, settlement);
  const intent = fromWire(payload.payload.authorization);
  if (!intent) throw new Error("the walkthrough intent is not valid");

  return [
    {
      id: "call",
      actor: "Agent",
      title: "The agent calls a paid tool",
      explain: "The agent's payment proxy forwards an ordinary MCP call. It carries no payment yet.",
      label: "tools/call",
      body: request,
    },
    {
      id: "payment_required",
      actor: "Paid tool",
      title: "The tool answers with its price",
      explain: "A tool call that arrives without payment gets the price, the payee and the router, as an MCP error result in the x402 format.",
      label: "tool result (isError)",
      body: paymentRequiredResult(required),
    },
    {
      id: "sign",
      actor: "Agent",
      title: "The agent signs an intent",
      explain: "The proxy checks the price against the owner's budget, then signs an EIP-712 Payment with the agent's session key. The signature is bound to the chain and the router.",
      label: "EIP-712 Payment (signed by the agent key)",
      body: { domain: v.domain, types: PAYMENT_TYPES, message: v.message, digest: v.digest, signature: v.signature },
    },
    {
      id: "retry",
      actor: "Agent",
      title: "The agent retries with the signed intent",
      explain: `The same call goes again with the payment in params._meta["${PAYMENT_META_KEY}"].`,
      label: "tools/call with payment",
      body: retry,
    },
    {
      id: "verify",
      actor: "Paid tool",
      title: "The server verifies the intent",
      explain: "The server runs the spec's checks on the payment before it runs the tool. These checks are the SDK's, run now in this page on the vector.",
      label: "checks run in this browser",
      body: verdict.ok ? { ok: true, signer: verdict.signer, intentId: verdict.digest } : { ok: false, code: verdict.code },
      checks: describeCheck(verdict),
    },
    {
      id: "result",
      actor: "Paid tool",
      title: "The tool runs and returns its result",
      explain: `The result carries the settlement under result._meta["${PAYMENT_RESPONSE_META_KEY}"]. The transaction is empty until the batch is sent. (Simulated: a real facilitator would have queued the intent.)`,
      label: "tool result",
      body: result,
    },
    {
      id: "settle",
      actor: "Router",
      title: "Payments settle in a batch",
      explain: `The facilitator submits queued intents in one batchSettle call. The payer pays exactly the amount; a ${FEE_BPS_ASSUMED / 100}% fee (assumed here) comes out of the builder's side. (Simulated: no transaction exists.)`,
      label: "batchSettle, then the Settled event",
      body: {
        batchSettle: { intents: [intent && { ...payload.payload.authorization }], signatures: [v.signature] },
        Settled: {
          payer: v.message.payer,
          payee: v.message.payee,
          toolId: v.message.toolId,
          amount: v.message.amount,
          fee: fee.toString(),
          builderCredited: toBuilder.toString(),
          nonce: v.message.nonce,
          signer: v.signer,
        },
      },
    },
  ];
}

/** The spec's refusal vectors, each run through the same check. The key is the vector's name. */
export function refusalExamples(): Array<{ name: string; expected: string; got: string; match: boolean }> {
  const requirements = requirementsOf();
  const out: Array<{ name: string; expected: string; got: string; match: boolean }> = [];
  for (const v of VECTORS.paymentVectors.invalid) {
    const payload = parsePayload(v.payload) as PaymentPayload | undefined;
    const expected = v.expect.error ?? "";
    if (!payload) {
      out.push({ name: v.name, expected, got: "malformed payload", match: false });
      continue;
    }
    const verdict = checkPayment(payload, requirements, { chainId: 1990, router: String(requirements.extra.router), now: VECTORS.verifierNow });
    const got = verdict.ok ? "accepted" : verdict.code;
    out.push({ name: v.name, expected, got, match: got === expected });
  }
  return out;
}

// ----------------------------------------------------------------------------------------------- playback

export type PlaybackState = { index: number; playing: boolean };

export type PlaybackAction = { type: "play" } | { type: "tick" } | { type: "reset" } | { type: "finish" } | { type: "pause" };

export const initialPlayback: PlaybackState = { index: -1, playing: false };

/** The state of the walkthrough: which step is showing and whether it is advancing by itself. */
export function playbackReducer(state: PlaybackState, action: PlaybackAction, steps: number): PlaybackState {
  switch (action.type) {
    case "play":
      return { index: state.index >= steps - 1 ? 0 : Math.max(state.index + 1, 0), playing: true };
    case "tick": {
      if (!state.playing) return state;
      const next = state.index + 1;
      return next >= steps ? { index: steps - 1, playing: false } : { index: next, playing: next < steps - 1 };
    }
    case "pause":
      return { ...state, playing: false };
    case "finish":
      return { index: steps - 1, playing: false };
    case "reset":
      return initialPlayback;
  }
}

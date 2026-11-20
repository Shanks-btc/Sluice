// Building payments for the tests, the way a client written from docs/SPEC.md would.
import {
  PAYMENT_TYPES,
  SCHEME,
  X402_VERSION,
  buildRequirements,
  intentDigest,
  newNonce,
  resourceFor,
  routerDomain,
  toWire,
} from "@sluice/sdk";
import type { Intent, PaymentPayload, PaymentRequirements } from "@sluice/sdk";
import type { TypedSigner } from "@sluice/sdk";
import type { Stack } from "./stack";

export const TOOL = "echo";

export function requirementsFor(
  stack: Pick<Stack, "routerAddress" | "vaultAddress" | "tokenAddress">,
  payee: string,
  price: bigint,
  toolName = TOOL,
  extra: { maxTimeoutSeconds?: number } = {},
): PaymentRequirements {
  return buildRequirements({
    toolName,
    amount: price,
    payTo: payee,
    router: stack.routerAddress,
    vault: stack.vaultAddress,
    asset: stack.tokenAddress,
    maxTimeoutSeconds: extra.maxTimeoutSeconds,
  });
}

export type Made = { payload: PaymentPayload; intent: Intent; signature: string; digest: string; requirements: PaymentRequirements };

/** An intent for `requirements`, signed by `signer`, wrapped as an x402 PaymentPayload. `over` changes the intent. */
export async function makePayment(
  stack: Pick<Stack, "routerAddress" | "clock">,
  signer: TypedSigner,
  payer: string,
  requirements: PaymentRequirements,
  over: Partial<Intent> = {},
  chainId = 1990,
  verifyingContract?: string,
): Promise<Made> {
  const intent: Intent = {
    payer,
    payee: requirements.payTo,
    amount: BigInt(requirements.amount),
    toolId: requirements.extra.toolId,
    nonce: newNonce(),
    deadline: BigInt(stack.clock() + 300),
    ...over,
  };
  const domain = routerDomain(verifyingContract ?? stack.routerAddress, chainId);
  const signature = await signer.signTypedData(domain, PAYMENT_TYPES, intent);
  const payload: PaymentPayload = {
    x402Version: X402_VERSION,
    resource: resourceFor(TOOL),
    accepted: requirements,
    payload: { signature, authorization: toWire(intent) },
  };
  return { payload, intent, signature, digest: intentDigest(stack.routerAddress, intent), requirements };
}

export const verifyBody = (m: Pick<Made, "payload" | "requirements">) => ({
  x402Version: X402_VERSION,
  paymentPayload: m.payload,
  paymentRequirements: m.requirements,
});

export { SCHEME };

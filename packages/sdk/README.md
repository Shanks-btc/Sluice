# @sluice/sdk

Payment middleware for MCP servers. A tool declares a price in QUSDC and a payee. A call without payment gets back the
price; a call with a signed payment runs the tool and queues the payment. It speaks x402 over MCP with the scheme name
`sluice-intent`, written up in [`docs/SPEC.md`](../../docs/SPEC.md). It is an independent scheme, not an official x402 one.

## Use it on a server

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createPaywall, serveMcpHttp } from "@sluice/sdk";
import { z } from "zod";

const paywall = createPaywall({
  facilitator: "https://your-facilitator.example", // a Sluice facilitator: /verify and /settle
  router: "0x...", // the PaymentRouter payments go through
});

const build = async () => {
  const server = new McpServer({ name: "my-tools", version: "1.0.0" });
  await paywall.registerPaidTool(
    server,
    { name: "summarise", price: "0.01", payee: "0xYourAddress", inputSchema: { url: z.string().url() } },
    async ({ url }, _extra, payment) => ({ content: [{ type: "text", text: `paid by ${payment.payer}: ...` }] }),
  );
  return server;
};

await serveMcpHttp(build, 3402); // stateless Streamable HTTP at /mcp
```

`price` is a decimal in QUSDC with at most six places, or a bigint of base units. `payee` is an address. A `.qie` name
needs a `resolver` you pass to `createPaywall`: nothing ships by default, because no documented on-chain read for QIE ID names
was found, and a name that cannot be resolved stops the server at start-up instead of paying a guess.

## What the middleware does on each call

1. No payment: answers `isError` with the requirements in `structuredContent` and in `content[0].text`.
2. A payment: checks the scheme, network, router, asset, payee, tool, amount (at least the price), deadline and signature
   itself, then asks the facilitator's `/verify` for the payer's balance, the nonce and an agent's session.
3. Runs the tool. A tool that throws or returns an error result is not charged.
4. Queues the payment with `/settle` and returns the result with `_meta["x402/payment-response"]`.

The same intent never charges twice or runs a tool twice: a repeat of the same call returns the original result, and the same
intent on a different call is refused. Pass a `store` to `createPaywall` to keep that record across restarts. The default
lives in memory.

A queued payment that cannot be sent in time expires, after the tool has answered. With `answerOnlyWhenSettled: true`, and a
facilitator that offers `/hold` and `/capture` ([the spec, section 7.4](../../docs/SPEC.md#74-answering-only-for-a-settled-payment-optional)),
the middleware has the payment held before the tool runs, and returns the result only once the payment has settled on chain. A
call that fails is not charged. While it cannot tell, it answers `sluice_payment_pending`: the client sends the same payment
again. The tool server on Vercel is set up this way.

## What else is in it

| Export | What it is |
| --- | --- |
| `checkPayment` | The scheme's stateless checks, for a server or a facilitator that does not use `createPaywall`. |
| `signIntent`, `intentDigest`, `toWire` | Build and sign an intent. |
| `FacilitatorClient` | `/verify`, `/settle`, `/status`, `/onboard` and `/relay`. |
| `signOnboarding` | Signs the two transactions of a start with no QIE. |
| `signAuthorize`, `signRevoke` | Sign an agent session, so a relayer can submit it. |
| `parsePaymentRequired`, `settlementOf` | Read the wire messages on the client side. |
| `ROUTER_ABI`, `VAULT_ABI` | The slice of the contracts' interfaces the packages call. A test compares them with the compiled contracts. |

## Build and test

`pnpm build` compiles it to `dist/`. Its tests are in `test/unit/sdk` and `test/unit/spec`.

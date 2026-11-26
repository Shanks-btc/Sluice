# Try Sluice as a tool builder

This takes about ten minutes. You put a price on one MCP tool, run it, see it ask for payment, and see how a payer reaches it. The code below was run against a local chain in a test (`test/unit/e2e/try-it.test.ts`, which writes the code from this page to a scratch folder and runs it). A person outside the project has not followed it yet. If a step does not work for you, that is what the [issue form](../.github/ISSUE_TEMPLATE/i-tried-sluice.yml) is for.

**Start on the testnet.** The maintainer gives you three things for it: a router address, a facilitator's address and a token's address. Nothing on the testnet has value. Do not put a mainnet router in this until the maintainer says one is deployed.

The SDK is part of this repository and is not published to a package registry, so you work inside a copy of the repository.

## What you need

- Node 20 or later, and pnpm 11.
- A copy of this repository.
- Your own address, to be paid at. It can be a new wallet with nothing in it.
- The router, the facilitator's address and the token's address for the network you are using.

## Steps

1. Install and build. About three minutes.

   ```powershell
   pnpm install
   ```

   ```powershell
   pnpm build
   ```

2. Make a folder for your tool, and a file in it.

   ```powershell
   New-Item -ItemType Directory examples\my-tool
   ```

   Put this in `examples\my-tool\index.ts`. It is a whole server: one tool, `summarise`, at 0.01 QUSDC.

   ```ts
   // examples/my-tool/index.ts
   import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
   import { createPaywall, serveMcpHttp } from "@sluice/sdk";
   import { z } from "zod";

   // A paywall that verifies and settles through a Sluice facilitator, for one router, on one network.
   const paywall = createPaywall({
     facilitator: process.env.SLUICE_FACILITATOR_URL ?? "",
     router: process.env.SLUICE_ROUTER ?? "",
     chainId: process.env.SLUICE_NETWORK === "testnet" ? 1983 : 1990,
     // On the testnet the token is the maintainer's; on mainnet leave SLUICE_TOKEN empty and the default is QUSDC.
     ...(process.env.SLUICE_TOKEN ? { asset: process.env.SLUICE_TOKEN } : {}),
   });

   const build = async () => {
     const server = new McpServer({ name: "my-tools", version: "1.0.0" });
     // A price in QUSDC and an address to be paid at. A call with no payment is answered with the price.
     await paywall.registerPaidTool(
       server,
       {
         name: "summarise",
         price: "0.01",
         payee: process.env.SLUICE_PAYEE ?? "",
         description: "Summarises a web page.",
         inputSchema: { url: z.string().url() },
       },
       // This runs only for a call that carries a valid payment. A call that throws here is not charged.
       async ({ url }: { url: string }, _extra, payment) => ({
         content: [{ type: "text", text: `Summary of ${url}, paid for by ${payment.payer}.` }],
       }),
     );
     return server;
   };

   // Serves the tools over Streamable HTTP at /mcp.
   serveMcpHttp(build, Number(process.env.SLUICE_TOOLS_PORT ?? 3402))
     .then(({ port }) => console.log(`listening on http://127.0.0.1:${port}/mcp`))
     .catch(() => {
       console.error("the paid server failed to start");
       process.exit(1);
     });
   ```

3. Set the environment for this window.

   ```powershell
   $env:SLUICE_NETWORK = "testnet"; $env:SLUICE_FACILITATOR_URL = "https://the-facilitator.example"; $env:SLUICE_ROUTER = "0xTheRouter"; $env:SLUICE_TOKEN = "0xTheTestToken"; $env:SLUICE_PAYEE = "0xYourAddress"
   ```

4. Run it.

   ```powershell
   pnpm exec ts-node -r tsconfig-paths/register examples\my-tool\index.ts
   ```

   Expect `listening on http://127.0.0.1:3402/mcp`. Leave it running and open a second PowerShell window in the same folder.

5. Ask for the tool with no payment. It should answer with the price.

   ```powershell
   Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3402/mcp -Headers @{ Accept = "application/json, text/event-stream" } -ContentType "application/json" -Body '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"summarise","arguments":{"url":"https://example.com"}}}'
   ```

   Expect `isError` true, and in `structuredContent` an `accepts` list with `"amount": "10000"` (0.01 QUSDC in six-decimal units) and `payTo` your address. This is what an agent's proxy reads before it decides whether to pay.

6. See it paid. You need a payer: a wallet with some of the token, and an agent key it has authorised. [TRY-IT-AGENT.md](TRY-IT-AGENT.md) takes about ten minutes and ends with a call to a server you name. Point its proxy config at `http://127.0.0.1:3402/mcp`, and give `summarise` as the tool, with your address as the payee.

   The tool's reply carries the payment response. The payment is queued at the facilitator, which sends it to the router in a batch.

7. Look at what you earned. The router holds your earnings, minus its fee, as a balance for your address. The web app's builder page (`apps/web`, the `/builder` route) shows it and lets you withdraw it. You sign the withdrawal and the facilitator can submit it, so you need no QIE.

## What a price is

- `price` is a decimal in QUSDC with at most six places, or a bigint of base units. `payee` is an address.
- The price you set is the minimum. A payment for less is refused, and one for more is accepted.
- A call that fails is not charged. A call with the same payment twice runs the tool once.
- The router takes a fee from your side, at most 2%, which the router's owner sets. The payer pays exactly the price.

## When you are ready to put it on the internet

[DEPLOY-TOOL-SERVER.md](DEPLOY-TOOL-SERVER.md) describes hosting the example tool server, with its limits on callers, a Docker image and a checklist. Your own server needs the same care: a rate limit on calls that carry no payment, a size limit on requests, time limits on what it reads, and logs with no signatures in them.

## What this does not tell you

- That a real agent will find your tool. There is no directory.
- That the price is right. Nothing here measures what a call is worth.
- That it works for you on QIE mainnet. [EVIDENCE.md](EVIDENCE.md) has verified mainnet rows for settled payments, all of them founder-run. They show signed payments settling between the project's own wallets, not that someone outside the project followed this page, and not that a tool ran.

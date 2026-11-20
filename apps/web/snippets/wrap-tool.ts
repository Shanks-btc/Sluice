import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createPaywall, serveMcpHttp } from "@sluice/sdk";
import { z } from "zod";

// A paywall that verifies and settles through a Sluice facilitator, for one router.
const paywall = createPaywall({
  facilitator: process.env.SLUICE_FACILITATOR_URL ?? "",
  router: process.env.SLUICE_ROUTER ?? "",
});

const build = async () => {
  const server = new McpServer({ name: "my-tools", version: "1.0.0" });

  // Put a price in QUSDC and a payee on a tool. A call with no payment gets the price back.
  await paywall.registerPaidTool(
    server,
    {
      name: "summarise",
      price: "0.01",
      payee: process.env.SLUICE_PAYEE ?? "",
      description: "Summarises a web page.",
      inputSchema: { url: z.string().url() },
    },
    async ({ url }: { url: string }, _extra, payment) => ({
      content: [{ type: "text", text: `Summary of ${url}, paid for by ${payment.payer}.` }],
    }),
  );
  return server;
};

// Serves the tools over Streamable HTTP at /mcp.
serveMcpHttp(build, 3402).catch((err: unknown) => {
  console.error("the paid server failed to start", err instanceof Error ? err.message : "");
  process.exit(1);
});

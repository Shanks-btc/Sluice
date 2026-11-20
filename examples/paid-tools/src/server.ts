// The paid MCP server: three tools for QIE developers, each with a price in QUSDC, each answering from read-only chain data.
//
//   token_risk_check   0.010000 QUSDC   what a token's admin can do to its holders (proxy, roles, burn, mint)
//   dex_quote          0.002000 QUSDC   a QIEDEX quote for a given size, with price impact and a slippage floor
//   contract_lookup    0.005000 QUSDC   verification status, compiler, proxy and bytecode match for a contract
//
// The prices are the builder's to set. A call that fails (a bad address, an RPC error) is not charged.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Paywall } from "@sluice/sdk";
import { contractLookup } from "./contractLookup";
import { DexQuoteError, QIEDEX, dexQuote } from "./dexQuote";
import type { DexConfig } from "./dexQuote";
import type { ExplorerGet, Rpc } from "./rpc";
import { tokenRiskCheck } from "./tokenRisk";

export const DEFAULT_PRICES = { token_risk_check: "0.01", dex_quote: "0.002", contract_lookup: "0.005" } as const;
export type ToolName = keyof typeof DEFAULT_PRICES;

export type PaidToolsConfig = {
  paywall: Paywall;
  /** Who is paid: an address, or a .qie name if the paywall has a resolver. */
  payee: string;
  rpc: Rpc;
  explorer?: ExplorerGet;
  prices?: Partial<Record<ToolName, string>>;
  dex?: DexConfig;
};

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x address");

const json = (data: unknown) => ({
  structuredContent: data as Record<string, unknown>,
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});
const failure = (message: string) => ({ isError: true, content: [{ type: "text" as const, text: message }] });

/** The message of an error this package wrote, or a fixed line for anything else: an RPC error can hold a URL. */
const safeMessage = (err: unknown): string => (err instanceof DexQuoteError ? err.message : "the chain could not be read for this request");

export async function registerPaidTools(server: McpServer, cfg: PaidToolsConfig): Promise<void> {
  const price = (name: ToolName) => cfg.prices?.[name] ?? DEFAULT_PRICES[name];

  await cfg.paywall.registerPaidTool(
    server,
    {
      name: "token_risk_check",
      title: "Token risk check",
      price: price("token_risk_check"),
      payee: cfg.payee,
      description:
        "Reads an ERC-20 on QIE and reports what its admin can do to holders: whether it is an upgradeable proxy, who owns it, which roles exist and who holds them, which burn, mint, pause and blacklist functions its code has, and who can call burn and mint right now (tested by simulation). Read-only; not a security review.",
      inputSchema: { address },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args: { address: string }) => {
      try {
        return json(await tokenRiskCheck({ rpc: cfg.rpc, explorer: cfg.explorer }, args.address));
      } catch (err) {
        return failure(safeMessage(err));
      }
    },
  );

  await cfg.paywall.registerPaidTool(
    server,
    {
      name: "dex_quote",
      title: "QIEDEX quote with slippage",
      price: price("dex_quote"),
      payee: cfg.payee,
      description:
        "Quotes a swap on QIEDEX for a given size: output, minimum output at your slippage tolerance, price impact, the route, and whether the router agrees with the pool maths. Use QIE for the native coin. Read-only; sends nothing.",
      inputSchema: {
        tokenIn: z.string().describe("A token address, or QIE."),
        tokenOut: z.string().describe("A token address, or QIE."),
        amountIn: z.string().describe("The amount of tokenIn as a decimal, like 25.5."),
        slippageBps: z.number().int().min(0).max(5000).optional().describe("Slippage tolerance in basis points. Default 50."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args: { tokenIn: string; tokenOut: string; amountIn: string; slippageBps?: number }) => {
      try {
        return json(await dexQuote(cfg.rpc, args, cfg.dex ?? QIEDEX));
      } catch (err) {
        return failure(safeMessage(err));
      }
    },
  );

  await cfg.paywall.registerPaidTool(
    server,
    {
      name: "contract_lookup",
      title: "Verified-contract lookup",
      price: price("contract_lookup"),
      payee: cfg.payee,
      description:
        "Looks up a contract on QIE: whether the explorer has verified source, the contract's name, compiler and settings, whether it is a proxy, the creator, whether the explorer's bytecode matches the node's, and which write functions look like admin controls. Read-only.",
      inputSchema: { address },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args: { address: string }) => {
      try {
        return json(await contractLookup({ rpc: cfg.rpc, explorer: cfg.explorer }, args.address));
      } catch (err) {
        return failure(safeMessage(err));
      }
    },
  );
}

/** A factory for the MCP server, so stdio can build one and stateless HTTP can build one per request. */
export function paidToolsFactory(cfg: PaidToolsConfig): () => Promise<McpServer> {
  return async () => {
    const server = new McpServer({ name: "sluice-paid-tools", version: "0.2.0" });
    await registerPaidTools(server, cfg);
    return server;
  };
}

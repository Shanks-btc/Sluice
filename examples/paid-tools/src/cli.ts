#!/usr/bin/env node
// The example paid tools as an MCP server: over stdio by default, or over Streamable HTTP with --http [port].
//
// Over HTTP it is the hosted tool server (see host.ts and docs/DEPLOY-TOOL-SERVER.md): the network must be named in SLUICE_NETWORK,
// there are limits on callers, and it stops in order on SIGTERM. Over stdio it is a program an MCP client starts.
//
// Environment: SLUICE_ROUTER (the router payments go through), SLUICE_FACILITATOR_URL (the facilitator that verifies and
// settles), SLUICE_PAYEE (the address that is paid), SLUICE_RPC_URL (optional; defaults to QIE's public RPC for the network) and
// SLUICE_EXPLORER_URL (optional; defaults to QIE's public explorer). The payment asset is whatever token the router holds. Over
// HTTP also SLUICE_NETWORK (required), SLUICE_TOOLS_PRICES and the SLUICE_TOOLS_ settings in .env.example.
// stdout belongs to the MCP protocol in stdio mode, so everything this process says goes to stderr.
import { Contract, JsonRpcProvider, Network } from "ethers";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPaywall } from "@sluice/sdk";
import { ToolServerEnvError, createToolServer, readToolServerEnv, toolServerLogger } from "./host";
import { PUBLIC_EXPLORER, PUBLIC_RPC, explorerClient, rpcFromProvider } from "./rpc";
import { paidToolsFactory } from "./server";

class StartError extends Error {}

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new StartError(`set ${name}`);
  return v;
}

async function serveHttp(): Promise<void> {
  const env = readToolServerEnv(process.env);
  const i = process.argv.indexOf("--http");
  const given = process.argv[i + 1];
  if (given !== undefined && /^\d+$/.test(given)) {
    const port = Number(given);
    if (port > 65535) throw new StartError("--http needs a port from 0 to 65535");
    env.port = port;
  }
  const logger = toolServerLogger(env);
  const tools = await createToolServer({ env, logger });
  const port = await tools.listen();
  logger.info("started", { network: env.network, chainId: env.chainId, router: env.router, payee: env.payee, host: env.host, port, tools: Object.keys(env.prices) });
  let stopping = false;
  const stop = (reason: string) => {
    if (stopping) return;
    stopping = true;
    logger.info("shutting down", { reason });
    void tools.close().then(() => process.exit(0));
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGBREAK"] as const) process.on(signal, () => stop(signal));
}

async function serveStdio(): Promise<void> {
  const router = need("SLUICE_ROUTER");
  const facilitator = need("SLUICE_FACILITATOR_URL");
  const payee = need("SLUICE_PAYEE");
  const chainId = process.env.SLUICE_NETWORK?.trim() === "testnet" ? 1983 : 1990;
  const rpcUrl = process.env.SLUICE_RPC_URL?.trim() || PUBLIC_RPC;
  if (!rpcUrl.startsWith("https://") && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(rpcUrl)) throw new StartError("SLUICE_RPC_URL must be https");

  const network = Network.from(chainId);
  const provider = new JsonRpcProvider(rpcUrl, network, { staticNetwork: network });
  const asset = (await new Contract(router, ["function token() view returns (address)"], provider).getFunction("token")()) as string;
  const paywall = createPaywall({ facilitator, router, asset, chainId });
  const build = paidToolsFactory({ paywall, payee, rpc: rpcFromProvider(provider), explorer: explorerClient(process.env.SLUICE_EXPLORER_URL?.trim() || PUBLIC_EXPLORER) });
  await (await build()).connect(new StdioServerTransport());
  console.error("sluice paid tools ready on stdio");
}

(process.argv.includes("--http") ? serveHttp() : serveStdio()).catch((err: unknown) => {
  const message =
    err instanceof ToolServerEnvError
      ? err.message
      : err instanceof StartError
        ? `refusing to start: ${err.message}`
        : "the paid tools server failed to start";
  process.stderr.write(`${message}\n`, () => process.exit(1));
});

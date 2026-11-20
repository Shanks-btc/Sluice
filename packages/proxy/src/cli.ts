#!/usr/bin/env node
// sluice-proxy: a stdio MCP server that puts payment in front of a paid upstream MCP server.
//
//   node packages/proxy/dist/cli.js --config /path/to/sluice.config.json
//   node packages/proxy/dist/cli.js --config /path/to/sluice.config.json --check     (validate and print, then exit)
//
// The session key comes from the environment variable the config names (default SLUICE_AGENT_KEY). It is never printed.
// Everything this process says goes to stderr: stdout belongs to the MCP protocol.
import { Wallet } from "ethers";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { formatQusdc } from "@sluice/sdk";
import { ConfigError, loadConfig } from "./config";
import { PaymentProxy, ProxyStartError, connectUpstream, createProxyServer } from "./proxy";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const path = flag("--config") ?? process.env.SLUICE_CONFIG;
  if (!path) throw new ConfigError("give the config file with --config <path> (or set SLUICE_CONFIG)");
  const config = loadConfig(path);
  const key = process.env[config.sessionKeyEnv]?.trim();
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new ConfigError(`set ${config.sessionKeyEnv} to the agent's session key (a 0x-prefixed 32-byte hex key)`);
  }
  const signer = new Wallet(key);
  // Refused before anything else is started: no upstream process exists yet that could keep this one alive.
  if (signer.address === config.payer) {
    throw new ProxyStartError("the session key is the owner's own address. The proxy signs with a session key only, never with the owner's key");
  }

  if (process.argv.includes("--check")) {
    // Prints the budget and the agent address. Never the key.
    console.error(`config ok. agent (session key) address: ${signer.address}`);
    console.error(`pays from: ${config.payer} through router ${config.router} on chain ${config.chainId}`);
    console.error(`per call at most ${formatQusdc(config.budget.perCallCap)} QUSDC, in total at most ${formatQusdc(config.budget.totalCap)} QUSDC, until ${new Date(config.budget.expiresAt * 1000).toISOString()}`);
    for (const t of config.budget.allowedTools) console.error(`may pay: ${t.tool} -> ${t.payee}`);
    return;
  }

  const upstream = await connectUpstream(config.upstream);
  const proxy = new PaymentProxy({ config, signer, upstream });
  const server = createProxyServer(proxy);
  await server.connect(new StdioServerTransport());
  console.error(`sluice-proxy ready. agent ${proxy.agent}, paying from ${config.payer}`);
}

main().catch((err: unknown) => {
  // Only messages this package wrote are printed. An unexpected error prints a fixed line, never its text.
  // Exit explicitly: a half-started upstream process must not keep a failed start alive.
  const message = err instanceof ConfigError || err instanceof ProxyStartError ? err.message : "the proxy failed to start";
  process.stderr.write(`${message}
`, () => process.exit(1));
});

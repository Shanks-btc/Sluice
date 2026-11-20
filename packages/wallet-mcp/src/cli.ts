#!/usr/bin/env node
// sluice-wallet: a stdio MCP server for an AI agent. It reads the same config file as the proxy.
//
//   node packages/wallet-mcp/dist/cli.js --config /path/to/sluice.config.json
//
// The session key comes from the environment variable the config names (default SLUICE_AGENT_KEY); it is used only to
// learn the agent's address. The RPC is rpcUrl in the config, or SLUICE_RPC_URL, or QIE's public RPC. Everything this
// process says goes to stderr: stdout belongs to the MCP protocol.
import { JsonRpcProvider, Network, Wallet } from "ethers";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, connectUpstream, loadConfig } from "@sluice/proxy";
import { ChainReader } from "./chain";
import { WalletStartError, assertSessionKey, createWalletServer } from "./server";

const PUBLIC_RPC = "https://rpc1mainnet.qie.digital/";

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
  const agent = new Wallet(key).address; // the key is not kept: only the address it controls
  const rpcUrl = config.rpcUrl ?? process.env.SLUICE_RPC_URL?.trim() ?? PUBLIC_RPC;
  if (!rpcUrl.startsWith("https://") && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(rpcUrl)) {
    throw new ConfigError("the RPC URL must be https (plain http only for the local machine)");
  }
  const network = Network.from(config.chainId);
  const provider = new JsonRpcProvider(rpcUrl, network, { staticNetwork: network });
  provider.pollingInterval = 1_000;
  const chain = await ChainReader.connect(provider, config.router);
  await assertSessionKey(chain, config, agent);

  const server = createWalletServer({ config, chain, agent, upstream: () => connectUpstream(config.upstream) });
  await server.connect(new StdioServerTransport());
  console.error(`sluice-wallet ready. agent ${agent}, owner ${config.payer}`);
}

main().catch((err: unknown) => {
  const message = err instanceof ConfigError || err instanceof WalletStartError ? err.message : "the wallet MCP failed to start";
  process.stderr.write(`${message}
`, () => process.exit(1));
});

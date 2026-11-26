#!/usr/bin/env node
// sluice-wallet: a stdio MCP server for an AI agent. It reads the same config file as the proxy.
//
//   node packages/wallet-mcp/dist/cli.js --config /path/to/sluice.config.json
//
// The session key comes from the environment variable the config names (default SLUICE_AGENT_KEY); it is used only to
// learn the agent's address. The RPC is rpcUrl in the config, or SLUICE_RPC_URL, or QIE's public RPC. Everything this
// process says goes to stderr: stdout belongs to the MCP protocol.
import { Network, Wallet } from "ethers";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, connectUpstream, loadConfig } from "@sluice/proxy";
import { FailoverJsonRpcProvider, NoHealthyEndpoint, QIE_CHAIN_ID, describeSelection, orderedUrls, requireNodeChain, resolveEndpoint } from "@sluice/sdk";
import { ChainReader } from "./chain";
import { WalletStartError, assertSessionKey, createWalletServer } from "./server";

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
  // A named RPC (the config's rpcUrl, or SLUICE_RPC_URL) is used as given. Otherwise QIE's five public endpoints for the config's chain are
  // probed, the first that answers with the right chain id is used, and the others are fallbacks for reads.
  const named = config.rpcUrl ?? process.env.SLUICE_RPC_URL?.trim();
  let urls: string[];
  if (named) {
    if (!named.startsWith("https://") && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(named)) {
      throw new ConfigError("the RPC URL must be https (plain http only for the local machine)");
    }
    urls = [named];
  } else {
    const known = (Object.keys(QIE_CHAIN_ID) as Array<keyof typeof QIE_CHAIN_ID>).find((n) => QIE_CHAIN_ID[n] === config.chainId);
    if (!known) throw new ConfigError(`chain ${config.chainId} has no public QIE endpoints: set rpcUrl in the config or SLUICE_RPC_URL`);
    try {
      const sel = await resolveEndpoint(known, undefined);
      console.error(describeSelection(sel));
      urls = orderedUrls(sel);
    } catch (err) {
      throw new WalletStartError(err instanceof NoHealthyEndpoint ? err.message : "no QIE RPC endpoint could be probed");
    }
  }
  const network = Network.from(config.chainId);
  const provider = new FailoverJsonRpcProvider(urls, network, { staticNetwork: network }, 20_000);
  provider.pollingInterval = 1_000;
  await requireNodeChain(provider, config.chainId, `chain ${config.chainId}`).catch((err: unknown) => {
    provider.destroy();
    throw new WalletStartError(err instanceof Error ? err.message : "the RPC's chain could not be checked");
  });
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

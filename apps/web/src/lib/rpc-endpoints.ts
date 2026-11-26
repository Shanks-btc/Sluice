// Which nodes the pages read through. QIE publishes five public endpoints for each network and at times some do not answer, so a page that
// was pointed at one stops when that one is down. With the network's default endpoint set, the pages read through it and fall back to the
// other four for reads. An endpoint the deployer named (a local node, or another provider) is used alone, as given.
//
// Only reads fall back. A transaction goes to the wallet, which sends it through its own node.
import { QIE_ENDPOINTS } from "@sluice/sdk/rpc";
import type { AppConfig } from "./config";
import { isLocalUrl } from "./networks";

export function readEndpoints(config: Pick<AppConfig, "chainId" | "rpcUrl">): string[] {
  const network = config.chainId === 1990 ? "mainnet" : config.chainId === 1983 ? "testnet" : undefined;
  if (!network || isLocalUrl(config.rpcUrl)) return [config.rpcUrl];
  const own = QIE_ENDPOINTS[network];
  if (!own.includes(config.rpcUrl)) return [config.rpcUrl];
  return [config.rpcUrl, ...own.filter((u) => u !== config.rpcUrl)];
}

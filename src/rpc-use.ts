// How the scripts reach a QIE node: probe the network's public endpoints, take the first that answers with the right chain id, say which one,
// and keep the rest as fallbacks for read calls. SLUICE_RPC_URL names one endpoint and overrides all of this.
import { Network } from "ethers";
import { FailoverJsonRpcProvider, QIE_CHAIN_ID, describeSelection, orderedUrls, resolveEndpoint } from "@sluice/sdk";
import type { QieNetwork, Selected } from "@sluice/sdk";

export type RpcChoice = Selected & { network: QieNetwork; chainId: number };

/** Picks the endpoint for a network, and tells `log` which one. Throws NoHealthyEndpoint (with what each endpoint did) if none answers. */
export async function chooseRpc(network: QieNetwork, named: string | undefined, log: (line: string) => void, options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<RpcChoice> {
  const sel = await resolveEndpoint(network, named, options);
  log(describeSelection(sel));
  return { ...sel, network, chainId: QIE_CHAIN_ID[network] };
}

/** A provider on the chosen endpoint that falls back to the others for reads. `timeoutMs` bounds every request. */
export function providerFor(choice: Pick<Selected, "url" | "fallbacks">, chainId: number, timeoutMs = 20_000): FailoverJsonRpcProvider {
  const net = Network.from(chainId);
  // cacheTimeout -1: ethers keeps an answer for 250 ms by default, and a transaction count read just after a block was mined must be fresh.
  return new FailoverJsonRpcProvider(orderedUrls({ ...choice, probes: [], overridden: false }), net, { staticNetwork: net, cacheTimeout: -1 }, timeoutMs);
}

"use client";
// Builds what a flow needs (the wallet, the account, the chain, a facilitator) from the connected wallet and the settings. Returns null
// until the wallet is connected on the right network, so no flow can be planned from the wrong chain.
import { useMemo } from "react";
import { FacilitatorClient } from "@sluice/sdk/facilitator-client";
import type { FlowDeps } from "../lib/flows";
import type { ChainReader } from "../lib/reads";
import { useConfig, useWallet } from "./providers";

export function useFlowDeps(reader: ChainReader | null, facilitatorUrl?: string | null): FlowDeps | null {
  const config = useConfig();
  const wallet = useWallet();
  const url = facilitatorUrl === undefined ? config.facilitatorUrl : facilitatorUrl;
  return useMemo(() => {
    if (!reader || !wallet.provider || !wallet.account || wallet.status !== "connected" || wallet.network !== "ok") return null;
    return {
      wallet: wallet.provider,
      account: wallet.account,
      chainId: config.chainId,
      network: config.network,
      reader,
      facilitator: url ? new FacilitatorClient({ url }) : undefined,
      facilitatorUrl: url,
      now: () => Math.floor(Date.now() / 1000),
    } satisfies FlowDeps;
  }, [reader, wallet.provider, wallet.account, wallet.status, wallet.network, config.chainId, config.network, url]);
}

"use client";
// The app's settings and the connected wallet, shared by the pages that need them.
//
// The wallet is an injected EIP-1193 provider (QIE Wallet, MetaMask). Nothing connects by itself: the person presses Connect and
// approves it in the wallet. The app holds an account address and a chain id, and never a key.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Network } from "ethers";
import { FailoverJsonRpcProvider } from "@sluice/sdk/timeout";
import type { AppConfig } from "../lib/config";
import { classifyWalletError, connectWallet, describeWalletError, findInjectedWallet, hexToNumber, networkState, readChainId, switchChain } from "../lib/eip1193";
import type { Eip1193Provider, NetworkState } from "../lib/eip1193";
import { readEndpoints } from "../lib/rpc-endpoints";
import { openReader } from "../lib/reads";
import type { ChainReader } from "../lib/reads";

// ------------------------------------------------------------------------------------------------ settings

const ConfigContext = createContext<AppConfig | null>(null);

export function ConfigProvider({ config, children }: { config: AppConfig; children: ReactNode }) {
  return <ConfigContext.Provider value={config}>{children}</ConfigContext.Provider>;
}

export function useConfig(): AppConfig {
  const config = useContext(ConfigContext);
  if (!config) throw new Error("useConfig needs a ConfigProvider");
  return config;
}

// --------------------------------------------------------------------------------------------------- wallet

export type WalletStatus = "unavailable" | "idle" | "connecting" | "connected";

/** How long the page waits for a wallet that is put on the page late: six looks, half a second apart. */
const WALLET_LOOK_MS = 500;
const WALLET_LOOK_TRIES = 6;

export type WalletApi = {
  status: WalletStatus;
  provider: Eip1193Provider | null;
  account: string | null;
  chainId: number | null;
  network: NetworkState;
  error: string | null;
  connect(): Promise<void>;
  switchNetwork(): Promise<void>;
};

const WalletContext = createContext<WalletApi | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const config = useConfig();
  const [provider, setProvider] = useState<Eip1193Provider | null>(null);
  const [status, setStatus] = useState<WalletStatus>("idle");
  const [account, setAccount] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const win = window as unknown as { ethereum?: unknown };
    let detach: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    const attach = (found: Eip1193Provider) => {
      setProvider(found);
      setStatus((s) => (s === "unavailable" ? "idle" : s));
      const onAccounts = (accounts: unknown) => {
        const first = Array.isArray(accounts) ? accounts[0] : undefined;
        if (typeof first === "string") setAccount(first);
        else {
          setAccount(null);
          setStatus("idle");
        }
      };
      const onChain = (value: unknown) => {
        try {
          setChainId(hexToNumber(value));
        } catch {
          setChainId(null);
        }
      };
      found.on?.("accountsChanged", onAccounts as never);
      found.on?.("chainChanged", onChain as never);
      detach = () => {
        found.removeListener?.("accountsChanged", onAccounts as never);
        found.removeListener?.("chainChanged", onChain as never);
      };
    };
    const look = (): boolean => {
      const found = findInjectedWallet(win);
      if (!found) return false;
      attach(found);
      return true;
    };
    const onInitialized = () => {
      if (!detach) look();
    };
    if (!look()) {
      // A wallet app's own browser on a phone can put the wallet on the page after the page has loaded, and announces it with an event.
      // The page listens for that, and looks again for a few seconds, before it says no wallet was found.
      window.addEventListener("ethereum#initialized", onInitialized);
      const poll = () => {
        if (detach) return;
        tries += 1;
        if (look()) return;
        if (tries < WALLET_LOOK_TRIES) timer = setTimeout(poll, WALLET_LOOK_MS);
        else setStatus("unavailable");
      };
      timer = setTimeout(poll, WALLET_LOOK_MS);
    }
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("ethereum#initialized", onInitialized);
      detach?.();
    };
  }, []);

  const connect = useCallback(async () => {
    if (!provider) {
      setError("No wallet is ready yet. If this page is open in a wallet app's browser, give it a moment and press Connect again.");
      return;
    }
    setError(null);
    setStatus("connecting");
    try {
      const { account: a, chainId: c } = await connectWallet(provider);
      setAccount(a);
      setChainId(c);
      setStatus("connected");
    } catch (err) {
      setStatus("idle");
      setError(describeWalletError(err));
    }
  }, [provider]);

  const switchNetwork = useCallback(async () => {
    if (!provider) return;
    setError(null);
    try {
      await switchChain(provider, config.network);
      setChainId(await readChainId(provider));
    } catch (err) {
      setError(describeWalletError(err));
      if (classifyWalletError(err) !== "rejected") setChainId(await readChainId(provider).catch(() => null));
    }
  }, [provider, config.network]);

  const value = useMemo<WalletApi>(
    () => ({ status, provider, account, chainId, network: networkState(chainId, config.chainId), error, connect, switchNetwork }),
    [status, provider, account, chainId, config.chainId, error, connect, switchNetwork],
  );
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletApi {
  const wallet = useContext(WalletContext);
  if (!wallet) throw new Error("useWallet needs a WalletProvider");
  return wallet;
}

// ---------------------------------------------------------------------------------------------- the chain

export type ReaderState =
  | { status: "unconfigured" }
  | { status: "loading" }
  | { status: "ready"; reader: ChainReader }
  | { status: "error"; message: string };

/** Opens the router and vault for reading through the configured RPC. A wrong address or an unreachable node becomes a message, not a crash. */
export function useReader(): ReaderState {
  const config = useConfig();
  const [state, setState] = useState<ReaderState>(config.contractsConfigured ? { status: "loading" } : { status: "unconfigured" });
  useEffect(() => {
    if (!config.router || !config.vault) {
      setState({ status: "unconfigured" });
      return;
    }
    let cancelled = false;
    const network = Network.from(config.chainId);
    // Reads go to the first endpoint that answers and fall back to the next ones; every request has a time limit.
    const provider = new FailoverJsonRpcProvider(readEndpoints({ chainId: config.chainId, rpcUrl: config.rpcUrl }), network, { staticNetwork: network, cacheTimeout: -1 }, 15_000);
    setState({ status: "loading" });
    openReader(provider, { router: config.router, vault: config.vault })
      .then((reader) => {
        if (!cancelled) setState({ status: "ready", reader });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: "error", message: err instanceof Error && err.message ? err.message : "the contracts could not be read" });
      });
    return () => {
      cancelled = true;
      provider.destroy();
    };
  }, [config.router, config.vault, config.rpcUrl, config.chainId]);
  return state;
}

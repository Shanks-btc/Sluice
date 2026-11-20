// The QIE networks the app knows, with the chain parameters a wallet needs to add one. Mainnet's values are the ones QIE publishes
// (chain 1990, https://rpc1mainnet.qie.digital/, https://mainnet.qie.digital/, native coin QIE). The testnet entry has no explorer
// link because none was checked, and the app shows no link rather than one it did not check.
export type NetworkId = "mainnet" | "testnet" | "local";

export type NetworkInfo = {
  id: NetworkId;
  label: string;
  chainId: number;
  rpcUrl: string;
  explorerUrl?: string;
  /** True when the funds on this network are worth money. The app says so wherever it names the network. */
  realFunds: boolean;
  note: string;
};

export const NATIVE_CURRENCY = { name: "QIE", symbol: "QIE", decimals: 18 } as const;

export const MAINNET: NetworkInfo = {
  id: "mainnet",
  label: "QIE mainnet",
  chainId: 1990,
  rpcUrl: "https://rpc1mainnet.qie.digital/",
  explorerUrl: "https://mainnet.qie.digital",
  realFunds: true,
  note: "The live QIE network. Funds here are real.",
};

export const TESTNET: NetworkInfo = {
  id: "testnet",
  label: "QIE testnet",
  chainId: 1983,
  rpcUrl: "https://rpc1testnet.qie.digital/",
  realFunds: false,
  note: "QIE's test network. Funds here have no value.",
};

export const LOCAL: NetworkInfo = {
  id: "local",
  label: "Local node or fork",
  chainId: 1990,
  rpcUrl: "http://127.0.0.1:8545",
  realFunds: false,
  note: "A node on this machine, or a local copy of mainnet. No real funds move.",
};

export const NETWORKS: Readonly<Record<NetworkId, NetworkInfo>> = { mainnet: MAINNET, testnet: TESTNET, local: LOCAL };

export const toHexChainId = (chainId: number): string => `0x${chainId.toString(16)}`;

/** The parameters for wallet_addEthereumChain. Built from the network entry, never typed twice. */
export function chainParams(network: NetworkInfo) {
  return {
    chainId: toHexChainId(network.chainId),
    chainName: network.label,
    nativeCurrency: { ...NATIVE_CURRENCY },
    rpcUrls: [network.rpcUrl],
    ...(network.explorerUrl ? { blockExplorerUrls: [`${network.explorerUrl}/`] } : {}),
  };
}

export const isLocalUrl = (url: string): boolean => {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
};

/** The network a chain id names. A local node can use any id, so a local RPC address always counts as local. */
export function networkFor(chainId: number, rpcUrl?: string): NetworkInfo {
  if (rpcUrl && isLocalUrl(rpcUrl)) return { ...LOCAL, chainId, rpcUrl };
  if (chainId === MAINNET.chainId) return MAINNET;
  if (chainId === TESTNET.chainId) return TESTNET;
  return { id: "local", label: `Network ${chainId}`, chainId, rpcUrl: rpcUrl ?? "", realFunds: false, note: "A network the app does not recognise." };
}

const HASH = /^0x[0-9a-fA-F]{64}$/;

/** A link to a transaction on QIE mainnet's explorer, or undefined if the hash is not a transaction hash. */
export function explorerTxUrl(hash: string, network: NetworkInfo = MAINNET): string | undefined {
  if (!HASH.test(hash) || !network.explorerUrl) return undefined;
  return `${network.explorerUrl}/tx/${hash}`;
}

export function explorerAddressUrl(address: string, network: NetworkInfo = MAINNET): string | undefined {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || !network.explorerUrl) return undefined;
  return `${network.explorerUrl}/address/${address}`;
}

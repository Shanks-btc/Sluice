// Talking to an injected wallet (QIE Wallet, MetaMask, or any other EIP-1193 provider). The app asks the wallet for accounts, a chain
// and signatures. It never asks for a key, and a wallet never hands one over.
import { chainParams, toHexChainId } from "./networks";
import type { NetworkInfo } from "./networks";

export type RequestArgs = { method: string; params?: readonly unknown[] | object };

export interface Eip1193Provider {
  request(args: RequestArgs): Promise<unknown>;
  on?(event: string, handler: (...args: never[]) => void): void;
  removeListener?(event: string, handler: (...args: never[]) => void): void;
}

export type WalletErrorCode =
  | "rejected"
  | "no_wallet"
  | "unknown_chain"
  | "request_pending"
  | "unsupported_method"
  | "wrong_network"
  | "failed";

export class WalletError extends Error {
  constructor(
    readonly code: WalletErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WalletError";
  }
}

/** Sorts a wallet's error into one of a few cases the app knows how to explain. */
export function classifyWalletError(err: unknown): WalletErrorCode {
  if (err instanceof WalletError) return err.code;
  const e = err as { code?: unknown; message?: unknown; info?: { error?: { code?: unknown } } } | null;
  const code = e?.code ?? e?.info?.error?.code;
  if (code === 4001 || code === "ACTION_REJECTED") return "rejected";
  if (code === 4902) return "unknown_chain";
  if (code === -32002) return "request_pending";
  if (code === 4200 || code === -32601) return "unsupported_method";
  const message = typeof e?.message === "string" ? e.message : "";
  if (/user (rejected|denied|cancel)|rejected the request|request rejected/i.test(message)) return "rejected";
  if (/unrecognized chain|unknown chain|not been added/i.test(message)) return "unknown_chain";
  if (/not supported|does not exist|unsupported method|not implemented/i.test(message)) return "unsupported_method";
  return "failed";
}

/** A sentence for the person. It never includes the wallet's raw message, which can hold an address or a URL. */
export function describeWalletError(err: unknown): string {
  switch (classifyWalletError(err)) {
    case "rejected":
      return "You rejected the request in your wallet. Nothing was sent.";
    case "no_wallet":
      return "No wallet was found in this browser. Install QIE Wallet or MetaMask, then reload.";
    case "unknown_chain":
      return "Your wallet does not have this network yet. Add it, then try again.";
    case "request_pending":
      return "Your wallet already has a request waiting. Open it and answer, then try again.";
    case "unsupported_method":
      return "Your wallet does not support this kind of request.";
    case "wrong_network":
      return "Your wallet is on a different network. Switch networks, then try again.";
    default:
      return "The wallet could not complete the request. Nothing was sent.";
  }
}

export const hexToNumber = (value: unknown): number => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^0x[0-9a-fA-F]{1,13}$/.test(value)) return Number.parseInt(value, 16);
  if (typeof value === "string" && /^\d{1,13}$/.test(value)) return Number(value);
  throw new WalletError("failed", "the wallet sent a chain id the app cannot read");
};

export async function readChainId(provider: Eip1193Provider): Promise<number> {
  return hexToNumber(await provider.request({ method: "eth_chainId" }));
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Asks the wallet for permission to see an account. The person approves it in the wallet. */
export async function connectWallet(provider: Eip1193Provider): Promise<{ account: string; chainId: number }> {
  let accounts: unknown;
  try {
    accounts = await provider.request({ method: "eth_requestAccounts" });
  } catch (err) {
    throw new WalletError(classifyWalletError(err), describeWalletError(err));
  }
  const first = Array.isArray(accounts) ? accounts[0] : undefined;
  if (typeof first !== "string" || !ADDRESS.test(first)) throw new WalletError("failed", "the wallet did not share an account");
  return { account: first, chainId: await readChainId(provider) };
}

export type NetworkState = "unknown" | "ok" | "wrong";

/** Whether the wallet is on the network the app is set up for. */
export function networkState(walletChainId: number | null | undefined, expected: number): NetworkState {
  if (walletChainId === null || walletChainId === undefined) return "unknown";
  return walletChainId === expected ? "ok" : "wrong";
}

/**
 * Switches the wallet to a network, adding it first if the wallet does not know it. The parameters come from the network table, so
 * what a wallet is asked to add is what the app shows.
 */
export async function switchChain(provider: Eip1193Provider, network: NetworkInfo): Promise<void> {
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: toHexChainId(network.chainId) }] });
    return;
  } catch (err) {
    if (classifyWalletError(err) !== "unknown_chain") throw new WalletError(classifyWalletError(err), describeWalletError(err));
  }
  try {
    await provider.request({ method: "wallet_addEthereumChain", params: [chainParams(network)] });
  } catch (err) {
    throw new WalletError(classifyWalletError(err), describeWalletError(err));
  }
}

/** The injected wallet, if the browser has one. */
export function findInjectedWallet(scope: { ethereum?: unknown } | undefined): Eip1193Provider | undefined {
  const candidate = scope?.ethereum as Partial<Eip1193Provider> | undefined;
  return candidate && typeof candidate.request === "function" ? (candidate as Eip1193Provider) : undefined;
}

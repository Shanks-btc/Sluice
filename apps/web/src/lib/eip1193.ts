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
  | "locked"
  | "nonce"
  | "underpriced"
  | "insufficient_gas"
  | "reverted"
  | "node_down"
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

type ErrorLike = { code?: unknown; message?: unknown; shortMessage?: unknown; data?: { message?: unknown }; error?: { message?: unknown }; info?: { error?: { code?: unknown; message?: unknown } } } | null;

/** Every message an error carries, joined, so a wallet's own wording is found wherever it put it. Never shown to the person. */
const messagesOf = (err: unknown): string => {
  const e = err as ErrorLike;
  return [e?.message, e?.shortMessage, e?.data?.message, e?.error?.message, e?.info?.error?.message].filter((m): m is string => typeof m === "string").join(" | ");
};

/** Sorts a wallet's error into one of a few cases the app knows how to explain. The wallet's raw message is read here and never shown. */
export function classifyWalletError(err: unknown): WalletErrorCode {
  if (err instanceof WalletError) return err.code;
  const e = err as ErrorLike;
  const code = e?.code ?? e?.info?.error?.code;
  if (code === 4001 || code === "ACTION_REJECTED") return "rejected";
  if (code === 4902) return "unknown_chain";
  if (code === -32002) return "request_pending";
  if (code === 4200 || code === -32601) return "unsupported_method";
  if (code === "NONCE_EXPIRED") return "nonce";
  if (code === "REPLACEMENT_UNDERPRICED") return "underpriced";
  if (code === "INSUFFICIENT_FUNDS") return "insufficient_gas";
  if (code === "UNPREDICTABLE_GAS_LIMIT" || code === "CALL_EXCEPTION") return "reverted";
  if (code === "NETWORK_ERROR" || code === "TIMEOUT" || code === "SERVER_ERROR") return "node_down";
  const message = messagesOf(err);
  if (/user (rejected|denied|cancel)|rejected the request|request rejected/i.test(message)) return "rejected";
  if (/unrecognized chain|unknown chain|not been added/i.test(message)) return "unknown_chain";
  if (/\b(locked|unlock)\b/i.test(message)) return "locked";
  if (/nonce too low|nonce has already been used|nonce is too low/i.test(message)) return "nonce";
  if (/replacement transaction underpriced|already known|transaction underpriced|max fee per gas less than|fee cap less than|gas price below|intrinsic gas too low/i.test(message)) return "underpriced";
  if (/insufficient funds|exceeds the balance of the account|not enough funds/i.test(message)) return "insufficient_gas";
  if (/execution reverted|cannot estimate gas|gas required exceeds|unpredictable gas limit/i.test(message)) return "reverted";
  if (/network error|failed to fetch|network request failed|econnrefused|fetch failed|could not detect network|timed out/i.test(message)) return "node_down";
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
    case "locked":
      return "Your wallet is locked. Unlock it, then try again. Nothing was sent.";
    case "nonce":
      return "Your wallet's transaction count is out of date, usually because another transaction from it is still finishing. Wait a few seconds and try again. Nothing was sent.";
    case "underpriced":
      return "The network fee in the request was too low for the network just now, or the same transaction is already waiting. Wait a moment, check your wallet for a pending one, and try again.";
    case "insufficient_gas":
      return "Your wallet holds too little QIE to pay the network fee. Add a little QIE, or use the route that needs none if a facilitator is set. Nothing was sent.";
    case "reverted":
      return "The network says this would fail, so it was not sent. Check your QUSDC balance, the approval and, for an agent key, its limits.";
    case "node_down":
      return "The network node did not answer. Wait a moment and try again. Nothing was sent unless your wallet shows a pending transaction.";
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
  // A locked wallet answers with no account instead of an error. That is the one case the app can name.
  if (Array.isArray(accounts) && accounts.length === 0) throw new WalletError("locked", describeWalletError(new WalletError("locked", "")));
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

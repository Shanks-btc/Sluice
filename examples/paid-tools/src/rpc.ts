// Read-only access to QIE for the paid tools: the node's RPC for state and code, and the public explorer's read API
// for what the RPC cannot give (a verified source, a log index back to block 0). Nothing here sends a transaction,
// signs anything or needs a key.
import { Contract, getAddress } from "ethers";
import type { Provider } from "ethers";
import { within } from "@sluice/sdk";

export const PUBLIC_RPC = "https://rpc1mainnet.qie.digital/";
export const PUBLIC_EXPLORER = "https://mainnet.qie.digital";

/** What the tools need from a node. A real provider satisfies it, and so does a test double. */
export interface Rpc {
  call(to: string, data: string, from?: string): Promise<string>;
  getCode(address: string): Promise<string>;
  getStorageAt(address: string, slot: string): Promise<string>;
}

export function rpcFromProvider(provider: Provider): Rpc {
  return {
    call: (to, data, from) => provider.call({ to, data, ...(from ? { from } : {}) }),
    getCode: (address) => provider.getCode(address),
    getStorageAt: (address, slot) => provider.getStorage(address, slot),
  };
}

/**
 * The same node with a time limit on every read, so a node that stops answering cannot hold a paid call (and the connection of the
 * caller who made it) open. A read that runs out of time rejects, and the tool answers with its fixed "could not be read" line,
 * which is not charged.
 */
export function withTimeout(rpc: Rpc, ms: number): Rpc {
  return {
    call: (to, data, from) => within(rpc.call(to, data, from), ms),
    getCode: (address) => within(rpc.getCode(address), ms),
    getStorageAt: (address, slot) => within(rpc.getStorageAt(address, slot), ms),
  };
}

/** An eth_call that returns undefined instead of throwing when the call reverts or the target has no code. */
export async function tryCall(rpc: Rpc, to: string, data: string, from?: string): Promise<string | undefined> {
  try {
    const out = await rpc.call(to, data, from);
    return out === "0x" ? undefined : out;
  } catch {
    return undefined;
  }
}

export type ExplorerResponse = { status: number; json: unknown };
export type ExplorerGet = (path: string) => Promise<ExplorerResponse>;

/**
 * A GET-only client for the explorer. It can only reach the explorer it was built for, over https (or the local machine
 * in tests), and only with paths this module's callers pass. A timeout and a size limit keep a slow or huge answer from
 * hanging a paid call.
 */
export function explorerClient(base: string = PUBLIC_EXPLORER, fetchImpl: typeof fetch = fetch, timeoutMs = 15_000): ExplorerGet {
  const root = new URL(base);
  if (root.protocol !== "https:" && root.hostname !== "127.0.0.1" && root.hostname !== "localhost") {
    throw new Error("the explorer URL must be https");
  }
  return async (path) => {
    const url = new URL(path, root);
    if (url.origin !== root.origin) throw new Error("refusing to leave the explorer's origin");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let status: number;
    let text: string;
    try {
      const res = await fetchImpl(url, { method: "GET", headers: { accept: "application/json" }, signal: controller.signal });
      status = res.status;
      text = await res.text();
    } finally {
      clearTimeout(timer); // no timer is left pending after the answer
    }
    if (text.length > 8_000_000) throw new Error("the explorer's answer is too large");
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status, json };
  };
}

export const erc20 = (provider: Provider, address: string) =>
  new Contract(
    getAddress(address),
    [
      "function name() view returns (string)",
      "function symbol() view returns (string)",
      "function decimals() view returns (uint8)",
      "function totalSupply() view returns (uint256)",
      "function balanceOf(address) view returns (uint256)",
    ],
    provider,
  );

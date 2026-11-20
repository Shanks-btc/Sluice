// Reading deployed bytecode: which function selectors it dispatches on, whether it is a proxy, and which compiler built it.
// Everything here is a fact about the bytes, or a heuristic that says so.
import { getAddress, id, keccak256 } from "ethers";
import { tryCall } from "./rpc";
import type { Rpc } from "./rpc";

/** The selectors a PUSH4 in the code loads. A contract's dispatcher compares the call's selector with these. */
export function pushedSelectors(codeHex: string): Set<string> {
  const code = Buffer.from(codeHex.replace(/^0x/, ""), "hex");
  // Solidity appends CBOR metadata, whose length is in the last two bytes. It is data, not code.
  const metaLen = code.length >= 2 ? ((code[code.length - 2] as number) << 8) | (code[code.length - 1] as number) : 0;
  const end = metaLen > 0 && metaLen + 2 <= code.length ? code.length - 2 - metaLen : code.length;
  const found = new Set<string>();
  let i = 0;
  while (i < end) {
    const op = code[i] as number;
    if (op === 0x63 && i + 4 < code.length) found.add(`0x${code.subarray(i + 1, i + 5).toString("hex")}`);
    i += op >= 0x60 && op <= 0x7f ? 1 + (op - 0x5f) : 1;
  }
  return found;
}

export const selectorOf = (signature: string): string => id(signature).slice(0, 10);

const SLOT = {
  implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
} as const;

const asAddress = (word: string): string | undefined => {
  const hex = word.replace(/^0x/, "").padStart(64, "0");
  const addr = `0x${hex.slice(24)}`;
  return /^0x0{40}$/.test(addr) ? undefined : getAddress(addr);
};

export type ProxyInfo =
  | { isProxy: false }
  | { isProxy: true; kind: "eip1967" | "eip1967-beacon" | "eip1167-minimal"; implementation?: string; admin?: string; beacon?: string };

/** ERC-1967 slots (implementation, admin, beacon) and the ERC-1167 minimal proxy byte pattern. */
export async function detectProxy(rpc: Rpc, address: string, code: string): Promise<ProxyInfo> {
  const hex = code.replace(/^0x/, "").toLowerCase();
  const minimal = /^363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3/.exec(hex);
  if (minimal) return { isProxy: true, kind: "eip1167-minimal", implementation: getAddress(`0x${minimal[1]}`) };
  const [impl, admin, beacon] = await Promise.all([
    rpc.getStorageAt(address, SLOT.implementation),
    rpc.getStorageAt(address, SLOT.admin),
    rpc.getStorageAt(address, SLOT.beacon),
  ]);
  const implementation = asAddress(impl);
  if (implementation) return { isProxy: true, kind: "eip1967", implementation, admin: asAddress(admin) };
  const beaconAddress = asAddress(beacon);
  if (beaconAddress) return { isProxy: true, kind: "eip1967-beacon", beacon: beaconAddress, admin: asAddress(admin) };
  return { isProxy: false };
}

export type CompilerMetadata = { solc?: string; ipfs?: string; bzzr0?: string; bzzr1?: string; experimental?: boolean };

/** Decodes the small CBOR map the Solidity compiler appends to runtime code. Returns undefined if the tail is not one. */
export function readMetadata(codeHex: string): CompilerMetadata | undefined {
  const code = Buffer.from(codeHex.replace(/^0x/, ""), "hex");
  if (code.length < 4) return undefined;
  const len = ((code[code.length - 2] as number) << 8) | (code[code.length - 1] as number);
  if (len === 0 || len + 2 > code.length) return undefined;
  const cbor = code.subarray(code.length - 2 - len, code.length - 2);
  let p = 0;
  const head = (): { major: number; value: number } | undefined => {
    const b = cbor[p++];
    if (b === undefined) return undefined;
    const major = b >> 5;
    const info = b & 0x1f;
    if (info < 24) return { major, value: info };
    if (info === 24) {
      const v = cbor[p++];
      return v === undefined ? undefined : { major, value: v };
    }
    return undefined;
  };
  const map = head();
  if (!map || map.major !== 5 || map.value > 8) return undefined;
  const out: CompilerMetadata = {};
  for (let k = 0; k < map.value; k++) {
    const key = head();
    if (!key || key.major !== 3) return undefined;
    const name = cbor.subarray(p, p + key.value).toString("utf8");
    p += key.value;
    const value = head();
    if (!value) return undefined;
    if (value.major === 2) {
      const bytes = cbor.subarray(p, p + value.value);
      p += value.value;
      if (name === "solc" && bytes.length === 3) out.solc = `${bytes[0]}.${bytes[1]}.${bytes[2]}`;
      else if (name === "ipfs" || name === "bzzr0" || name === "bzzr1") out[name] = `0x${bytes.toString("hex")}`;
    } else if (value.major === 7 && (value.value === 20 || value.value === 21)) {
      if (name === "experimental") out.experimental = value.value === 21;
    } else {
      return undefined;
    }
  }
  return out;
}

export const codeHash = (code: string): string => keccak256(code);

export const callName = async (rpc: Rpc, to: string, signature: string, args = ""): Promise<string | undefined> =>
  tryCall(rpc, to, selectorOf(signature) + args);

// contract_lookup: is this contract verified, who built it with what, is it a proxy, and does the explorer's copy match
// what is actually deployed?
//
// The bytecode facts (size, hash, compiler version in the metadata tail, proxy slots) come from the node's RPC. The
// verification facts (source, name, compiler settings, ABI, creator) come from the public explorer's read API, which is
// a service and not the chain: the answer says which is which, and compares the explorer's bytecode with the node's.
import { getAddress, keccak256 } from "ethers";
import { codeHash, detectProxy, readMetadata } from "./bytecode";
import type { CompilerMetadata, ProxyInfo } from "./bytecode";
import type { ExplorerGet, Rpc } from "./rpc";

export type ContractLookup = {
  address: string;
  isContract: boolean;
  codeSizeBytes: number;
  codeHash?: string;
  /** From the deployed bytecode's own metadata tail. */
  compilerFromBytecode?: CompilerMetadata;
  proxy?: ProxyInfo;
  explorer: {
    available: boolean;
    verified?: boolean;
    reason?: string;
    name?: string;
    language?: string;
    compilerVersion?: string;
    evmVersion?: string | null;
    optimization?: boolean;
    optimizationRuns?: number | null;
    license?: string | null;
    verifiedAt?: string | null;
    fullyVerified?: boolean;
    sourceFiles?: number;
    implementations?: Array<{ address: string; name?: string }>;
    creator?: string;
    creationTransaction?: string;
    /** keccak256 of the explorer's deployed bytecode equals the node's code hash. */
    bytecodeMatchesNode?: boolean;
    /** The solc version in the bytecode tail equals the explorer's compiler version. */
    compilerMatchesBytecode?: boolean;
    abi?: { readFunctions: number; writeFunctions: string[]; events: string[]; adminLike: string[] };
  };
  notes: string[];
};

const ADMIN_LIKE = /^(mint|burn|pause|unpause|upgrade|set[A-Z_]|grantRole|revokeRole|transferOwnership|renounceOwnership|blacklist|freeze|withdraw|rescue|sweep|emergency|kill|destroy)/;

type AbiItem = { type: string; name?: string; stateMutability?: string; inputs?: Array<{ type: string }> };

const signature = (i: AbiItem) => `${i.name}(${(i.inputs ?? []).map((x) => x.type).join(",")})`;

export async function contractLookup(deps: { rpc: Rpc; explorer?: ExplorerGet }, rawAddress: string): Promise<ContractLookup> {
  const address = getAddress(rawAddress);
  const code = await deps.rpc.getCode(address);
  const notes = ["Bytecode facts come from the node. Verification facts come from the explorer, which is a service rather than the chain."];
  if (code === "0x") {
    return { address, isContract: false, codeSizeBytes: 0, explorer: { available: Boolean(deps.explorer) }, notes: [...notes, "There is no contract code at this address."] };
  }
  const result: ContractLookup = {
    address,
    isContract: true,
    codeSizeBytes: (code.length - 2) / 2,
    codeHash: codeHash(code),
    compilerFromBytecode: readMetadata(code),
    proxy: await detectProxy(deps.rpc, address, code),
    explorer: { available: false },
    notes,
  };
  if (!deps.explorer) {
    result.explorer = { available: false, reason: "no explorer was configured" };
    return result;
  }
  try {
    const res = await deps.explorer(`/api/v2/smart-contracts/${address}`);
    if (res.status === 404) {
      result.explorer = { available: true, verified: false };
      notes.push("The explorer has no verified source for this address.");
    } else if (res.status !== 200 || typeof res.json !== "object" || res.json === null) {
      result.explorer = { available: false, reason: `the explorer answered HTTP ${res.status}` };
    } else {
      const d = res.json as Record<string, unknown>;
      const abi = (Array.isArray(d.abi) ? d.abi : []) as AbiItem[];
      const functions = abi.filter((i) => i.type === "function");
      const writes = functions.filter((f) => f.stateMutability !== "view" && f.stateMutability !== "pure").map(signature);
      const explorerCode = typeof d.deployed_bytecode === "string" ? d.deployed_bytecode : undefined;
      const compilerVersion = typeof d.compiler_version === "string" ? d.compiler_version : undefined;
      const fromBytecode = result.compilerFromBytecode?.solc;
      const verified = d.is_verified === true || d.is_verified === undefined;
      result.explorer = {
        available: true,
        verified,
        name: typeof d.name === "string" ? d.name : undefined,
        language: typeof d.language === "string" ? d.language : undefined,
        compilerVersion,
        evmVersion: (d.evm_version as string | null | undefined) ?? null,
        optimization: typeof d.optimization_enabled === "boolean" ? d.optimization_enabled : undefined,
        optimizationRuns: (d.optimization_runs as number | null | undefined) ?? null,
        license: (d.license_type as string | null | undefined) ?? null,
        verifiedAt: (d.verified_at as string | null | undefined) ?? null,
        fullyVerified: typeof d.is_fully_verified === "boolean" ? d.is_fully_verified : undefined,
        sourceFiles: (typeof d.source_code === "string" ? 1 : 0) + (Array.isArray(d.additional_sources) ? d.additional_sources.length : 0),
        implementations: Array.isArray(d.implementations)
          ? (d.implementations as Array<{ address_hash?: string; address?: string; name?: string }>).map((i) => ({ address: String(i.address_hash ?? i.address ?? ""), name: i.name }))
          : undefined,
        bytecodeMatchesNode: explorerCode ? keccak256(explorerCode) === result.codeHash : undefined,
        compilerMatchesBytecode: compilerVersion && fromBytecode ? compilerVersion.replace(/^v/, "").startsWith(fromBytecode) : undefined,
        abi: {
          readFunctions: functions.length - writes.length,
          writeFunctions: writes,
          events: abi.filter((i) => i.type === "event").map(signature),
          adminLike: writes.filter((w) => ADMIN_LIKE.test(w)),
        },
      };
      if (result.explorer.bytecodeMatchesNode === false) notes.push("The explorer's bytecode differs from the node's. Treat the explorer's source as unconfirmed for this address.");
      if (result.proxy?.isProxy) notes.push("This address is a proxy: the verified source above may describe the proxy and not the logic it runs. Look up the implementation too.");
    }
    // Creator, from the address record. Best effort: the lookup stands without it.
    try {
      const a = await deps.explorer(`/api/v2/addresses/${address}`);
      if (a.status === 200 && typeof a.json === "object" && a.json !== null) {
        const j = a.json as Record<string, unknown>;
        if (typeof j.creator_address_hash === "string") result.explorer.creator = getAddress(j.creator_address_hash);
        if (typeof j.creation_transaction_hash === "string") result.explorer.creationTransaction = j.creation_transaction_hash;
      }
    } catch {
      // the creator is optional
    }
  } catch {
    result.explorer = { available: false, reason: "the explorer could not be reached" };
  }
  return result;
}

// The vault check: is the code at the router's vault the compiled AgentVault of this repository?
//
// AgentVault is not deployed on its own. The router's constructor creates it, so it has no deployment transaction of its own, and
// QIE's explorer has no creation record for it. What a reader can check without any explorer is the code, including the values the
// constructor wrote into it. This reads the vault's address from the router, reads the code at that address, builds
// the code the compiler produced for AgentVault with every immutable slot filled in as the constructor would have filled it, and compares
// the two by their keccak256 hash. It prints the settings a reader needs to build it again.
//
// The vault has six immutables, in seven places in its runtime code: the router's address (read twice by the code, so two places), and
// five that the EIP-712 base contract caches (the name hash, the version hash, the chain id, the vault's own address, and the domain
// separator built from them). Each one's value is worked out here from the router, the vault's address and the chain id, never copied
// from the chain's code, so a slot that holds anything else is a difference and is reported as one.
//
// Read-only: four RPC methods (listed in VAULTCHECK_READ_ONLY_METHODS), no key, no transaction.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Interface, TypedDataEncoder, getAddress, getBytes, hexlify, keccak256, toBeHex, toQuantity, toUtf8Bytes, zeroPadValue } from "ethers";
import type { Rpc } from "./evidence";
import { RpcRefused } from "./readrpc";
import { safeReaddir } from "./secret-paths";
import { EXPECTED, VerifyError, buildInput } from "./verify-contracts";

/** Every method the vault check may call. */
export const VAULTCHECK_READ_ONLY_METHODS: ReadonlySet<string> = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_call", "eth_getCode"]);

/** The vault's EIP-712 domain, from its constructor (contracts/AgentVault.sol) and docs/SPEC.md. */
export const VAULT_DOMAIN_NAME = "SluiceAgentVault";
export const VAULT_DOMAIN_VERSION = "1";

export const VAULT_SOURCE = "contracts/AgentVault.sol";
export const VAULT_CONTRACT = "AgentVault";

// ------------------------------------------------------------------------------------------------------------------- the compiled vault

export type Slot = { name: string; start: number; length: number };

export type Compiled = {
  /** `v0.8.24+commit.e11b9ed9`, the way an explorer writes it. */
  compilerVersion: string;
  evmVersion: string;
  optimizerRuns: number;
  /** The runtime code the compiler produced, from the repository's Hardhat artifact, with every immutable slot zero. */
  runtime: string;
  /** The immutable slots in the runtime code, by byte offset. */
  slots: Slot[];
};

type BuildOutput = {
  evm?: { deployedBytecode?: { object?: string; immutableReferences?: Record<string, Array<{ start: number; length: number }>> } };
  metadata?: string;
};
type BuildInfo = {
  solcLongVersion: string;
  output: { contracts: Record<string, Record<string, BuildOutput>>; sources: Record<string, { ast?: unknown }> };
};

/** The names of the declarations with these ids, found in the syntax trees of the files the contract was built from. */
function declarationNames(info: BuildInfo, files: string[], ids: Set<number>): Map<number, string> {
  const found = new Map<number, string>();
  const visit = (node: unknown): void => {
    if (found.size === ids.size || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const n of node) visit(n);
      return;
    }
    const o = node as Record<string, unknown>;
    if (o.nodeType === "VariableDeclaration" && typeof o.id === "number" && ids.has(o.id) && typeof o.name === "string") found.set(o.id, o.name);
    for (const v of Object.values(o)) if (v && typeof v === "object") visit(v);
  };
  for (const file of files) visit(info.output.sources[file]?.ast);
  return found;
}

/**
 * Reads what the repository compiled for AgentVault: the runtime code (from the Hardhat artifact), where its immutable slots are and what
 * each is called (from the build info that compiled it), and the compiler settings, checked to be the documented ones.
 */
export function readCompiled(root: string): Compiled {
  // buildInput refuses anything but solc 0.8.24, the Shanghai EVM, and the optimizer on at 200 runs.
  const build = buildInput(root, VAULT_SOURCE, VAULT_CONTRACT);
  const dir = join(root, "artifacts", "build-info");
  const files = safeReaddir(dir).filter((f) => f.endsWith(".json")).map((f) => ({ file: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
  for (const { file } of files) {
    const info = JSON.parse(readFileSync(file, "utf8")) as BuildInfo;
    const built = info.output.contracts[VAULT_SOURCE]?.[VAULT_CONTRACT];
    if (!built?.metadata) continue;
    const deployed = built.evm?.deployedBytecode;
    if (!deployed?.object) throw new VerifyError("the build info has no runtime code for AgentVault");
    const artifactFile = join(root, "artifacts", "contracts", "AgentVault.sol", "AgentVault.json");
    if (!existsSync(artifactFile)) throw new VerifyError("there is no artifacts/contracts/AgentVault.sol/AgentVault.json: run pnpm compile first");
    const artifact = JSON.parse(readFileSync(artifactFile, "utf8")) as { deployedBytecode?: string };
    const runtime = `0x${deployed.object}`.toLowerCase();
    if (artifact.deployedBytecode?.toLowerCase() !== runtime) throw new VerifyError("the Hardhat artifact and the build info disagree about AgentVault's runtime code: run pnpm compile again");
    const refs = deployed.immutableReferences ?? {};
    const sources = Object.keys((JSON.parse(built.metadata) as { sources: Record<string, unknown> }).sources);
    const names = declarationNames(info, sources, new Set(Object.keys(refs).map(Number)));
    const slots: Slot[] = [];
    for (const [astId, places] of Object.entries(refs)) {
      const name = names.get(Number(astId));
      if (!name) throw new VerifyError(`an immutable of AgentVault (syntax tree id ${astId}) could not be named from the build info`);
      for (const p of places) slots.push({ name, start: p.start, length: p.length });
    }
    slots.sort((a, b) => a.start - b.start);
    return { compilerVersion: build.compilerVersion, evmVersion: EXPECTED.evmVersion, optimizerRuns: EXPECTED.optimizerRuns, runtime, slots };
  }
  throw new VerifyError("no build info holds AgentVault: run pnpm compile first");
}

// ------------------------------------------------------------------------------------------------------------------ the expected code

export type Context = { router: string; vault: string; chainId: number };

const word = (value: string | bigint): string => zeroPadValue(typeof value === "bigint" ? toBeHex(value) : value, 32);

/** What each immutable slot holds in the vault the router's constructor made, worked out from the chain and not read from it. */
export function slotValues(ctx: Context): Record<string, string> {
  const nameHash = keccak256(toUtf8Bytes(VAULT_DOMAIN_NAME));
  const versionHash = keccak256(toUtf8Bytes(VAULT_DOMAIN_VERSION));
  return {
    router: word(getAddress(ctx.router)),
    _nameHash: nameHash,
    _versionHash: versionHash,
    _cachedChainId: word(BigInt(ctx.chainId)),
    _cachedThis: word(getAddress(ctx.vault)),
    _cachedSeparator: TypedDataEncoder.hashDomain({ name: VAULT_DOMAIN_NAME, version: VAULT_DOMAIN_VERSION, chainId: ctx.chainId, verifyingContract: getAddress(ctx.vault) }),
  };
}

/** The runtime code with every slot filled in. A slot this does not know a value for is returned in `unknown`, and left zero. */
export function expectedCode(compiled: Compiled, ctx: Context): { code: string; unknown: string[]; values: Record<string, string> } {
  const values = slotValues(ctx);
  const bytes = getBytes(compiled.runtime);
  const unknown: string[] = [];
  for (const slot of compiled.slots) {
    const value = values[slot.name];
    if (!value || slot.length !== 32) {
      unknown.push(slot.name);
      continue;
    }
    bytes.set(getBytes(value), slot.start);
  }
  return { code: hexlify(bytes), unknown: [...new Set(unknown)], values };
}

/** The solc version the compiler wrote into the end of a contract's code (its metadata), like `0.8.24`, or undefined if it is not there. */
export function embeddedSolc(code: string): string | undefined {
  const hex = code.toLowerCase().replace(/^0x/, "");
  const length = parseInt(hex.slice(-4), 16);
  if (!Number.isInteger(length) || length * 2 + 4 > hex.length) return undefined;
  const cbor = hex.slice(hex.length - 4 - length * 2, hex.length - 4);
  const at = cbor.indexOf("64736f6c6343"); // the text key "solc", then three bytes
  if (at < 0) return undefined;
  const v = cbor.slice(at + 12, at + 18);
  return v.length === 6 ? [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16)).join(".") : undefined;
}

// ----------------------------------------------------------------------------------------------------------------------- the chain

const routerViews = new Interface(["function vault() view returns (address)"]);
const vaultViews = new Interface(["function router() view returns (address)"]);

export type VaultFacts = {
  chainId: number;
  block: number;
  timestamp: number;
  router: string;
  routerHasCode: boolean;
  /** What the router says its vault is. Undefined when the router would not say. */
  vault?: string;
  vaultCode?: string;
  /** What the vault says its router is. */
  vaultRouter?: string;
};

async function ask(rpc: Rpc, to: string, data: string, at: string): Promise<string | undefined> {
  try {
    const out = await rpc("eth_call", [{ to, data }, at]);
    return typeof out === "string" && out !== "0x" ? out : undefined;
  } catch (err) {
    if (err instanceof RpcRefused) return undefined;
    throw err;
  }
}

/** Reads the router's vault and the vault's code, all at one block. Throws only when the chain cannot be read. */
export async function readVaultFacts(rpc: Rpc, router: string): Promise<VaultFacts> {
  const routerAddress = getAddress(router);
  const chainId = Number(BigInt(String(await rpc("eth_chainId", []))));
  const head = (await rpc("eth_getBlockByNumber", ["latest", false])) as { number: string; timestamp: string } | null;
  if (!head) throw new Error("the latest block could not be read");
  const block = Number(BigInt(head.number));
  const at = toQuantity(block);
  const routerCode = await rpc("eth_getCode", [routerAddress, at]);
  const facts: VaultFacts = { chainId, block, timestamp: Number(BigInt(head.timestamp)), router: routerAddress, routerHasCode: typeof routerCode === "string" && routerCode !== "0x" };
  if (!facts.routerHasCode) return facts;
  const vaultAnswer = await ask(rpc, routerAddress, routerViews.encodeFunctionData("vault"), at);
  if (!vaultAnswer) return facts;
  let vault: string;
  try {
    vault = getAddress(String(routerViews.decodeFunctionResult("vault", vaultAnswer)[0]));
  } catch {
    return facts;
  }
  facts.vault = vault;
  const code = await rpc("eth_getCode", [vault, at]);
  if (typeof code === "string") facts.vaultCode = code;
  const back = await ask(rpc, vault, vaultViews.encodeFunctionData("router"), at);
  if (back) {
    try {
      facts.vaultRouter = getAddress(String(vaultViews.decodeFunctionResult("router", back)[0]));
    } catch {
      // an answer that is not an address is left out, and reported as the vault not naming its router
    }
  }
  return facts;
}

// ---------------------------------------------------------------------------------------------------------------------- the report

export type Level = "PASS" | "FAIL";
export type Line = { level: Level; text: string };
const pass = (text: string): Line => ({ level: "PASS", text });
const fail = (text: string): Line => ({ level: "FAIL", text });

export type VaultReport = {
  lines: Line[];
  /** keccak256 of the code at the vault's address on chain, and of the compiled code with the slots filled in. */
  chainHash?: string;
  expectedHash?: string;
  codeBytes?: number;
  slotRows: Array<{ name: string; start: number; value: string }>;
};

export type Recorded = { vault?: string; vaultCodeHash?: string };

export function checkVault(facts: VaultFacts, compiled: Compiled, expectedChainId: number, recorded: Recorded = {}): VaultReport {
  const lines: Line[] = [];
  const slotRows: VaultReport["slotRows"] = [];
  const done = (extra: Partial<VaultReport> = {}): VaultReport => ({ lines, slotRows, ...extra });

  if (facts.chainId !== expectedChainId) {
    lines.push(fail(`the RPC is on chain ${facts.chainId}, not ${expectedChainId}`));
    return done();
  }
  lines.push(pass(`the RPC is on chain ${expectedChainId}`));
  if (!facts.routerHasCode) {
    lines.push(fail(`there is no contract at the router address ${facts.router} on this chain`));
    return done();
  }
  lines.push(pass(`there is a contract at the router ${facts.router}`));
  if (!facts.vault) {
    lines.push(fail("the router does not answer vault() with an address: this is not a Sluice router"));
    return done();
  }
  if (/^0x0{40}$/.test(facts.vault)) {
    lines.push(fail("the router's vault() is the zero address"));
    return done();
  }
  lines.push(pass(`the router's vault() is ${facts.vault}`));
  if (recorded.vault) {
    lines.push(sameAddress(recorded.vault, facts.vault) ? pass("that is the vault in deployment.json") : fail(`deployment.json names another vault: ${recorded.vault}`));
  }
  const code = facts.vaultCode;
  if (!code || code === "0x") {
    lines.push(fail(`there is no code at the vault address ${facts.vault}`));
    return done();
  }
  const codeBytes = (code.length - 2) / 2;
  lines.push(pass(`there is code at the vault: ${codeBytes.toLocaleString("en-US")} bytes`));
  lines.push(
    facts.vaultRouter && sameAddress(facts.vaultRouter, facts.router)
      ? pass("the vault's router() is this router")
      : fail(`the vault's router() is ${facts.vaultRouter ?? "not an address"}, not this router`),
  );

  lines.push(pass(`the repository compiled AgentVault with solc ${compiled.compilerVersion}, the optimizer on at ${compiled.optimizerRuns} runs, for the ${compiled.evmVersion} EVM`));
  const solc = embeddedSolc(code);
  lines.push(
    solc === EXPECTED.solc
      ? pass(`the compiler's own metadata at the end of the vault's code names solc ${solc}`)
      : fail(`the metadata at the end of the vault's code names solc ${solc ?? "(none readable)"}, not ${EXPECTED.solc}`),
  );

  const ctx: Context = { router: facts.router, vault: facts.vault, chainId: facts.chainId };
  const built = expectedCode(compiled, ctx);
  for (const slot of compiled.slots) slotRows.push({ name: slot.name, start: slot.start, value: built.values[slot.name] ?? "(not known to this check)" });
  if (built.unknown.length > 0) {
    lines.push(fail(`the compiled AgentVault has an immutable this check does not know a value for: ${built.unknown.join(", ")}. The check has to be updated with the contract`));
    return done({ codeBytes });
  }
  const names = [...new Set(compiled.slots.map((s) => s.name))];
  lines.push(pass(`the compiled AgentVault has ${names.length} immutables, in ${compiled.slots.length} places in its code (${names.join(", ")}), each filled in as the constructor fills it`));

  const chainHash = keccak256(code);
  const expectedHash = keccak256(built.code);
  if (chainHash === expectedHash) {
    lines.push(pass(`the code at the vault is the compiled AgentVault: both hash to ${chainHash}`));
  } else {
    lines.push(fail(`the code at the vault is not the compiled AgentVault: the chain's hashes to ${chainHash} and the compiled one to ${expectedHash}`));
    lines.push(...diagnose(code, built.code, compiled));
  }
  if (recorded.vaultCodeHash) {
    lines.push(
      recorded.vaultCodeHash.toLowerCase() === chainHash
        ? pass("that is also the code hash deployment.json recorded when the router was deployed")
        : fail(`deployment.json recorded another code hash for the vault: ${recorded.vaultCodeHash}`),
    );
  }
  return done({ chainHash, expectedHash, codeBytes });
}

const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Says where two codes of the same compiler output differ: in length, outside the immutable slots, or in which slot. */
function diagnose(onChain: string, expected: string, compiled: Compiled): Line[] {
  const a = getBytes(onChain);
  const b = getBytes(expected);
  if (a.length !== b.length) return [fail(`the code on chain is ${a.length} bytes, and the compiled code is ${b.length} bytes`)];
  const masked = (bytes: Uint8Array): string => {
    const copy = Uint8Array.from(bytes);
    for (const s of compiled.slots) copy.fill(0, s.start, s.start + s.length);
    return keccak256(copy);
  };
  const out: Line[] = [];
  if (masked(a) !== masked(b)) out.push(fail("the code outside the immutable slots differs from the compiled AgentVault"));
  for (const s of compiled.slots) {
    const x = hexlify(a.slice(s.start, s.start + s.length));
    const y = hexlify(b.slice(s.start, s.start + s.length));
    if (x !== y) out.push(fail(`the immutable ${s.name} at byte ${s.start} is ${x} on chain, and ${y} was expected`));
  }
  return out;
}

/** The settings a reader needs to build the vault again, and the slots to fill in, as text. */
export function reproductionLines(compiled: Compiled, report: VaultReport, ctx: Context): string[] {
  const lines = [
    "To build it again without trusting this program:",
    `  compiler        solc ${compiled.compilerVersion}`,
    `  optimizer       enabled, ${compiled.optimizerRuns} runs`,
    `  EVM version     ${compiled.evmVersion}`,
    `  contract        ${VAULT_SOURCE}:${VAULT_CONTRACT} (licence MIT)`,
    `  constructor     one argument, the router's address: ${word(getAddress(ctx.router))}`,
    "  source          the files in artifacts/verification/AgentVault.standard-input.json (pnpm live:verify --prepare-only writes it)",
    "  then            take the compiled runtime (deployed) bytecode, write each 32-byte slot below at its byte offset, and take keccak256 of the result",
    "  slots (byte offset in the runtime code, name, value):",
  ];
  for (const row of report.slotRows) lines.push(`    ${String(row.start).padStart(5)}  ${row.name.padEnd(17)} ${row.value}`);
  if (report.expectedHash) lines.push(`  the hash of the compiled code with those slots filled in: ${report.expectedHash}`);
  if (report.chainHash) lines.push(`  the hash of the code at the vault, from eth_getCode:      ${report.chainHash}`);
  return lines;
}

export function formatLines(lines: Line[]): string[] {
  return lines.map((l) => `${l.level}  ${l.text}`);
}

// Getting the router's source verified on the explorer, so that anyone can read what runs at its address. The vault is built the same way
// (buildInput works for any of the contracts), and its files are written for a reader to build it again; live:verify does not submit
// it. What QIE's explorer answered when it was submitted by hand is in docs/EXPLORER-VAULT-INVESTIGATION.md. Its code is checked,
// without the explorer, by src/vaultcheck.ts.
//
// Three parts, none of which holds a key or sends a transaction:
//   - buildInput: the standard JSON input the compiler used (from Hardhat's build info), cut down to the files the contract needs, with
//     the settings checked to be the documented ones: solc 0.8.24, the Shanghai EVM, the optimizer on at 200 runs;
//   - flatten: the same files as one source file, for explorers that take a single file (a manual fallback);
//   - submitVerification: a POST to the explorer's verifysourcecode endpoint (Blockscout, Etherscan-compatible), then polling its status.
//
// What the explorer does with a submission is the explorer's own matter. The tests run this against a stand-in that holds the endpoint's
// documented shape; submitVerification's POST was tried against the real explorer on 2026-11-26, for one contract
// (docs/EXPLORER-VAULT-INVESTIGATION.md). The manual route (docs/MAINNET-RUNBOOK.md) does not depend on this file's POST.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { AbiCoder, getAddress } from "ethers";
import { safeReaddir } from "./secret-paths";

export class VerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifyError";
  }
}

/** The compiler settings every contract here is built with, from hardhat.config.ts. */
export const EXPECTED = { solc: "0.8.24", longVersion: "0.8.24+commit.e11b9ed9", evmVersion: "shanghai", optimizerRuns: 200 } as const;

export type BuildInput = {
  /** `contracts/PaymentRouter.sol` */
  path: string;
  /** `PaymentRouter` */
  name: string;
  /** The standard JSON input: the files this contract needs, and the settings it was compiled with. */
  input: { language: string; sources: Record<string, { content: string }>; settings: Record<string, unknown> };
  /** `v0.8.24+commit.e11b9ed9`, the way an explorer writes it. */
  compilerVersion: string;
  /** The creation bytecode the compiler produced (before constructor arguments). */
  creationBytecode: string;
};

type BuildInfo = {
  solcVersion: string;
  solcLongVersion: string;
  input: { language: string; sources: Record<string, { content: string }>; settings: Record<string, unknown> & { evmVersion?: string; optimizer?: { enabled?: boolean; runs?: number } } };
  output: { contracts: Record<string, Record<string, { metadata?: string; evm?: { bytecode?: { object?: string } } }>> };
};

/** Reads the build info that compiled `path:name`, checks the settings, and cuts the input down to the files that contract uses. */
export function buildInput(root: string, path: string, name: string): BuildInput {
  const dir = join(root, "artifacts", "build-info");
  if (!existsSync(dir)) throw new VerifyError("there is no artifacts/build-info: run pnpm compile first");
  const candidates = safeReaddir(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ file: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const { file } of candidates) {
    const info = JSON.parse(readFileSync(file, "utf8")) as BuildInfo;
    const built = info.output.contracts[path]?.[name];
    if (!built?.metadata) continue;
    const settings = info.input.settings;
    if (info.solcVersion !== EXPECTED.solc || info.solcLongVersion !== EXPECTED.longVersion) {
      throw new VerifyError(`the contract was compiled with solc ${info.solcLongVersion}, not the documented ${EXPECTED.longVersion}`);
    }
    if (settings.evmVersion !== EXPECTED.evmVersion) throw new VerifyError(`the contract was compiled for the ${String(settings.evmVersion)} EVM, not ${EXPECTED.evmVersion}`);
    if (settings.optimizer?.enabled !== true || settings.optimizer.runs !== EXPECTED.optimizerRuns) {
      throw new VerifyError(`the optimizer settings are not the documented ones (on, ${EXPECTED.optimizerRuns} runs)`);
    }
    // The compiler's own metadata lists exactly the sources the contract was built from.
    const used = Object.keys((JSON.parse(built.metadata) as { sources: Record<string, unknown> }).sources);
    const sources: Record<string, { content: string }> = {};
    for (const source of used) {
      const entry = info.input.sources[source];
      if (!entry) throw new VerifyError(`the build info has no source for ${source}`);
      sources[source] = { content: entry.content };
    }
    const bytecode = built.evm?.bytecode?.object;
    if (!bytecode) throw new VerifyError("the build info has no creation bytecode for the contract");
    return {
      path,
      name,
      input: { language: info.input.language, sources, settings },
      compilerVersion: `v${info.solcLongVersion}`,
      creationBytecode: `0x${bytecode}`,
    };
  }
  throw new VerifyError(`no build info holds ${path}:${name}: run pnpm compile first`);
}

/** The constructor arguments of a deployment, as hex without 0x: what follows the compiled creation bytecode in the deployment's data. */
export function constructorArguments(deploymentData: string, creationBytecode: string): string {
  const data = deploymentData.toLowerCase();
  const code = creationBytecode.toLowerCase();
  if (!data.startsWith(code)) throw new VerifyError("the deployment's data does not start with the compiled creation code, so it was not built from this source");
  return data.slice(code.length);
}

/** The vault's constructor takes the router's address, which is all there is to it. */
export function vaultConstructorArguments(router: string): string {
  return AbiCoder.defaultAbiCoder().encode(["address"], [getAddress(router)]).slice(2);
}

// --------------------------------------------------------------------------------------------------------------- flatten

/** One file with every dependency before the file that needs it: a single source for an explorer that takes one. */
export function flatten(sources: Record<string, { content: string }>, entry: string): string {
  const order: string[] = [];
  const seen = new Set<string>();
  const importPattern = /^\s*import\s+[^;]*?["']([^"']+)["'][^;]*;\s*$/;
  const visit = (file: string, from?: string): void => {
    const key = from && file.startsWith(".") ? posix.normalize(posix.join(posix.dirname(from), file)) : file;
    if (seen.has(key)) return;
    seen.add(key);
    const source = sources[key];
    if (!source) throw new VerifyError(`a source is missing: ${key}`);
    for (const line of source.content.split("\n")) {
      const m = importPattern.exec(line);
      if (m) visit(m[1] as string, key);
      else if (/^\s*import\b/.test(line)) throw new VerifyError(`an import in ${key} is written in a way the flattener does not read`);
    }
    order.push(key);
  };
  visit(entry);
  const parts: string[] = [];
  let licence = false;
  let pragma = false;
  for (const file of order) {
    const lines = (sources[file] as { content: string }).content.split("\n").filter((l) => !importPattern.test(l));
    const kept = lines.filter((l) => {
      if (/^\s*\/\/\s*SPDX-License-Identifier:/.test(l)) {
        if (licence) return false;
        licence = true;
      }
      if (/^\s*pragma\s+solidity\b/.test(l)) {
        if (pragma) return false;
        pragma = true;
      }
      return true;
    });
    parts.push(`// ----- ${file} -----`, ...kept);
  }
  return `${parts.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

// --------------------------------------------------------------------------------------------------------------- submission

export type SubmitRequest = {
  /** The explorer's address, like https://mainnet.qie.digital. */
  base: string;
  address: string;
  build: BuildInput;
  constructorArgs: string;
};

export type SubmitResult =
  | { state: "verified"; detail: string }
  | { state: "already"; detail: string }
  | { state: "failed"; detail: string }
  | { state: "unreachable"; detail: string };

export type SubmitOptions = {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** How many times to ask for the status, and the pause between asks. */
  polls?: number;
  pollMs?: number;
  /** How many times a request that gets a 5xx answer is tried again, and the first pause (it doubles). */
  retries?: number;
  retryMs?: number;
};

const REPLY_LIMIT = 200_000;

async function send(url: URL, init: RequestInit, o: Required<Pick<SubmitOptions, "fetchImpl" | "sleep" | "retries" | "retryMs">>): Promise<{ status: number; json: unknown } | undefined> {
  let pause = o.retryMs;
  for (let attempt = 0; attempt <= o.retries; attempt++) {
    try {
      const res = await o.fetchImpl(url, { ...init, signal: AbortSignal.timeout(30_000) });
      const text = (await res.text()).slice(0, REPLY_LIMIT);
      if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: res.status, json };
    } catch {
      if (attempt === o.retries) return undefined;
      await o.sleep(pause);
      pause *= 2;
    }
  }
  return undefined;
}

/**
 * POSTs the source to /api?module=contract&action=verifysourcecode, then asks /api?module=contract&action=checkverifystatus until the
 * explorer says it is done. A 502 (the explorer answers that at times) is retried with a growing pause; after the last try the result is
 * "unreachable", which tells the caller to use the manual route. The explorer's answer is read, never trusted blindly: only a result that
 * says verified counts, and the caller confirms with a separate read of the explorer.
 */
export async function submitVerification(req: SubmitRequest, options: SubmitOptions = {}): Promise<SubmitResult> {
  const root = new URL(req.base);
  if (root.protocol !== "https:" && root.hostname !== "127.0.0.1" && root.hostname !== "localhost") throw new VerifyError("the explorer URL must be https");
  const o = { fetchImpl: options.fetchImpl ?? fetch, sleep: options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))), retries: options.retries ?? 4, retryMs: options.retryMs ?? 2_000 };
  const polls = options.polls ?? 12;
  const pollMs = options.pollMs ?? 5_000;
  const address = getAddress(req.address);
  const form = new URLSearchParams({
    module: "contract",
    action: "verifysourcecode",
    codeformat: "solidity-standard-json-input",
    contractaddress: address,
    addressHash: address,
    contractname: `${req.build.path}:${req.build.name}`,
    compilerversion: req.build.compilerVersion,
    sourceCode: JSON.stringify(req.build.input),
    constructorArguements: req.constructorArgs,
    constructorArguments: req.constructorArgs,
    optimizationUsed: "1",
    runs: String(EXPECTED.optimizerRuns),
    evmversion: EXPECTED.evmVersion,
  });
  const posted = await send(new URL("/api?module=contract&action=verifysourcecode", root), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() }, o);
  if (!posted) return { state: "unreachable", detail: "the explorer did not answer the submission (it may be returning 502); use the manual steps" };
  const body = posted.json as { status?: string; message?: string; result?: unknown } | null;
  const result = typeof body?.result === "string" ? body.result : "";
  if (/already verified/i.test(result) || /already verified/i.test(String(body?.message ?? ""))) return { state: "already", detail: "the explorer says the contract is already verified" };
  if (posted.status !== 200 || body?.status !== "1" || !result) return { state: "failed", detail: `the explorer refused the submission: ${String(body?.message ?? posted.status).slice(0, 120)}` };

  // `result` is a ticket to ask about.
  const guid = result;
  for (let i = 0; i < polls; i++) {
    await o.sleep(pollMs);
    const status = await send(new URL(`/api?module=contract&action=checkverifystatus&guid=${encodeURIComponent(guid)}`, root), { method: "GET", headers: { accept: "application/json" } }, o);
    if (!status) return { state: "unreachable", detail: "the explorer stopped answering while the verification was running; check the contract's page later" };
    const s = status.json as { result?: unknown } | null;
    const text = typeof s?.result === "string" ? s.result : "";
    if (/^pass/i.test(text) || /verified/i.test(text) && !/fail|not verified|unable/i.test(text)) return { state: /already/i.test(text) ? "already" : "verified", detail: text.slice(0, 120) };
    if (/fail|unable|error/i.test(text)) return { state: "failed", detail: `the explorer could not verify it: ${text.slice(0, 160)}` };
    // anything else (pending, in the queue) means ask again
  }
  return { state: "unreachable", detail: "the explorer had not finished after the polling time; check the contract's page later" };
}

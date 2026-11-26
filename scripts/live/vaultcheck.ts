// pnpm live:vaultcheck: is the code at the router's vault the compiled AgentVault of this repository?
//
//   SLUICE_NETWORK=mainnet pnpm live:vaultcheck                        (the router comes from deployment.json in this folder)
//   SLUICE_NETWORK=mainnet pnpm live:vaultcheck --router 0x...         (any router: its address is in docs/EVIDENCE.md)
//
// The vault is created by the router's constructor. This check needs no explorer, and it covers what a source match of running code
// does not: the values the constructor wrote. It reads the vault's address from the router, reads the code at that address, builds the code the compiler produced
// for AgentVault with every immutable slot filled in as the constructor fills it, and compares the two by hash. It then prints the
// settings (compiler, optimizer, EVM version) and the slots a reader needs to do the same thing without this program.
//
// Read-only: eth_chainId, eth_getBlockByNumber, eth_call and eth_getCode, and nothing else. It holds no key and sends no transaction.
// It needs the compiled contracts (pnpm compile), because they are what the chain's code is compared with.
//
//   --router   the router whose vault to check. Left out: SLUICE_ROUTER, then the router in deployment.json in this folder.
//
// SLUICE_NETWORK is mainnet or testnet (no default). SLUICE_RPC_URL names one endpoint; left out, QIE's five endpoints are probed in turn.
// Exit code 0: the vault's code is the compiled AgentVault. 1: it is not, or something about it is wrong. 2: the command was wrong, the
// contracts are not compiled, or the chain could not be read.
import { exitWith } from "../../src/exit";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress } from "ethers";
import { NoHealthyEndpoint, describeSelection, orderedUrls, resolveEndpoint } from "@sluice/sdk";
import { NETWORKS, NetworkError } from "../../src/evidence";
import type { Rpc } from "../../src/evidence";
import { RpcRefused, readOnlyRpc } from "../../src/readrpc";
import { VerifyError } from "../../src/verify-contracts";
import { VAULTCHECK_READ_ONLY_METHODS, checkVault, formatLines, readCompiled, readVaultFacts, reproductionLines } from "../../src/vaultcheck";
import type { Recorded } from "../../src/vaultcheck";

export type Env = Record<string, string | undefined>;
export type VaultIo = {
  log?: (line: string) => void;
  /** Where the repository is: its artifacts/ folder. */
  root?: string;
  /** The folder deployment.json is looked for in. Left out, the folder the program was run from. */
  cwd?: string;
  /** A reader of the chain given by a test. */
  rpc?: Rpc;
  fetchImpl?: typeof fetch;
};

class UsageError extends Error {}

function parseArgs(argv: string[]): { router?: string } {
  const out: { router?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string;
    if (flag !== "--router") throw new UsageError(`unknown option ${flag.slice(0, 40)} (the option is --router)`);
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new UsageError("--router needs a value");
    if (out.router !== undefined) throw new UsageError("--router was given twice");
    out.router = value;
  }
  return out;
}

/** The router to check: --router, else SLUICE_ROUTER, else deployment.json in this folder. Where it came from is said in the output. */
function routerToCheck(args: { router?: string }, env: Env, cwd: string): { router: string; source: string; recorded: Recorded } {
  const given = args.router ?? env.SLUICE_ROUTER?.trim();
  let record: { router?: unknown; vault?: unknown; vaultCodeHash?: unknown } | undefined;
  try {
    record = JSON.parse(readFileSync(join(cwd, "deployment.json"), "utf8")) as typeof record;
  } catch {
    record = undefined;
  }
  const text = given ?? (typeof record?.router === "string" ? record.router : undefined);
  if (!text) throw new UsageError("no router: give --router, set SLUICE_ROUTER, or run this where deployment.json is");
  let router: string;
  try {
    router = getAddress(text);
  } catch {
    throw new UsageError(`${args.router ? "--router" : given ? "SLUICE_ROUTER" : "the router in deployment.json"} is not an address`);
  }
  // The deployment record's own vault and code hash are compared only when it is the record of this router.
  const recorded: Recorded = {};
  if (record && typeof record.router === "string" && record.router.toLowerCase() === router.toLowerCase()) {
    if (typeof record.vault === "string") recorded.vault = record.vault;
    if (typeof record.vaultCodeHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(record.vaultCodeHash)) recorded.vaultCodeHash = record.vaultCodeHash;
  }
  return { router, source: args.router ? "--router" : given ? "SLUICE_ROUTER" : "deployment.json", recorded };
}

export async function main(argv: string[], env: Env = process.env, io: VaultIo = {}): Promise<number> {
  const log = io.log ?? console.log;
  const root = io.root ?? join(__dirname, "..", "..");
  try {
    const args = parseArgs(argv);
    const network = env.SLUICE_NETWORK?.trim();
    if (network !== "mainnet" && network !== "testnet") throw new UsageError("set SLUICE_NETWORK to mainnet or testnet");
    const chainId = NETWORKS[network].chainId;
    const target = routerToCheck(args, env, io.cwd ?? process.cwd());
    const compiled = readCompiled(root);

    let rpc = io.rpc;
    if (!rpc) {
      const sel = await resolveEndpoint(network, env.SLUICE_RPC_URL, { fetchImpl: io.fetchImpl });
      log(describeSelection(sel));
      rpc = readOnlyRpc(orderedUrls(sel), VAULTCHECK_READ_ONLY_METHODS, io.fetchImpl ?? fetch);
    }
    const facts = await readVaultFacts(rpc, target.router);
    const report = checkVault(facts, compiled, chainId, target.recorded);

    log(`Vault check on ${network} (chain ${facts.chainId}), read at block ${facts.block}, ${new Date(facts.timestamp * 1000).toISOString().replace(".000Z", "Z")} UTC. Read-only: eth_chainId, eth_getBlockByNumber, eth_call and eth_getCode.`);
    log(`router ${target.router} (${target.source})`);
    for (const l of formatLines(report.lines)) log(l);
    const failed = report.lines.filter((l) => l.level === "FAIL").length;
    log(`vaultcheck: ${report.lines.length - failed} passed, ${failed} failed`);
    if (facts.vault && report.slotRows.length > 0) {
      log("");
      for (const l of reproductionLines(compiled, report, { router: facts.router, vault: facts.vault, chainId: facts.chainId })) log(l);
    }
    log("");
    log("What this check is: a comparison of the code on the chain with this repository's build, with the values the constructor wrote into it, read over RPC with no explorer. What an explorer shows for the vault's page is a separate matter: see docs/EXPLORER-VAULT-INVESTIGATION.md.");
    return failed > 0 ? 1 : 0;
  } catch (err) {
    if (err instanceof UsageError || err instanceof VerifyError) {
      log(`refused: ${err.message}`);
      return 2;
    }
    if (err instanceof NetworkError || err instanceof RpcRefused || err instanceof NoHealthyEndpoint) {
      log("the chain could not be read, so nothing was checked. A result is never guessed.");
      return 2;
    }
    log("the vault check failed to run.");
    return 2;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => exitWith(code),
    () => {
      console.error("live:vaultcheck failed");
      exitWith(2);
    },
  );
}

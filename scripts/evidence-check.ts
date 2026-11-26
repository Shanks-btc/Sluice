// pnpm evidence:check [--hash 0x...] [--file <copy of the evidence file> [--fork]]
//
// --file reads a copy of the evidence file instead of docs/EVIDENCE.md. With --fork it reads the rows a run on a local copy of the chain
// recorded in that copy (labelled fork, never counted as evidence), and checks them against the node EVIDENCE_RPC_URL names, which must be
// on this machine. That is how the mainnet dry run (pnpm mainnet:dryrun) proves the same command works before it is run on mainnet.
//
// Reads docs/EVIDENCE.md and checks every row against QIE's public RPC (rpc1 to rpc5, in turn) with read-only methods. A row with a claim
// is checked by the same code that recorded it, so the chain must still show what the claim says. The explorer is asked only for a
// verify-link row, because "verified" is something only the explorer says. With --hash, only the rows for that transaction are checked.
//
// Exit code 0: every row passed (or there are no rows). 1: a row failed. 2: nothing failed but a network problem meant some rows
// could not be checked, which is never reported as a pass.
import { exitWith } from "../src/exit";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { exitCodeFor, parseEvidenceStrict } from "../src/evidence";
import type { EvidenceRow, Summary } from "../src/evidence";
import { checkClaimRow, explorerVerifiedFor, parseForkRows, publicRpcUrls, recorderRpc } from "../src/recorder";
import type { ClaimDeps } from "../src/recorder";
import { QIE_CHAIN_ID, describeSelection, orderedUrls, selectEndpoint } from "@sluice/sdk";

export type Env = Record<string, string | undefined>;

export async function main(argv: string[] = process.argv.slice(2), env: Env = process.env, log: (line: string) => void = console.log, evidencePath?: string, deps?: Partial<ClaimDeps> & { fetchImpl?: typeof fetch }): Promise<number> {
  const i = argv.indexOf("--hash");
  const only = i >= 0 ? argv[i + 1]?.toLowerCase() : undefined;
  if (i >= 0 && !(only && /^0x[0-9a-f]{64}$/.test(only))) {
    log("--hash needs a transaction hash.");
    return 1;
  }
  // --file reads another evidence file, a copy. --fork reads the rows a run on a local copy of the chain recorded in it (they are labelled
  // fork, are never counted as evidence of anything, and are checked only against a node on this machine). Neither is for docs/EVIDENCE.md.
  const fileIndex = argv.indexOf("--file");
  const fileArg = fileIndex >= 0 ? argv[fileIndex + 1] : undefined;
  const fork = argv.includes("--fork");
  const realPath = join(__dirname, "..", "docs", "EVIDENCE.md");
  if (fileIndex >= 0 && !(fileArg && !fileArg.startsWith("--"))) {
    log("--file needs the path of an evidence file.");
    return 1;
  }
  if (fork && !fileArg) {
    log("--fork needs --file: a fork run is checked against a copy of the evidence file, never docs/EVIDENCE.md.");
    return 1;
  }
  if (fork && fileArg && resolve(fileArg) === resolve(realPath)) {
    log("--fork reads fork rows, which are never written to docs/EVIDENCE.md: give a copy.");
    return 1;
  }
  let rows: EvidenceRow[];
  try {
    const text = readFileSync(evidencePath ?? fileArg ?? realPath, "utf8");
    rows = fork ? (parseForkRows(text) as unknown as EvidenceRow[]) : parseEvidenceStrict(text);
  } catch (err) {
    log(err instanceof Error ? err.message : "docs/EVIDENCE.md could not be read");
    return 1;
  }
  if (fork) {
    const local = env.EVIDENCE_RPC_URL?.trim();
    if (!local || !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(local)) {
      log("fork rows are checked only against a node on this machine: set EVIDENCE_RPC_URL to its address (http://127.0.0.1:port).");
      return 1;
    }
  }
  const selected = only ? rows.filter((r) => r.hash.toLowerCase() === only) : rows;
  if (only && selected.length === 0) {
    log(`No row in docs/EVIDENCE.md has the transaction ${only}.`);
    return 1;
  }
  const override = env.EVIDENCE_RPC_URL?.trim();
  const summary: Summary = { pass: 0, fail: 0, skipped: 0, lines: [] };
  // One probe of QIE's endpoints per network per run: the first that answers with the right chain id, the rest as fallbacks for reads.
  const chosen = new Map<string, string[]>();
  const urlsFor = async (network: "mainnet" | "testnet"): Promise<string[]> => {
    const known = chosen.get(network);
    if (known) return known;
    let urls: string[];
    if (override) {
      urls = [override];
      log(describeSelection({ url: override, fallbacks: [], probes: [], overridden: true }));
    } else {
      try {
        const sel = await selectEndpoint(publicRpcUrls(network), QIE_CHAIN_ID[network], { fetchImpl: deps?.fetchImpl });
        log(`${network}: ${describeSelection(sel)}`);
        urls = orderedUrls(sel);
      } catch {
        log(`${network}: no RPC endpoint answered with the right chain id, so its rows cannot be checked`);
        urls = publicRpcUrls(network); // each row is then reported as skipped, never as passed
      }
    }
    chosen.set(network, urls);
    return urls;
  };
  for (const row of selected) {
    const rpc = deps?.rpc ?? recorderRpc(fork ? [override as string] : await urlsFor(row.network), deps?.fetchImpl);
    const explorerBase = env.SLUICE_EXPLORER_URL?.trim() || (row.network === "mainnet" ? "https://mainnet.qie.digital" : undefined);
    const explorerVerified = deps?.explorerVerified ?? (explorerBase ? explorerVerifiedFor(explorerBase) : async () => false);
    const result = await checkClaimRow(row, { rpc, explorerVerified, compiledRouterCode: deps?.compiledRouterCode });
    if (result.status === "PASS") summary.pass += 1;
    else if (result.status === "FAIL") summary.fail += 1;
    else summary.skipped += 1;
    summary.lines.push(`${result.status.padEnd(7)} ${row.network} ${row.event} ${row.hash} ${result.detail}`);
  }
  for (const line of summary.lines) log(line);
  log(`evidence:check ${selected.length} row(s): ${summary.pass} passed, ${summary.fail} failed, ${summary.skipped} skipped`);
  if (selected.length === 0) log("There are no evidence rows yet, so nothing is claimed as live.");
  return exitCodeFor(summary);
}

if (require.main === module) {
  main().then(
    (code) => exitWith(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : "evidence:check failed");
      exitWith(1);
    },
  );
}

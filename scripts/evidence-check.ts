// pnpm evidence:check [--hash 0x...]
//
// Reads docs/EVIDENCE.md and checks every row against QIE's public RPC (rpc1 to rpc5, in turn) with read-only methods. A row with a claim
// is checked by the same code that recorded it, so the chain must still show what the claim says. The explorer is asked only for a
// verify-link row, because "verified" is something only the explorer says. With --hash, only the rows for that transaction are checked.
//
// Exit code 0: every row passed (or there are no rows). 1: a row failed. 2: nothing failed but a network problem meant some rows
// could not be checked, which is never reported as a pass.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { exitCodeFor, parseEvidenceStrict } from "../src/evidence";
import type { EvidenceRow, Summary } from "../src/evidence";
import { checkClaimRow, explorerVerifiedFor, publicRpcUrls, recorderRpc } from "../src/recorder";
import type { ClaimDeps } from "../src/recorder";

export type Env = Record<string, string | undefined>;

export async function main(argv: string[] = process.argv.slice(2), env: Env = process.env, log: (line: string) => void = console.log, evidencePath?: string, deps?: Partial<ClaimDeps>): Promise<number> {
  const i = argv.indexOf("--hash");
  const only = i >= 0 ? argv[i + 1]?.toLowerCase() : undefined;
  if (i >= 0 && !(only && /^0x[0-9a-f]{64}$/.test(only))) {
    log("--hash needs a transaction hash.");
    return 1;
  }
  let rows: EvidenceRow[];
  try {
    rows = parseEvidenceStrict(readFileSync(evidencePath ?? join(__dirname, "..", "docs", "EVIDENCE.md"), "utf8"));
  } catch (err) {
    log(err instanceof Error ? err.message : "docs/EVIDENCE.md could not be read");
    return 1;
  }
  const selected = only ? rows.filter((r) => r.hash.toLowerCase() === only) : rows;
  if (only && selected.length === 0) {
    log(`No row in docs/EVIDENCE.md has the transaction ${only}.`);
    return 1;
  }
  const override = env.EVIDENCE_RPC_URL?.trim();
  const summary: Summary = { pass: 0, fail: 0, skipped: 0, lines: [] };
  for (const row of selected) {
    const rpc = deps?.rpc ?? recorderRpc(override ? [override] : publicRpcUrls(row.network));
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
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : "evidence:check failed");
      process.exit(1);
    },
  );
}

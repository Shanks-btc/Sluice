// pnpm evidence:summary
//
// Counts paid calls from the router's Settled events, leaves out the founder wallets on docs/founder-wallets.json, and
// prints the counts of paid calls, distinct payers and distinct builders. Read-only: three RPC methods, no key, no spend.
//
//   SLUICE_ROUTER=0x... SLUICE_FROM_BLOCK=<the block the router was deployed at> pnpm evidence:summary
//
// Environment: SLUICE_ROUTER (required), SLUICE_FROM_BLOCK (required: where to start reading), SLUICE_NETWORK (mainnet or
// testnet, default mainnet), EVIDENCE_RPC_URL (optional RPC override, which may be a local node).
import { exitWith } from "../src/exit";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describeSelection, orderedUrls, resolveEndpoint } from "@sluice/sdk";
import { parseEvidenceStrict } from "../src/evidence";
import { countByClaim, parseClaimCell, parseForkRows } from "../src/recorder";
import { FOUNDER_LIST_PATH, FounderListError, formatSummary, parseFounderList, scanSettled, summarize, summaryRpcMany } from "../src/summary";
import type { SummaryRpc } from "../src/summary";
import type { Network } from "../src/evidence";

export type Env = Record<string, string | undefined>;

/** The per-claim counts of the rows recorded in docs/EVIDENCE.md: mainnet rows only, founder wallets left out of the distinct counts. */
function recordedLines(evidenceText: string, listText: string): string[] {
  const list = parseFounderList(JSON.parse(listText));
  const founders = new Set(list.wallets.map((w) => w.address.toLowerCase()));
  const rows = parseEvidenceStrict(evidenceText);
  const lines = [`recorded evidence, from docs/EVIDENCE.md (mainnet rows only; founder list version ${list.version}):`];
  for (const c of countByClaim(rows, founders)) {
    if (c.claim === "unclassified" && c.rows === 0 && c.excluded === 0) continue;
    lines.push(`  ${c.claim.padEnd(22)} rows ${c.rows}, distinct addresses ${c.distinct}${c.excluded ? `, left out as founder wallets ${c.excluded}` : ""}`);
  }
  return lines;
}

/** The per-claim counts of the rows a fork run recorded in a copy of the evidence file. They are labelled fork and are never counted as proof. */
function forkLines(evidenceText: string): string[] {
  const rows = parseForkRows(evidenceText);
  const lines = [`recorded fork rows, from the copy of the evidence file (a local copy of the chain; none of this is evidence of anything on mainnet): ${rows.length} row(s)`];
  const groups = new Map<string, { rows: number; who: Set<string> }>();
  for (const r of rows) {
    const type = parseClaimCell(r.claim ?? "")?.claim ?? "unclassified";
    const g = groups.get(type) ?? { rows: 0, who: new Set<string>() };
    g.rows += 1;
    g.who.add(r.who.toLowerCase());
    groups.set(type, g);
  }
  for (const [type, g] of [...groups].sort(([a], [b]) => a.localeCompare(b))) lines.push(`  ${type.padEnd(22)} rows ${g.rows}, distinct addresses ${g.who.size}`);
  return lines;
}

export async function main(env: Env = process.env, log: (line: string) => void = console.log, rpcOverride?: SummaryRpc, listText?: string, evidenceText?: string, argv: string[] = []): Promise<number> {
  // --file <copy> --fork: count a fork run's rows from a copy of the evidence file, and scan the node EVIDENCE_RPC_URL names, which must be on
  // this machine. Nothing is read from docs/EVIDENCE.md and nothing is ever counted as evidence.
  const fileIndex = argv.indexOf("--file");
  const fork = argv.includes("--fork");
  if (fileIndex >= 0 && !(argv[fileIndex + 1] && !argv[fileIndex + 1]?.startsWith("--"))) {
    log("--file needs the path of an evidence file.");
    return 1;
  }
  if (fork && fileIndex < 0) {
    log("--fork needs --file: a fork run is counted from a copy of the evidence file.");
    return 1;
  }
  if (fork && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(env.EVIDENCE_RPC_URL?.trim() ?? "")) {
    log("a fork run is scanned only on a node on this machine: set EVIDENCE_RPC_URL to its address (http://127.0.0.1:port).");
    return 1;
  }
  const code = await count(env, log, rpcOverride, listText);
  if (code !== 0 && code !== undefined) return code;
  try {
    const list = listText ?? readFileSync(join(__dirname, "..", FOUNDER_LIST_PATH), "utf8");
    if (fork) {
      for (const line of forkLines(evidenceText ?? readFileSync(argv[fileIndex + 1] as string, "utf8"))) log(line);
      return 0;
    }
    const evidence = evidenceText ?? (fileIndex >= 0 ? readFileSync(argv[fileIndex + 1] as string, "utf8") : readFileSync(join(__dirname, "..", "docs", "EVIDENCE.md"), "utf8"));
    for (const line of recordedLines(evidence, list)) log(line);
  } catch (err) {
    log(err instanceof FounderListError || err instanceof Error ? `The recorded evidence could not be counted: ${err.message}` : "The recorded evidence could not be counted.");
    return 1;
  }
  return 0;
}

async function count(env: Env, log: (line: string) => void, rpcOverride?: SummaryRpc, listText?: string): Promise<number> {
  const router = env.SLUICE_ROUTER?.trim();
  if (!router) {
    log("No router is configured (SLUICE_ROUTER), so nothing is counted. Nothing is claimed.");
    return 0;
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(router)) {
    log("SLUICE_ROUTER is not an address.");
    return 1;
  }
  const from = Number(env.SLUICE_FROM_BLOCK?.trim());
  if (!Number.isInteger(from) || from < 0) {
    log("Set SLUICE_FROM_BLOCK to the block the router was deployed at, so the count starts where it should.");
    return 1;
  }
  const network = (env.SLUICE_NETWORK?.trim() || "mainnet") as Network;
  if (network !== "mainnet" && network !== "testnet") {
    log("SLUICE_NETWORK must be mainnet or testnet.");
    return 1;
  }
  let list;
  try {
    list = parseFounderList(JSON.parse(listText ?? readFileSync(join(__dirname, "..", FOUNDER_LIST_PATH), "utf8")));
  } catch (err) {
    log(err instanceof FounderListError ? err.message : "The founder list could not be read.");
    return 1;
  }
  let rpc = rpcOverride;
  if (!rpc) {
    // QIE's endpoints are probed, the first healthy one is used, and the others are tried when it fails. EVIDENCE_RPC_URL names one and is used as given.
    try {
      const sel = await resolveEndpoint(network, env.EVIDENCE_RPC_URL);
      log(describeSelection(sel));
      rpc = summaryRpcMany(orderedUrls(sel));
    } catch {
      log("No RPC endpoint answered with the right chain id, so no count is given. A count is never guessed.");
      return 2;
    }
  }
  let scan;
  try {
    scan = await scanSettled(rpc, router, from);
  } catch {
    log("The chain could not be read, so no count is given. A count is never guessed.");
    return 2;
  }
  for (const line of formatSummary(summarize(scan.events, list), scan, router)) log(line);
  return 0;
}

if (require.main === module) {
  main(process.env, console.log, undefined, undefined, undefined, process.argv.slice(2)).then(
    (code) => exitWith(code),
    () => {
      console.error("evidence:summary failed");
      exitWith(1);
    },
  );
}

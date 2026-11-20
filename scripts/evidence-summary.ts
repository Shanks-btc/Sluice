// pnpm evidence:summary
//
// Counts paid calls from the router's Settled events, leaves out the founder wallets on docs/founder-wallets.json, and
// prints the counts of paid calls, distinct payers and distinct builders. Read-only: three RPC methods, no key, no spend.
//
//   SLUICE_ROUTER=0x... SLUICE_FROM_BLOCK=<the block the router was deployed at> pnpm evidence:summary
//
// Environment: SLUICE_ROUTER (required), SLUICE_FROM_BLOCK (required: where to start reading), SLUICE_NETWORK (mainnet or
// testnet, default mainnet), EVIDENCE_RPC_URL (optional RPC override, which may be a local node).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEvidenceStrict } from "../src/evidence";
import { countByClaim } from "../src/recorder";
import { FOUNDER_LIST_PATH, FounderListError, formatSummary, parseFounderList, rpcUrlFor, scanSettled, summarize, summaryRpc } from "../src/summary";
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

export async function main(env: Env = process.env, log: (line: string) => void = console.log, rpcOverride?: SummaryRpc, listText?: string, evidenceText?: string): Promise<number> {
  const code = await count(env, log, rpcOverride, listText);
  if (code !== 0 && code !== undefined) return code;
  try {
    const list = listText ?? readFileSync(join(__dirname, "..", FOUNDER_LIST_PATH), "utf8");
    const evidence = evidenceText ?? readFileSync(join(__dirname, "..", "docs", "EVIDENCE.md"), "utf8");
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
  const rpc = rpcOverride ?? summaryRpc(rpcUrlFor(network, env.EVIDENCE_RPC_URL));
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
  main().then(
    (code) => process.exit(code),
    () => {
      console.error("evidence:summary failed");
      process.exit(1);
    },
  );
}

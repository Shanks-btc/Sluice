// The Evidence page's paid-call counts: the same logic as `pnpm evidence:summary`, run on the server against the configured router.
// It counts Settled events, leaves out the founder wallets on the published list, and reports distinct payers and builders.
//
// Honesty rules: with no router configured it says so and shows no numbers; if the chain cannot be read it says that, and never
// shows zero in its place. Read-only: eth_blockNumber and eth_getLogs only.
import { parseFounderList, scanSettled, summarize, summaryRpc } from "../../../../src/summary";
import type { FounderList, Summary } from "../../../../src/summary";
import { parseWebUrl } from "./config";
import type { AppConfig } from "./config";

export type SummaryAnswer =
  | { state: "not_configured"; reason: string }
  | { state: "unavailable"; reason: string }
  | {
      state: "ok";
      router: string;
      listVersion: number;
      founderWallets: number;
      fromBlock: number;
      toBlock: number;
      settledEvents: number;
      excluded: number;
      paidCalls: number;
      distinctPayers: number;
      distinctBuilders: number;
      amountUnits: string;
    };

export type SummaryDeps = {
  config: AppConfig;
  founderListRaw: unknown;
  rpcUrl?: string;
  fromBlock?: number | null;
  fetchImpl?: typeof fetch;
  /** The most blocks one request will scan. A longer history needs the command-line tool. */
  maxBlocks?: number;
};

export const DEFAULT_MAX_BLOCKS = 400_000;

export async function computeSummary(deps: SummaryDeps): Promise<SummaryAnswer> {
  const { config } = deps;
  if (!config.router) return { state: "not_configured", reason: "No router is configured, so there is nothing to count." };
  const from = deps.fromBlock ?? config.fromBlock;
  if (from === null || from === undefined) {
    return { state: "not_configured", reason: "The block the router was deployed at is not set, so the count cannot say where to start." };
  }
  let list: FounderList;
  try {
    list = parseFounderList(deps.founderListRaw);
  } catch {
    return { state: "unavailable", reason: "The founder wallet list could not be read, so no count is shown." };
  }
  const rpc = summaryRpc(deps.rpcUrl ?? config.rpcUrl, deps.fetchImpl);
  try {
    const latest = Number(BigInt((await rpc("eth_blockNumber", [])) as string));
    if (latest - from > (deps.maxBlocks ?? DEFAULT_MAX_BLOCKS)) {
      return { state: "unavailable", reason: "The router's history is longer than this page scans. Run pnpm evidence:summary for the count." };
    }
    const scan = await scanSettled(rpc, config.router, from, latest);
    const s: Summary = summarize(scan.events, list);
    return {
      state: "ok",
      router: config.router,
      listVersion: s.listVersion,
      founderWallets: s.founderWallets,
      fromBlock: scan.fromBlock,
      toBlock: scan.toBlock,
      settledEvents: s.settledEvents,
      excluded: s.excluded,
      paidCalls: s.paidCalls,
      distinctPayers: s.distinctPayers,
      distinctBuilders: s.distinctBuilders,
      amountUnits: s.amountUnits.toString(),
    };
  } catch {
    return { state: "unavailable", reason: "The chain could not be read just now, so no count is shown." };
  }
}

/** Keeps an answer for a short while so every visitor does not trigger a scan. */
export function cached<T>(ttlMs: number, now: () => number = Date.now): (load: () => Promise<T>) => Promise<T> {
  let value: { at: number; data: Promise<T> } | undefined;
  return (load) => {
    if (value && now() - value.at < ttlMs) return value.data;
    const data = load();
    value = { at: now(), data };
    data.catch(() => {
      if (value?.data === data) value = undefined;
    });
    return data;
  };
}

export const safeRpcUrl = (text: string | undefined): string | undefined => parseWebUrl(text)?.toString();

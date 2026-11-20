// The paid-call summary: how many paid calls the chain shows, from the router's Settled events, with the founder's own
// wallets left out, and how many distinct payers and builders are behind them.
//
// A call counts when a Settled event says so. It does not count when the payer, the payee or the signing key is a wallet on
// the published founder list (docs/founder-wallets.json, versioned): a founder paying themselves proves nothing about
// anyone else. The list is data in the repository, so anyone can read exactly what was left out and which version of the
// list did it. This module reads the chain with three read-only methods and nothing else.
import { Interface, getAddress } from "ethers";
import { NETWORKS } from "./evidence";
import type { Network } from "./evidence";

export const FOUNDER_LIST_PATH = "docs/founder-wallets.json";

export type FounderWallet = { address: string; label: string };
export type FounderList = {
  version: number;
  updated: string;
  description: string;
  wallets: FounderWallet[];
  history: Array<{ version: number; date: string; note: string }>;
};

export class FounderListError extends Error {}

/** Reads and validates the published list. A list that is malformed is refused, never half-used. */
export function parseFounderList(raw: unknown): FounderList {
  if (typeof raw !== "object" || raw === null) throw new FounderListError("the founder list must be a JSON object");
  const o = raw as Record<string, unknown>;
  if (!Number.isInteger(o.version) || (o.version as number) < 1) throw new FounderListError("the founder list needs a version, a whole number from 1");
  if (typeof o.updated !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(o.updated)) throw new FounderListError("the founder list needs an `updated` date like 2026-11-19");
  if (typeof o.description !== "string" || o.description.trim() === "") throw new FounderListError("the founder list needs a description");
  if (!Array.isArray(o.wallets)) throw new FounderListError("the founder list needs a `wallets` array");
  const seen = new Set<string>();
  const wallets = o.wallets.map((w: unknown, i: number) => {
    const entry = w as { address?: unknown; label?: unknown };
    if (typeof entry?.address !== "string" || typeof entry?.label !== "string" || entry.label.trim() === "") {
      throw new FounderListError(`wallets[${i}] needs an address and a label`);
    }
    let address: string;
    try {
      address = getAddress(entry.address);
    } catch {
      throw new FounderListError(`wallets[${i}] is not a valid address`);
    }
    if (seen.has(address)) throw new FounderListError(`wallets[${i}] repeats ${address}`);
    seen.add(address);
    return { address, label: entry.label };
  });
  const history = Array.isArray(o.history) ? (o.history as FounderList["history"]) : [];
  if (history.length === 0 || history[history.length - 1]?.version !== o.version) {
    throw new FounderListError("the founder list's history must end with the list's own version, so a change is always recorded");
  }
  return { version: o.version as number, updated: o.updated, description: o.description, wallets, history };
}

export type SettledEvent = {
  payer: string;
  payee: string;
  toolId: string;
  amount: bigint;
  fee: bigint;
  nonce: string;
  signer: string;
  block: number;
  transaction: string;
};

export type Summary = {
  listVersion: number;
  founderWallets: number;
  settledEvents: number;
  excluded: number;
  /** How many events were excluded because of each role the founder wallet had in them. An event with two is counted in both. */
  excludedBy: { payer: number; payee: number; signer: number };
  paidCalls: number;
  distinctPayers: number;
  distinctBuilders: number;
  /** QUSDC units paid, summed over the counted calls. */
  amountUnits: bigint;
};

/** The whole filter. Pure, so a test can pin it. */
export function summarize(events: SettledEvent[], list: FounderList): Summary {
  const founders = new Set(list.wallets.map((w) => w.address.toLowerCase()));
  const payers = new Set<string>();
  const builders = new Set<string>();
  const out: Summary = {
    listVersion: list.version,
    founderWallets: founders.size,
    settledEvents: events.length,
    excluded: 0,
    excludedBy: { payer: 0, payee: 0, signer: 0 },
    paidCalls: 0,
    distinctPayers: 0,
    distinctBuilders: 0,
    amountUnits: 0n,
  };
  for (const e of events) {
    const byPayer = founders.has(e.payer.toLowerCase());
    const byPayee = founders.has(e.payee.toLowerCase());
    const bySigner = founders.has(e.signer.toLowerCase());
    if (byPayer || byPayee || bySigner) {
      out.excluded += 1;
      if (byPayer) out.excludedBy.payer += 1;
      if (byPayee) out.excludedBy.payee += 1;
      if (bySigner) out.excludedBy.signer += 1;
      continue;
    }
    out.paidCalls += 1;
    out.amountUnits += e.amount;
    payers.add(e.payer.toLowerCase());
    builders.add(e.payee.toLowerCase());
  }
  out.distinctPayers = payers.size;
  out.distinctBuilders = builders.size;
  return out;
}

// ------------------------------------------------------------------------------------------------ the chain

/** Every method this module may call. Nothing here can send or sign anything. */
export const SUMMARY_READ_ONLY_METHODS: ReadonlySet<string> = new Set(["eth_chainId", "eth_blockNumber", "eth_getLogs"]);

export type SummaryRpc = (method: string, params: unknown[]) => Promise<unknown>;

export class SummaryNetworkError extends Error {}

export function summaryRpc(url: string, fetchImpl: typeof fetch = fetch): SummaryRpc {
  let id = 0;
  return async (method, params) => {
    if (!SUMMARY_READ_ONLY_METHODS.has(method)) throw new Error(`method not allowed: ${method}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      id += 1;
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: controller.signal,
      });
      const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
      if (body.error) throw new SummaryNetworkError(body.error.message ?? "the node returned an error");
      return body.result ?? null;
    } catch (err) {
      if (err instanceof SummaryNetworkError) throw err;
      throw new SummaryNetworkError("network unavailable");
    } finally {
      clearTimeout(timer);
    }
  };
}

const SETTLED = "event Settled(address indexed payer, address indexed payee, bytes32 indexed toolId, uint256 amount, uint256 fee, bytes32 nonce, address signer)";
const iface = new Interface([SETTLED]);
const SETTLED_TOPIC = iface.getEvent("Settled")?.topicHash as string;

export type Scan = { events: SettledEvent[]; fromBlock: number; toBlock: number; windows: number };

/**
 * Reads every Settled event the router emitted between two blocks, in windows. A node that refuses a window (QIE's public
 * RPC refused a range of millions of blocks) gets a smaller one, down to 100 blocks; below that the scan fails rather than
 * return a partial count as if it were whole.
 */
export async function scanSettled(rpc: SummaryRpc, router: string, fromBlock: number, toBlock?: number, startWindow = 2_000): Promise<Scan> {
  const latest = toBlock ?? Number(BigInt((await rpc("eth_blockNumber", [])) as string));
  const events: SettledEvent[] = [];
  let windows = 0;
  let from = fromBlock;
  let size = startWindow;
  while (from <= latest) {
    const to = Math.min(latest, from + size - 1);
    let logs: Array<{ topics: string[]; data: string; blockNumber: string; transactionHash: string }>;
    try {
      logs = (await rpc("eth_getLogs", [
        { address: getAddress(router), topics: [SETTLED_TOPIC], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` },
      ])) as typeof logs;
    } catch (err) {
      if (size > 100) {
        size = Math.max(100, Math.floor(size / 2));
        continue;
      }
      throw err;
    }
    windows += 1;
    for (const log of logs ?? []) {
      const parsed = iface.parseLog({ topics: log.topics, data: log.data });
      if (!parsed) continue;
      events.push({
        payer: getAddress(String(parsed.args.payer)),
        payee: getAddress(String(parsed.args.payee)),
        toolId: String(parsed.args.toolId),
        amount: parsed.args.amount as bigint,
        fee: parsed.args.fee as bigint,
        nonce: String(parsed.args.nonce),
        signer: getAddress(String(parsed.args.signer)),
        block: Number(BigInt(log.blockNumber)),
        transaction: log.transactionHash,
      });
    }
    from = to + 1;
  }
  return { events, fromBlock, toBlock: latest, windows };
}

export const rpcUrlFor = (network: Network, override?: string): string => override?.trim() || NETWORKS[network].rpc;

export function formatSummary(s: Summary, scan: { fromBlock: number; toBlock: number }, router: string): string[] {
  const qusdc = `${s.amountUnits / 1_000_000n}.${(s.amountUnits % 1_000_000n).toString().padStart(6, "0")}`;
  return [
    `router ${getAddress(router)}, blocks ${scan.fromBlock} to ${scan.toBlock}`,
    `founder list version ${s.listVersion} (${s.founderWallets} wallet${s.founderWallets === 1 ? "" : "s"}), docs/founder-wallets.json`,
    `Settled events found: ${s.settledEvents}`,
    `left out as founder wallets: ${s.excluded} (as payer ${s.excludedBy.payer}, as payee ${s.excludedBy.payee}, as signer ${s.excludedBy.signer})`,
    `paid calls counted: ${s.paidCalls}`,
    `distinct payers: ${s.distinctPayers}`,
    `distinct builders: ${s.distinctBuilders}`,
    `QUSDC paid in counted calls: ${qusdc}`,
  ];
}

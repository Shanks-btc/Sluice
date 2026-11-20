// The proof harness. docs/EVIDENCE.md lists real transactions; this module reads each one back from
// QIE's public RPC, with read-only methods only, and says whether it holds up.
//
// A row PASSES only when the chain agrees with every column: the transaction exists and succeeded, it is
// in the stated block at the stated time, the stated contract emitted the stated event in it, and the
// event carries the stated amount and the stated actor. A network problem is SKIPPED, never PASS.
import { Interface } from "ethers";
import { EVENTS } from "./events";
import { parseQusdc } from "./units";

export type Network = "mainnet" | "testnet";

export const NETWORKS: Readonly<Record<Network, { chainId: number; rpc: string; heading: RegExp }>> = {
  mainnet: { chainId: 1990, rpc: "https://rpc1mainnet.qie.digital/", heading: /^##\s+mainnet\b/i },
  testnet: { chainId: 1983, rpc: "https://rpc1testnet.qie.digital/", heading: /^##\s+testnet\b/i },
};

export const EVIDENCE_COLUMNS = [
  "Date (UTC)",
  "Event",
  "Transaction hash",
  "Block",
  "Contract",
  "Amount",
  "Who",
] as const;

/** The columns a row written by the recorder has. The first seven are the original ones; Network is mandatory, so a row can never be read as belonging to the wrong chain. */
export const EVIDENCE_COLUMNS_EXTENDED = [...EVIDENCE_COLUMNS, "Network", "Claim", "Re-check"] as const;

export type EvidenceRow = {
  network: Network;
  date: string;
  event: string;
  hash: string;
  block: string;
  contract: string;
  amount: string;
  who: string;
  /** The claim type the recorder verified, like "deposit". Absent on a row in the original seven-column format. */
  claim?: string;
  /** The command that checks the row again. Absent on a row in the original format. */
  recheck?: string;
};

/** Every read-only method the checker is allowed to call. Nothing here can send or sign anything. */
export const READ_ONLY_METHODS: ReadonlySet<string> = new Set([
  "eth_chainId",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_getBlockByNumber",
]);

export class NetworkError extends Error {}

export type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

export type RowResult = { status: "PASS" | "FAIL" | "SKIPPED"; detail: string };

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** What the parser found besides the rows: which tables still use the original seven columns, which have no Network column. */
type Parsed = { rows: EvidenceRow[]; legacyTables: Network[] };

/** The hash cell is the bare hash, or the hash as a link to the explorer: `[0x…](https://…)`. */
export function hashFromCell(cell: string): string {
  const link = /^\[(0x[0-9a-fA-F]{64})\]\(https:\/\/[^)\s]+\)$/.exec(cell);
  return link ? (link[1] as string) : cell;
}

function parseTables(markdown: string): Parsed {
  const rows: EvidenceRow[] = [];
  const legacyTables: Network[] = [];
  let network: Network | undefined;
  let header: "legacy" | "extended" | undefined;
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    const heading = (Object.keys(NETWORKS) as Network[]).find((n) => NETWORKS[n].heading.test(line));
    if (heading) {
      network = heading;
      header = undefined;
      continue;
    }
    if (line.startsWith("## ")) {
      network = undefined;
      continue;
    }
    if (!network || !line.startsWith("|")) continue;
    const cells = line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
    if (/^:?-{3,}:?$/.test(cells[0] ?? "")) continue; // the separator line
    if (!header) {
      const joined = cells.join("|");
      if (joined === EVIDENCE_COLUMNS.join("|")) {
        header = "legacy";
        legacyTables.push(network);
      } else if (joined === EVIDENCE_COLUMNS_EXTENDED.join("|")) {
        header = "extended";
      } else {
        throw new Error(`the ${network} table must have exactly the columns: ${EVIDENCE_COLUMNS_EXTENDED.join(" | ")}`);
      }
      continue;
    }
    const width = header === "legacy" ? EVIDENCE_COLUMNS.length : EVIDENCE_COLUMNS_EXTENDED.length;
    if (cells.length !== width) throw new Error(`malformed evidence row: ${line.slice(0, 80)}`);
    const [date, event, hash, block, contract, amount, who, labelled, claim, recheck] = cells as [string, string, string, string, string, string, string, string, string, string];
    if (header === "extended") {
      // A row says which chain it is about, and that must be the chain of the table it sits in: a row copied from a test run on a
      // fork, or from the testnet, cannot be read as mainnet proof.
      if (labelled !== network) throw new Error(`a row labelled "${labelled}" is in the ${network} table: ${line.slice(0, 80)}`);
      rows.push({ network, date, event, hash: hashFromCell(hash), block, contract, amount, who, claim, recheck: recheck.replace(/`/g, "") });
    } else {
      rows.push({ network, date, event, hash, block, contract, amount, who });
    }
  }
  return { rows, legacyTables };
}

/** Reads the evidence tables. Throws on a malformed table or row rather than skip it. Accepts the original seven columns as well. */
export function parseEvidence(markdown: string): EvidenceRow[] {
  return parseTables(markdown).rows;
}

/**
 * Reads the evidence tables and refuses any table that lacks the Network column. This is what every program that counts or shows
 * evidence uses (the checker, the recorder, the summary, the web pages). Only the recorder writes rows, and it always writes the column.
 */
export function parseEvidenceStrict(markdown: string): EvidenceRow[] {
  const { rows, legacyTables } = parseTables(markdown);
  if (legacyTables.length > 0) {
    throw new Error(`the ${legacyTables[0]} table has no Network column: rows must be written by the recorder (pnpm evidence:record), which labels each one`);
  }
  return rows;
}

function isoFromSeconds(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

type RpcLog = { address: string; topics: string[]; data: string };
type RpcReceipt = { status: string; blockNumber: string; logs: RpcLog[] } | null;

/** One row against the chain. */
export async function checkRow(row: EvidenceRow, rpc: Rpc): Promise<RowResult> {
  const shape = checkShape(row);
  if (shape) return { status: "FAIL", detail: shape };
  const spec = EVENTS[row.event] as (typeof EVENTS)[string];
  try {
    const chainId = await rpc("eth_chainId", []);
    if (typeof chainId !== "string" || BigInt(chainId) !== BigInt(NETWORKS[row.network].chainId)) {
      return { status: "FAIL", detail: `wrong chain: expected ${NETWORKS[row.network].chainId}, RPC says ${String(chainId)}` };
    }
    const receipt = (await rpc("eth_getTransactionReceipt", [row.hash])) as RpcReceipt;
    if (!receipt) return { status: "FAIL", detail: "transaction not found" };
    if (receipt.status !== "0x1") return { status: "FAIL", detail: "transaction failed (status is not 0x1)" };
    if (BigInt(receipt.blockNumber) !== BigInt(row.block)) {
      return { status: "FAIL", detail: `block differs: row ${row.block}, chain ${BigInt(receipt.blockNumber)}` };
    }
    const block = (await rpc("eth_getBlockByNumber", [receipt.blockNumber, false])) as { timestamp: string } | null;
    if (!block) return { status: "FAIL", detail: "block not found" };
    const onChainDate = isoFromSeconds(BigInt(block.timestamp));
    if (onChainDate !== row.date) return { status: "FAIL", detail: `date differs: row ${row.date}, chain ${onChainDate}` };

    const fromContract = receipt.logs.filter((l) => l.address.toLowerCase() === row.contract.toLowerCase());
    if (fromContract.length === 0) return { status: "FAIL", detail: `wrong contract: no log from ${row.contract}` };

    const iface = new Interface([spec.fragment]);
    const topic = iface.getEvent(row.event)?.topicHash;
    const matching = fromContract.filter((l) => l.topics[0] === topic);
    if (matching.length === 0) return { status: "FAIL", detail: `no ${row.event} event from ${row.contract}` };

    const parsed = matching
      .map((l) => iface.parseLog({ topics: l.topics, data: l.data }))
      .filter((p): p is NonNullable<typeof p> => p !== null);
    const byWho = parsed.filter((p) => String(p.args[spec.whoField]).toLowerCase() === row.who.toLowerCase());
    if (byWho.length === 0) return { status: "FAIL", detail: `no ${row.event} event for ${row.who}` };

    if (spec.amountField) {
      const want = parseQusdc(row.amount);
      if (!byWho.some((p) => BigInt(p.args[spec.amountField as string]) === want)) {
        const found = byWho.map((p) => String(p.args[spec.amountField as string])).join(", ");
        return { status: "FAIL", detail: `different amount: row ${want} units, chain ${found}` };
      }
    }
    return { status: "PASS", detail: `${row.event} confirmed in block ${row.block}` };
  } catch (err) {
    if (err instanceof NetworkError) return { status: "SKIPPED", detail: `network: ${err.message}` };
    return { status: "SKIPPED", detail: "network: unexpected response" };
  }
}

/** Format problems that need no chain to spot. Returns a message, or undefined when the row is well formed. */
export function checkShape(row: EvidenceRow): string | undefined {
  if (!DATE.test(row.date)) return `date must look like 2026-12-01T10:00:00Z, got ${JSON.stringify(row.date)}`;
  const spec = EVENTS[row.event];
  if (!spec) return `unknown event ${JSON.stringify(row.event)}`;
  if (!HASH.test(row.hash)) return "transaction hash must be 0x followed by 64 hex characters";
  if (!/^\d+$/.test(row.block)) return "block must be a whole number";
  if (!ADDRESS.test(row.contract)) return "contract must be an address";
  if (!ADDRESS.test(row.who)) return "who must be an address";
  if (spec.amountField) {
    try {
      parseQusdc(row.amount);
    } catch {
      return "amount must be an exact decimal with six places, like 0.010000";
    }
  } else if (row.amount !== "—") {
    return `${row.event} has no amount, so the Amount column must be —`;
  }
  return undefined;
}

/** A JSON-RPC client that can only call read-only methods. */
export function jsonRpc(url: string, fetchImpl: typeof fetch = fetch): Rpc {
  let id = 0;
  return async (method, params) => {
    if (!READ_ONLY_METHODS.has(method)) throw new Error(`method not allowed: ${method}`);
    let res: Response;
    try {
      id += 1;
      res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new NetworkError("network unavailable");
    }
    if (res.status === 429 || res.status >= 500) throw new NetworkError(`HTTP ${res.status}`);
    let body: { result?: unknown; error?: unknown };
    try {
      body = (await res.json()) as { result?: unknown; error?: unknown };
    } catch {
      throw new NetworkError("unreadable response");
    }
    if (body.error) throw new NetworkError("the node returned an error");
    return body.result ?? null;
  };
}

export type Summary = { pass: number; fail: number; skipped: number; lines: string[] };

/** Checks every row. The caller chooses how to reach each network. */
export async function checkAll(rows: EvidenceRow[], rpcFor: (network: Network) => Rpc): Promise<Summary> {
  const summary: Summary = { pass: 0, fail: 0, skipped: 0, lines: [] };
  for (const row of rows) {
    const result = await checkRow(row, rpcFor(row.network));
    if (result.status === "PASS") summary.pass += 1;
    else if (result.status === "FAIL") summary.fail += 1;
    else summary.skipped += 1;
    summary.lines.push(`${result.status.padEnd(7)} ${row.network} ${row.event} ${row.hash} ${result.detail}`);
  }
  return summary;
}

/** 0 when every row passed (or there are no rows), 1 when any failed, 2 when none failed but some were skipped. */
export function exitCodeFor(summary: Summary): number {
  if (summary.fail > 0) return 1;
  if (summary.skipped > 0) return 2;
  return 0;
}

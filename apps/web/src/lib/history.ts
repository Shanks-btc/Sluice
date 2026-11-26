// A wallet's own history, read from the chain's events: deposits, payments for tool calls, earnings, refunds, withdrawals and agent
// keys authorised or revoked. Nothing is stored anywhere and nothing is asked of a server: the events are the record.
//
// The public RPC refuses eth_getLogs over a long range, so events are found by scanning back from the latest block in windows (halved
// if the node refuses). A scan that does not reach the router's first block says so, and "Load older" continues from where it stopped.
import { Interface, getAddress, id, zeroPadValue } from "ethers";
import type { Provider } from "ethers";
import { ROUTER_ABI, VAULT_ABI } from "@sluice/sdk/abi";
import { formatUsdc, formatUtc, shortAddress, shortHash } from "./format";
import { explorerTxUrl } from "./networks";
import type { NetworkInfo } from "./networks";
import type { ChainReader } from "./reads";

export type HistoryKind = "deposit" | "payment" | "earning" | "refund" | "withdrawal" | "agent_authorised" | "agent_revoked";

export type HistoryRow = {
  /** Unique: the transaction and the log's place in it. */
  key: string;
  kind: HistoryKind;
  label: string;
  blockNumber: number;
  logIndex: number;
  txHash: string;
  /** QUSDC units; for an authorised key, its budget. */
  amount?: bigint;
  counterparty?: string;
  detail: string;
  /** Unix seconds, from the block. Missing when the node would not give the block. */
  timestamp?: number;
};

const routerIface = new Interface(ROUTER_ABI as unknown as string[]);
const vaultIface = new Interface(VAULT_ABI as unknown as string[]);

const T = {
  deposited: id("Deposited(address,address,uint256)"),
  settled: id("Settled(address,address,bytes32,uint256,uint256,bytes32,address)"),
  withdrawn: id("Withdrawn(address,address,uint256,address,uint256)"),
  refunded: id("Refunded(address,address,uint256,address,uint256)"),
  authorised: id("SessionAuthorized(address,address,uint64,uint256,uint256,uint256,bytes32)"),
  revoked: id("SessionRevoked(address,address,uint64)"),
};

type RawLog = { blockNumber: number; transactionHash: string; topics: readonly string[]; data: string; index: number };

/** Turns one log into a row, or undefined for a log that is not one of ours. `who` is the account whose history this is. */
export function rowFromLog(log: RawLog, who: string, from: "router" | "vault"): HistoryRow | undefined {
  const me = getAddress(who);
  let parsed;
  try {
    parsed = (from === "router" ? routerIface : vaultIface).parseLog({ topics: [...log.topics], data: log.data });
  } catch {
    return undefined;
  }
  if (!parsed) return undefined;
  const a = parsed.args;
  const base = { key: `${log.transactionHash}:${log.index}`, blockNumber: log.blockNumber, logIndex: log.index, txHash: log.transactionHash };
  switch (parsed.name) {
    case "Deposited": {
      if (getAddress(String(a.account)) !== me) return undefined;
      const sender = getAddress(String(a.from));
      return { ...base, kind: "deposit", label: "Deposit", amount: BigInt(a.amount as bigint), counterparty: sender, detail: sender === me ? "From your wallet" : `Sent by ${shortAddress(sender)}` };
    }
    case "Withdrawn": {
      if (getAddress(String(a.account)) !== me) return undefined;
      return { ...base, kind: "withdrawal", label: "Withdrawal of earnings", amount: BigInt(a.amount as bigint), counterparty: getAddress(String(a.to)), detail: `To ${shortAddress(String(a.to))}` };
    }
    case "Refunded": {
      if (getAddress(String(a.payer)) !== me) return undefined;
      return { ...base, kind: "refund", label: "Refund of prepaid balance", amount: BigInt(a.amount as bigint), counterparty: getAddress(String(a.to)), detail: `To ${shortAddress(String(a.to))}` };
    }
    case "Settled": {
      const payer = getAddress(String(a.payer));
      const payee = getAddress(String(a.payee));
      const fee = BigInt(a.fee as bigint);
      if (payer === me) {
        return { ...base, kind: "payment", label: "Paid for a tool call", amount: BigInt(a.amount as bigint), counterparty: payee, detail: `To ${shortAddress(payee)}, tool ${shortHash(String(a.toolId))}` };
      }
      if (payee === me) {
        return { ...base, kind: "earning", label: "Earned from a tool call", amount: BigInt(a.amount as bigint), counterparty: payer, detail: `From ${shortAddress(payer)}, fee ${formatUsdc(fee)} QUSDC` };
      }
      return undefined;
    }
    case "SessionAuthorized": {
      if (getAddress(String(a.payer)) !== me) return undefined;
      const agent = getAddress(String(a.agent));
      return { ...base, kind: "agent_authorised", label: "Agent key authorised", amount: BigInt(a.budget as bigint), counterparty: agent, detail: `Budget ${formatUsdc(BigInt(a.budget as bigint))}, ${formatUsdc(BigInt(a.perCallCap as bigint))} a call, expires ${formatUtc(Number(a.expiry))}` };
    }
    case "SessionRevoked": {
      if (getAddress(String(a.payer)) !== me) return undefined;
      return { ...base, kind: "agent_revoked", label: "Agent key revoked", counterparty: getAddress(String(a.agent)), detail: "The key can no longer pay" };
    }
    default:
      return undefined;
  }
}

export type HistoryScan = {
  /** The newest block this read looked at, and the oldest. */
  toBlock: number;
  fromBlock: number;
  /** True when the scan reached the router's first block, so the list is complete. */
  reachedStart: boolean;
  /** Where "Load older" continues from: the block below the oldest one read. Null when the start was reached. */
  cursor: number | null;
};

export type HistoryOptions = {
  /** The router's deployment block, where the scan stops. */
  startBlock?: number | null;
  /** Continue from this block downwards (a cursor from an earlier read). Default: the latest block. */
  before?: number | null;
  window?: number;
  maxWindows?: number;
  /** Stop once this many rows are found. */
  want?: number;
};

const pad = (address: string): string => zeroPadValue(getAddress(address), 32);

/** Reads one account's history, newest first. */
export async function readHistory(reader: ChainReader, account: string, options: HistoryOptions = {}): Promise<{ rows: HistoryRow[]; scan: HistoryScan }> {
  const me = getAddress(account);
  const provider: Provider = reader.provider;
  const latest = await provider.getBlockNumber();
  const floor = options.startBlock ?? 0;
  const window = options.window ?? 2_000;
  const maxWindows = options.maxWindows ?? 25;
  const want = options.want ?? 30;
  const rows = new Map<string, HistoryRow>();
  let to = options.before === undefined || options.before === null ? latest : Math.min(options.before, latest);
  let size = window;
  let windows = 0;
  let low = to + 1;
  while (to >= floor && windows < maxWindows && rows.size < want) {
    const from = Math.max(floor, to - size + 1);
    let logs: Array<{ log: RawLog; from: "router" | "vault" }>;
    try {
      const [mine, earned, keys] = await Promise.all([
        provider.getLogs({ address: reader.routerAddress, topics: [[T.deposited, T.withdrawn, T.refunded, T.settled], pad(me)], fromBlock: from, toBlock: to }),
        provider.getLogs({ address: reader.routerAddress, topics: [T.settled, null, pad(me)], fromBlock: from, toBlock: to }),
        provider.getLogs({ address: reader.vaultAddress, topics: [[T.authorised, T.revoked], pad(me)], fromBlock: from, toBlock: to }),
      ]);
      logs = [
        ...(mine as unknown as RawLog[]).map((log) => ({ log, from: "router" as const })),
        ...(earned as unknown as RawLog[]).map((log) => ({ log, from: "router" as const })),
        ...(keys as unknown as RawLog[]).map((log) => ({ log, from: "vault" as const })),
      ];
    } catch (err) {
      if (size > 100) {
        size = Math.max(100, Math.floor(size / 2));
        continue;
      }
      throw err;
    }
    windows += 1;
    low = from;
    for (const { log, from: where } of logs) {
      const row = rowFromLog(log, me, where);
      if (row) rows.set(row.key, row);
    }
    to = from - 1;
    size = window;
  }
  const sorted = [...rows.values()].sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);
  const reachedStart = low <= floor;
  return { rows: sorted, scan: { toBlock: options.before === undefined || options.before === null ? latest : Math.min(options.before, latest), fromBlock: Math.min(low, latest), reachedStart, cursor: reachedStart ? null : low - 1 } };
}

/** Fills in each row's time from its block. A block the node will not give is left without a time. */
export async function attachTimestamps(provider: Provider, rows: HistoryRow[], limit = 60): Promise<HistoryRow[]> {
  const blocks = [...new Set(rows.map((r) => r.blockNumber))].slice(0, limit);
  const times = new Map<number, number>();
  await Promise.all(
    blocks.map(async (n) => {
      try {
        const block = await provider.getBlock(n);
        if (block) times.set(n, block.timestamp);
      } catch {
        // left without a time
      }
    }),
  );
  return rows.map((r) => (times.has(r.blockNumber) ? { ...r, timestamp: times.get(r.blockNumber) } : r));
}

// ------------------------------------------------------------------------------------------------ pages and CSV

export type Page<T> = { items: T[]; page: number; pages: number; total: number };

/** One page of a list. A page number out of range is brought back into it. */
export function paginate<T>(rows: readonly T[], page: number, size: number): Page<T> {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const p = Math.min(Math.max(1, Math.trunc(Number.isFinite(page) ? page : 1)), pages);
  return { items: rows.slice((p - 1) * size, p * size), page: p, pages, total: rows.length };
}

/**
 * One cell of a CSV file. A cell that a spreadsheet would read as a formula (it starts with = + - @, a tab or a carriage return) is
 * prefixed with an apostrophe so it is shown as text and never run, and a cell with a comma, a quote or a line break is quoted.
 */
export function csvCell(value: string): string {
  let v = value;
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export const CSV_HEADER = ["time_utc", "block", "transaction", "event", "amount_qusdc", "counterparty", "detail"] as const;

/** The history as a CSV file's text: one header line and one line per row, newest first, with every amount as an exact decimal. */
export function toCsv(rows: readonly HistoryRow[]): string {
  const lines: string[] = [CSV_HEADER.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.timestamp === undefined ? "" : new Date(r.timestamp * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
        String(r.blockNumber),
        r.txHash,
        r.label,
        r.amount === undefined ? "" : formatUsdc(r.amount),
        r.counterparty ?? "",
        r.detail,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** sluice-history-0x1234abcd-2026-12-01.csv: the account's first and last hex digits, and the day. */
export function csvFilename(account: string, nowMs: number): string {
  const a = account.toLowerCase();
  return `sluice-history-${a.slice(0, 6)}${a.slice(-4)}-${new Date(nowMs).toISOString().slice(0, 10)}.csv`;
}

/** The explorer link of a row's transaction, if the network has an explorer. */
export const rowLink = (row: HistoryRow, network: NetworkInfo): string | undefined => explorerTxUrl(row.txHash, network);

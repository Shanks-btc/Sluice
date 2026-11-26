"use client";
// A wallet's activity, read from the chain's events (deposits, payments, earnings, refunds, withdrawals, agent keys authorised and
// revoked), with an explorer link on each row, pages of ten, a "Load older" step, and a CSV file of the person's own history.
// Nothing is stored and nothing is asked of a server: the events are the record. The file is made in the browser and goes nowhere.
import { useCallback, useEffect, useState } from "react";
import { CSV_HEADER, attachTimestamps, csvFilename, paginate, readHistory, rowLink, toCsv } from "../lib/history";
import type { HistoryRow, HistoryScan } from "../lib/history";
import { formatUsdc, formatUtc, shortAddress, shortHash } from "../lib/format";
import type { ChainReader } from "../lib/reads";
import { useConfig } from "./providers";

export const HISTORY_PAGE_SIZE = 10;

export function HistoryPanel({ reader, account, refreshKey = 0 }: { reader: ChainReader; account: string; refreshKey?: number }) {
  const config = useConfig();
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [scan, setScan] = useState<HistoryScan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const load = useCallback(
    async (more: boolean, before: number | null) => {
      setLoading(true);
      setError(null);
      try {
        const got = await readHistory(reader, account, { startBlock: config.fromBlock, before: more ? before : null });
        const timed = await attachTimestamps(reader.provider, got.rows);
        setRows((old) => (more ? [...old, ...timed.filter((r) => !old.some((o) => o.key === r.key))] : timed));
        setScan(got.scan);
      } catch {
        setError("The chain's events could not be read just now. Try again in a moment.");
      } finally {
        setLoading(false);
      }
    },
    [reader, account, config.fromBlock],
  );

  useEffect(() => {
    setPage(1);
    void load(false, null);
  }, [load, refreshKey]);

  const view = paginate(rows, page, HISTORY_PAGE_SIZE);

  const download = () => {
    const blob = new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = csvFilename(account, Date.now());
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  return (
    <section className="stack" aria-labelledby="history-title" data-testid="history">
      <h2 id="history-title" className="h-section">Activity</h2>
      <p className="muted">
        Read from the router&apos;s and the vault&apos;s own events for this wallet. It lists deposits, payments for tool calls, what you earned as a builder, refunds, withdrawals, and agent keys authorised or revoked.
      </p>
      {error ? <p className="banner banner-error" role="alert" data-testid="history-error">{error}</p> : null}
      {loading && rows.length === 0 ? <p className="muted" data-testid="history-loading">Reading the chain&apos;s events…</p> : null}
      {!loading && !error && rows.length === 0 && scan ? (
        <div className="empty" data-testid="history-empty">
          <h3>No activity found</h3>
          <p>
            Nothing was found for this wallet in blocks {scan.fromBlock.toLocaleString("en-US")} to {scan.toBlock.toLocaleString("en-US")}.
            {scan.reachedStart ? " That reaches the router's first block, so there is none." : " That is the latest stretch of the chain, not its whole history."}
          </p>
          {!scan.reachedStart ? (
            <button type="button" className="btn btn-soft btn-sm" onClick={() => void load(true, scan.cursor)} data-testid="history-older">Look further back</button>
          ) : null}
        </div>
      ) : null}
      {rows.length > 0 ? (
        <>
          <div className="table-wrap">
            <table className="table" data-testid="history-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>What</th>
                  <th className="right">QUSDC</th>
                  <th>With</th>
                  <th>Transaction</th>
                </tr>
              </thead>
              <tbody>
                {view.items.map((r) => {
                  const url = rowLink(r, config.network);
                  return (
                    <tr key={r.key} data-testid="history-row" data-kind={r.kind}>
                      <td data-label="Time" className="mono">{r.timestamp ? formatUtc(r.timestamp) : `block ${r.blockNumber.toLocaleString("en-US")}`}</td>
                      <td data-label="What">{r.label}<br /><span className="muted">{r.detail}</span></td>
                      <td data-label="QUSDC" className="right amount">{r.amount === undefined ? "" : formatUsdc(r.amount)}</td>
                      <td data-label="With" className="address">{r.counterparty ? shortAddress(r.counterparty) : ""}</td>
                      <td data-label="Transaction" className="mono">
                        {url ? <a className="link" href={url} rel="noopener noreferrer" target="_blank">{shortHash(r.txHash)}</a> : shortHash(r.txHash)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="row" data-testid="history-pager">
            <button type="button" className="btn btn-soft btn-sm" onClick={() => setPage(view.page - 1)} disabled={view.page <= 1} data-testid="history-prev">Newer</button>
            <span className="muted" data-testid="history-page">Page {view.page} of {view.pages}, {view.total} {view.total === 1 ? "row" : "rows"}</span>
            <button type="button" className="btn btn-soft btn-sm" onClick={() => setPage(view.page + 1)} disabled={view.page >= view.pages} data-testid="history-next">Older</button>
            <span className="spacer" />
            {scan && !scan.reachedStart ? (
              <button type="button" className="btn btn-soft btn-sm" onClick={() => void load(true, scan.cursor)} disabled={loading} data-testid="history-older">{loading ? "Reading…" : "Load older"}</button>
            ) : null}
            <button type="button" className="btn btn-dark btn-sm" onClick={download} data-testid="history-csv">Download CSV</button>
          </div>
          <p className="muted">
            {scan?.reachedStart ? "This reaches the router's first block." : `This is the latest stretch of the chain (from block ${scan?.fromBlock.toLocaleString("en-US") ?? "?"}), not its whole history.`} The CSV holds the {rows.length} {rows.length === 1 ? "row" : "rows"} loaded, with the columns {CSV_HEADER.join(", ")}.
          </p>
        </>
      ) : null}
    </section>
  );
}

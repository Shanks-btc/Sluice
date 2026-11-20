// The evidence file as tables, and the paid-call counts. Rows come from docs/EVIDENCE.md; a mainnet row links to the explorer, and
// every table says how to check it again. The counts are shown only when they were actually read from the chain: a missing router or an
// unreachable node is said in words, and is never shown as zero.
import type { EvidenceRow } from "../../../../src/evidence";
import { formatUsdc, shortAddress, shortHash } from "../lib/format";
import { MAINNET, explorerTxUrl } from "../lib/networks";
import type { SummaryAnswer } from "../lib/summary-handler";

export const RECHECK_COMMAND = "pnpm evidence:check";
export const SUMMARY_COMMAND = "pnpm evidence:summary";

export function EvidenceTable({ network, rows }: { network: "mainnet" | "testnet"; rows: readonly EvidenceRow[] }) {
  const mine = rows.filter((r) => r.network === network);
  const title = network === "mainnet" ? "Mainnet (chain 1990)" : "Testnet (chain 1983)";
  return (
    <section className="stack" aria-labelledby={`ev-${network}`} data-testid={`evidence-${network}`}>
      <h2 id={`ev-${network}`} className="h-section">{title}</h2>
      {mine.length === 0 ? (
        <div className="empty" data-testid={`evidence-${network}-empty`}>
          <h3>No verified rows</h3>
          <p>Nothing has been run on {network === "mainnet" ? "QIE mainnet" : "QIE testnet"} yet, so this table is empty. A row is added after a real transaction, and is then checked against the chain.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Date (UTC)</th>
                <th>Event</th>
                <th>Transaction</th>
                <th>Block</th>
                <th>Contract</th>
                <th className="right">Amount (QUSDC)</th>
                <th>Who</th>
              </tr>
            </thead>
            <tbody>
              {mine.map((r) => {
                const url = network === "mainnet" ? explorerTxUrl(r.hash, MAINNET) : undefined;
                return (
                  <tr key={`${r.hash}-${r.event}`}>
                    <td data-label="Date (UTC)"><time dateTime={r.date}>{r.date}</time></td>
                    <td data-label="Event">{r.event}</td>
                    <td data-label="Transaction" className="mono">
                      {url ? <a className="link" href={url} rel="noopener noreferrer" target="_blank">{shortHash(r.hash)}</a> : shortHash(r.hash)}
                    </td>
                    <td data-label="Block" className="num">{r.block}</td>
                    <td data-label="Contract" className="address">{shortAddress(r.contract)}</td>
                    <td data-label="Amount" className="right amount">{r.amount}</td>
                    <td data-label="Who" className="address">{shortAddress(r.who)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted">
        Check these rows against the chain with <code>{RECHECK_COMMAND}</code>. It reads each transaction back from QIE&apos;s public RPC with read-only calls and fails if anything differs.
      </p>
    </section>
  );
}

export function SummaryView({ answer, founder }: { answer: SummaryAnswer; founder: { version: number; wallets: number } }) {
  return (
    <section className="stack" aria-labelledby="summary-title" data-testid="evidence-summary">
      <h2 id="summary-title" className="h-section">Paid calls the chain shows</h2>
      <p className="muted">
        Counted from the router&apos;s <code>Settled</code> events, leaving out any payment where a wallet on the published founder list (version {founder.version}, {founder.wallets} wallet{founder.wallets === 1 ? "" : "s"}) is the payer, the payee or the signer. The same count is printed by <code>{SUMMARY_COMMAND}</code>.
      </p>
      {answer.state === "ok" ? (
        <>
          <div className="stats">
            <div className="card card-solid stat"><span className="stat-label">Paid calls counted</span><span className="stat-value" data-testid="paid-calls">{answer.paidCalls}</span></div>
            <div className="card card-solid stat"><span className="stat-label">Distinct payers</span><span className="stat-value" data-testid="distinct-payers">{answer.distinctPayers}</span></div>
            <div className="card card-solid stat"><span className="stat-label">Distinct builders</span><span className="stat-value" data-testid="distinct-builders">{answer.distinctBuilders}</span></div>
            <div className="card card-solid stat"><span className="stat-label">QUSDC paid</span><span className="stat-value">{formatUsdc(BigInt(answer.amountUnits))}</span></div>
          </div>
          <p className="muted">
            Blocks {answer.fromBlock.toLocaleString("en-US")} to {answer.toBlock.toLocaleString("en-US")} on router {answer.router}. Settled events found: {answer.settledEvents}; left out as founder wallets: {answer.excluded}.
          </p>
        </>
      ) : (
        <div className="empty" data-testid="summary-empty" data-state={answer.state}>
          <h3>{answer.state === "not_configured" ? "No counts to show" : "The counts could not be read"}</h3>
          <p>{answer.reason}</p>
        </div>
      )}
    </section>
  );
}

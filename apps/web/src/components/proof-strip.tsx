// The proof strip: real transactions from docs/EVIDENCE.md, and nothing else presented as real.
//
//  - A mainnet row with a transaction hash is listed with a link to the QIE explorer.
//  - A testnet row is listed and labelled as testnet, without a link (no testnet explorer was checked).
//  - With no mainnet rows the strip says so. It may then show a sample from a local fork, labelled as one, with no links, because
//    those transactions exist only on a machine that was switched off afterwards.
import type { EvidenceRow } from "../../../../src/evidence";
import { MAINNET, explorerTxUrl } from "../lib/networks";
import { shortAddress, shortHash } from "../lib/format";

export type ForkSample = {
  source: "local fork";
  note: string;
  chainId: number;
  rows: Array<{ event: string; amount: string; who: string; hash: string; block: number }>;
};

export const EMPTY_MAINNET = "No mainnet transactions recorded yet";
export const FORK_LABEL = "Sample from a local fork — not mainnet";

export function ProofStrip({ rows, sample, limit = 6 }: { rows: readonly EvidenceRow[]; sample?: ForkSample | null; limit?: number }) {
  const mainnet = rows.filter((r) => r.network === "mainnet" && /^0x[0-9a-fA-F]{64}$/.test(r.hash));
  const testnet = rows.filter((r) => r.network === "testnet" && /^0x[0-9a-fA-F]{64}$/.test(r.hash));
  const shown = mainnet.slice(-limit).reverse();
  return (
    <section className="proof card" aria-labelledby="proof-title" data-testid="proof-strip">
      <div className="proof-head">
        <h2 id="proof-title">Proof</h2>
        <span className="tag tag-info">QIE mainnet · chain {MAINNET.chainId}</span>
      </div>
      {shown.length > 0 ? (
        <ul className="proof-list">
          {shown.map((r) => {
            const url = explorerTxUrl(r.hash, MAINNET);
            return (
              <li key={`${r.hash}-${r.event}`} data-kind="mainnet">
                <span className="proof-event">{r.event}</span>
                <span className="amount">{r.amount === "—" ? "" : `${r.amount} QUSDC`}</span>
                <span className="address">{shortAddress(r.who)}</span>
                <time dateTime={r.date}>{r.date.slice(0, 10)}</time>
                {url ? (
                  <a className="link mono" href={url} rel="noopener noreferrer" target="_blank">
                    {shortHash(r.hash)}
                  </a>
                ) : (
                  <span className="mono">{shortHash(r.hash)}</span>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="proof-empty" data-testid="proof-empty">
          {EMPTY_MAINNET}. A row is added to <a className="link" href="/evidence">the evidence file</a> after a transaction has been read back from the chain.
        </p>
      )}
      {testnet.length > 0 ? (
        <p className="muted proof-note">
          {testnet.length} testnet transaction{testnet.length === 1 ? "" : "s"} listed on <a className="link" href="/evidence">the evidence page</a>, labelled as testnet.
        </p>
      ) : null}
      {mainnet.length === 0 && sample ? (
        <div className="sample" data-testid="fork-sample">
          <p className="sample-label">
            <span className="tag tag-warn">Local fork</span> {FORK_LABEL}
          </p>
          <p className="muted">{sample.note}</p>
          <ul className="proof-list">
            {sample.rows.map((r) => (
              <li key={`${r.hash}-${r.event}`} data-kind="fork">
                <span className="proof-event">{r.event}</span>
                <span className="amount">{r.amount} QUSDC</span>
                <span className="address">{shortAddress(r.who)}</span>
                <span className="muted">block {r.block}</span>
                <span className="mono">{shortHash(r.hash)}</span>
              </li>
            ))}
          </ul>
          <p className="muted proof-note">These hashes exist only on a local copy of the chain. They are not on QIE and have no explorer link.</p>
        </div>
      ) : null}
    </section>
  );
}

// The evidence file as tables, and the paid-call counts. Rows come from docs/EVIDENCE.md; a mainnet row links to the explorer, and
// every table says how to check it again. The counts are shown only when they were actually read from the chain: a missing router or an
// unreachable node is said in words, and is never shown as zero.
import type { EvidenceRow } from "../../../../src/evidence";
import { formatUsdc, shortAddress, shortHash } from "../lib/format";
import { MAINNET, explorerAddressUrl, explorerTxUrl } from "../lib/networks";
import { countOwn, ownRowsSentence } from "../lib/own-rows";
import type { NetworkInfo } from "../lib/networks";
import type { SummaryAnswer } from "../lib/summary-handler";

export const RECHECK_COMMAND = "pnpm evidence:check";
export const SUMMARY_COMMAND = "pnpm evidence:summary";
export const VAULT_COMMAND = "pnpm live:vaultcheck";

/**
 * What the evidence says about the two contracts' source, and what it cannot say. The router's source is said to be verified on the
 * explorer only when a mainnet SourceVerified row is in the evidence file. The vault is created by the router's constructor, so it has
 * no such row. What the explorer showed for it is said only when the recorded answer is on file (`shown`) and is about the vault this
 * site is set to, with the date it was read. Either way the code check that needs no explorer is what is offered.
 */
export function ContractsNote({ rows, router, vault, network, shown }: { rows: readonly EvidenceRow[]; router: string | null; vault: string | null; network: NetworkInfo; shown: { vault: string; readAt: string } | null }) {
  const routerVerified = rows.some((r) => r.network === "mainnet" && r.event === "SourceVerified");
  const vaultShown = shown !== null && network.chainId === MAINNET.chainId && (vault === null || vault.toLowerCase() === shown.vault.toLowerCase()) ? shown : null;
  const routerUrl = router ? explorerAddressUrl(router, network) : undefined;
  const vaultUrl = vault ? explorerAddressUrl(vault, network) : undefined;
  const link = (address: string, url: string | undefined) => (url ? <a className="link" href={url} rel="noopener noreferrer" target="_blank">{address}</a> : address);
  return (
    <section className="stack" aria-labelledby="contracts-title" data-testid="evidence-contracts">
      <h2 id="contracts-title" className="h-section">The router and the vault</h2>
      <p data-testid="router-source">
        {routerVerified
          ? "The explorer shows verified source for the router: the SourceVerified row above links to its page. Compare that source with this repository's yourself."
          : "No row says the explorer shows verified source for the router yet. A SourceVerified row is added only after the recorder has asked the explorer."}
      </p>
      <p data-testid="vault-source">
        The vault is not deployed on its own: the router&apos;s constructor creates it, so it has no deployment transaction and no SourceVerified row.{" "}
        {vaultShown ? (
          <>
            QIE&apos;s explorer showed verified source for the vault at <span className="address">{vaultShown.vault}</span> when the explorer was read on {vaultShown.readAt.slice(0, 10)}; its answer is saved in <span className="address">docs/explorer/vault-record.json</span>, and the vault&apos;s page on the explorer is where to look now.
          </>
        ) : (
          "No record on this site shows the explorer verifying the vault's source."
        )}{" "}
        What anyone can check without the explorer is its code: <code>{VAULT_COMMAND}</code> reads the vault&apos;s address from the router, reads the code at that address, and compares its hash with the compiled AgentVault of this repository (solc 0.8.24, the optimizer on at 200 runs, the Shanghai EVM), and prints those settings so the build can be repeated. It is a command to run, not a recorded row.
      </p>
      {router || vault ? (
        <dl className="facts" data-testid="contract-addresses">
          {router ? <div><dt>Router</dt><dd className="mono">{link(router, routerUrl)}</dd></div> : null}
          {vault ? <div><dt>Vault</dt><dd className="mono">{link(vault, vaultUrl)}</dd></div> : null}
        </dl>
      ) : null}
    </section>
  );
}

/** One network's rows. `own` is the founder list's addresses: how many of the rows are the project's own is said under them. */
export function EvidenceTable({ network, rows, own }: { network: "mainnet" | "testnet"; rows: readonly EvidenceRow[]; own: readonly string[] }) {
  const mine = rows.filter((r) => r.network === network);
  const title = network === "mainnet" ? "Mainnet (chain 1990)" : "Testnet (chain 1983)";
  return (
    <section className="stack" aria-labelledby={`ev-${network}`} data-testid={`evidence-${network}`}>
      <h2 id={`ev-${network}`} className="h-section">{title}</h2>
      {mine.length === 0 ? (
        <div className="empty" data-testid={`evidence-${network}-empty`}>
          <h3>No verified rows</h3>
          <p>No transaction on {network === "mainnet" ? "QIE mainnet" : "QIE testnet"} is recorded, so this table is empty. A row is added after a real transaction, and is then checked against the chain.</p>
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
      {mine.length > 0 ? <p data-testid={`evidence-${network}-own`}>{ownRowsSentence(network, mine.length, countOwn(mine, own))}</p> : null}
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

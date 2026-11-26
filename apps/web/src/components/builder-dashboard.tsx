"use client";
// The builder dashboard: what a builder has earned, the latest settlements and the fee in effect, read from the router, and a
// withdrawal that goes through the review step. Reading needs no wallet; withdrawing needs the builder's own wallet.
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { FlowSession, planExit } from "../lib/flows";
import { formatUsdc, isAddress, parseAmountInput, shortAddress, shortHash } from "../lib/format";
import { explorerTxUrl } from "../lib/networks";
import { readBuilder } from "../lib/reads";
import type { BuilderView } from "../lib/reads";
import { BuilderTools } from "./builder-tools";
import { FlowDialog } from "./flow-dialog";
import { useConfig, useReader, useWallet } from "./providers";
import { useFlowDeps } from "./use-flow";
import { WalletBar } from "./wallet-bar";

export function NotConfigured({ what }: { what: string }) {
  return (
    <div className="empty" data-testid="not-configured">
      <h3>Contracts not configured</h3>
      <p>
        This site has no router and vault address set, so {what} has nothing to read. The deployer sets <code>NEXT_PUBLIC_ROUTER_ADDRESS</code> and <code>NEXT_PUBLIC_VAULT_ADDRESS</code>. The addresses of a deployed router are listed on the evidence page, if there are any.
      </p>
    </div>
  );
}

export function BuilderDashboard() {
  const config = useConfig();
  const wallet = useWallet();
  const readerState = useReader();
  const reader = readerState.status === "ready" ? readerState.reader : null;
  const deps = useFlowDeps(reader);

  const [lookup, setLookup] = useState("");
  const [view, setView] = useState<BuilderView | null>(null);
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [session, setSession] = useState<FlowSession | null>(null);

  useEffect(() => {
    if (wallet.account) {
      setLookup((current) => current || (wallet.account as string));
      setTo((current) => current || (wallet.account as string));
    }
  }, [wallet.account]);

  const load = useCallback(
    async (address: string) => {
      if (!reader || !isAddress(address)) return;
      setLoading(true);
      setReadError(null);
      try {
        setView(await readBuilder(reader, address, { startBlock: config.fromBlock }));
      } catch {
        setView(null);
        setReadError("The router could not be read just now.");
      } finally {
        setLoading(false);
      }
    },
    [reader, config.fromBlock],
  );

  useEffect(() => {
    if (reader && isAddress(lookup)) void load(lookup);
  }, [reader, lookup, load]);

  const isOwnView = !!view && !!wallet.account && view.account.toLowerCase() === wallet.account.toLowerCase();

  const review = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!deps || !view) return;
    const parsed = parseAmountInput(amount, view.earnings);
    if (!parsed.ok) return setFormError(parsed.reason);
    const planned = await planExit(deps, "withdraw", parsed.units, to.trim() || deps.account).catch(() => null);
    if (!planned) return setFormError("The router could not be read to plan this withdrawal.");
    if (!planned.ok) return setFormError(planned.reason);
    setSession(new FlowSession(planned.plan, deps));
  };

  return (
    <div className="stack gap-lg">
      <WalletBar />
      {readerState.status === "unconfigured" ? <NotConfigured what="the builder dashboard" /> : null}
      {readerState.status === "error" ? (
        <p className="banner banner-error" role="alert" data-testid="reader-error">
          {readerState.message}.
        </p>
      ) : null}
      {readerState.status === "ready" || readerState.status === "loading" ? (
        <>
          <form
            className="card card-solid stack"
            onSubmit={(e) => {
              e.preventDefault();
              void load(lookup);
            }}
          >
            <div className="field">
              <label htmlFor="builder-address">Builder address</label>
              <input id="builder-address" value={lookup} onChange={(e) => setLookup(e.target.value.trim())} placeholder="0x…" autoComplete="off" spellCheck={false} inputMode="text" />
              <span className="hint">Anyone&apos;s earnings are public on the chain, so you can look up any address. Only the builder&apos;s own wallet can withdraw them.</span>
            </div>
          </form>

          {loading && !view ? <p className="muted">Reading the router…</p> : null}
          {readError ? <p className="banner banner-error" role="alert">{readError}</p> : null}

          {view ? (
            <>
              <div className="stats" data-testid="builder-stats">
                <div className="card card-solid stat">
                  <span className="stat-label">Claimable earnings</span>
                  <span className="stat-value" data-testid="earnings">{formatUsdc(view.earnings)}</span>
                  <span className="stat-note">QUSDC, settled and waiting in the router</span>
                </div>
                <div className="card card-solid stat">
                  <span className="stat-label">Fee in effect</span>
                  <span className="stat-value" data-testid="fee">{(view.feeBps / 100).toFixed(2)}%</span>
                  <span className="stat-note">Taken from the builder&apos;s side. The contract caps it at 2.00%.</span>
                </div>
                <div className="card card-solid stat">
                  <span className="stat-label">Fee recipient</span>
                  <span className="stat-value stat-small address">{shortAddress(view.feeRecipient)}</span>
                  <span className="stat-note">Credited the fee on each settlement</span>
                </div>
              </div>

              <section className="stack" aria-labelledby="recent-title">
                <h2 id="recent-title" className="h-section">Recent settlements</h2>
                {view.settlements.length === 0 ? (
                  <div className="empty" data-testid="no-settlements">
                    <h3>No settlements found</h3>
                    <p>
                      Nothing was settled to this address in the blocks read ({view.scan.fromBlock.toLocaleString("en-US")} to {view.scan.toBlock.toLocaleString("en-US")}).
                      {view.scan.reachedStart ? "" : " That is the latest stretch of the chain, not its whole history."}
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="table-wrap">
                      <table className="table" data-testid="settlements">
                        <thead>
                          <tr>
                            <th>Block</th>
                            <th>Payer</th>
                            <th>Tool id</th>
                            <th className="right">Amount (QUSDC)</th>
                            <th className="right">Fee (QUSDC)</th>
                            <th>Transaction</th>
                          </tr>
                        </thead>
                        <tbody>
                          {view.settlements.map((s) => {
                            const url = explorerTxUrl(s.txHash, config.network);
                            return (
                              <tr key={`${s.txHash}-${s.toolId}-${s.blockNumber}`}>
                                <td data-label="Block" className="num">{s.blockNumber.toLocaleString("en-US")}</td>
                                <td data-label="Payer" className="address">{shortAddress(s.payer)}</td>
                                <td data-label="Tool id" className="mono">{shortHash(s.toolId)}</td>
                                <td data-label="Amount" className="right amount">{formatUsdc(s.amount)}</td>
                                <td data-label="Fee" className="right amount">{formatUsdc(s.fee)}</td>
                                <td data-label="Transaction" className="mono">
                                  {url ? (
                                    <a className="link" href={url} rel="noopener noreferrer" target="_blank">{shortHash(s.txHash)}</a>
                                  ) : (
                                    shortHash(s.txHash)
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <p className="muted">
                      The latest {view.settlements.length} settlement{view.settlements.length === 1 ? "" : "s"} found in blocks {view.scan.fromBlock.toLocaleString("en-US")} to {view.scan.toBlock.toLocaleString("en-US")}.
                    </p>
                  </>
                )}
              </section>

              <section className="card card-solid stack" aria-labelledby="withdraw-title">
                <h2 id="withdraw-title" className="h-card">Withdraw</h2>
                <p className="muted">
                  Moves earnings from the router to an address you choose. You review the amount, the recipient and the network fee before your wallet opens.
                </p>
                <form className="stack" onSubmit={(e) => void review(e)} noValidate>
                  <div className="field-row">
                    <div className={formError ? "field field-error" : "field"}>
                      <label htmlFor="withdraw-amount">Amount (QUSDC)</label>
                      <input id="withdraw-amount" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.000000" autoComplete="off" aria-describedby="withdraw-hint" />
                      <span id="withdraw-hint" className="hint">Up to {formatUsdc(view.earnings)}.</span>
                    </div>
                    <div className="field">
                      <label htmlFor="withdraw-to">Recipient</label>
                      <input id="withdraw-to" value={to} onChange={(e) => setTo(e.target.value.trim())} placeholder="0x…" autoComplete="off" spellCheck={false} />
                    </div>
                  </div>
                  {formError ? <p className="field-error-text" role="alert" data-testid="withdraw-error">{formError}</p> : null}
                  <div className="row">
                    <button type="button" className="btn btn-soft btn-sm" onClick={() => setAmount(formatUsdc(view.earnings))} disabled={view.earnings === 0n} data-testid="withdraw-max">
                      Use the full amount
                    </button>
                    <button type="submit" className="btn btn-dark" disabled={!deps || !isOwnView || view.earnings === 0n} data-testid="withdraw-review">
                      Review withdrawal
                    </button>
                  </div>
                  {!deps ? <p className="muted">Connect your wallet on {config.network.label} to withdraw.</p> : !isOwnView ? <p className="muted">Withdrawals are made from the builder&apos;s own wallet. Connect it, or look up its address.</p> : null}
                </form>
              </section>
            </>
          ) : null}
        </>
      ) : null}
      {readerState.status === "ready" && reader ? <BuilderTools reader={reader} account={wallet.status === "connected" && wallet.network === "ok" ? wallet.account : null} deps={deps} viewing={isAddress(lookup) ? lookup : null} /> : null}
      <FlowDialog
        session={session}
        onClose={() => {
          setSession(null);
          void load(lookup);
        }}
        onRetry={(plan) => {
          if (deps) setSession(new FlowSession(plan, deps));
        }}
      />
    </div>
  );
}

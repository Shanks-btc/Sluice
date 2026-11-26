"use client";
// The demo that does something real: connect a wallet, check the network, see the balances, put a small amount in the router, pay for a
// tool call with one signed message, and follow the payment to its settlement on chain. Nothing here is simulated. Nothing is sent
// without the review dialog and its Confirm button.
//
// What it needs (src/lib/config.ts, liveMissing): the router and vault, a facilitator, and a hosted tool server. Without them it says
// what is missing and does not pretend. The network it runs on is whatever the site is set to, and the page says plainly whether the
// funds there are real.
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { DEFAULT_DEPOSIT_UNITS, liveMissing } from "../lib/config";
import { FlowSession, planDeposit } from "../lib/flows";
import type { Plan } from "../lib/flows";
import { formatQie, formatUsdc, parseAmountInput } from "../lib/format";
import { checkDepositCap, readBalances } from "../lib/live";
import type { Balances } from "../lib/live";
import { FlowDialog } from "./flow-dialog";
import { PaidCallPanel } from "./paid-call-panel";
import { useConfig, useReader, useWallet } from "./providers";
import { useFlowDeps } from "./use-flow";
import { WalletBar } from "./wallet-bar";

const DEFAULT_DEPOSIT = formatUsdc(BigInt(DEFAULT_DEPOSIT_UNITS));

export function LiveDemo() {
  const config = useConfig();
  const wallet = useWallet();
  const readerState = useReader();
  const reader = readerState.status === "ready" ? readerState.reader : null;
  const deps = useFlowDeps(reader);
  const account = wallet.status === "connected" && wallet.network === "ok" ? wallet.account : null;
  const missing = liveMissing(config);

  const [balances, setBalances] = useState<Balances | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [deposit, setDeposit] = useState(DEFAULT_DEPOSIT.replace(/0+$/, "").replace(/\.$/, ""));
  const [depositError, setDepositError] = useState<string | null>(null);
  const [session, setSession] = useState<FlowSession | null>(null);

  const load = useCallback(async () => {
    if (!reader || !account) return;
    setReadError(null);
    try {
      setBalances(await readBalances(reader, account));
    } catch {
      setBalances(null);
      setReadError("The balances could not be read just now. The page tries QIE's other nodes; try again in a moment.");
    }
  }, [reader, account]);

  useEffect(() => {
    void load();
  }, [load]);

  const reviewDeposit = async (text: string) => {
    setDepositError(null);
    if (!deps || !balances) return;
    const amount = parseAmountInput(text);
    if (!amount.ok) return setDepositError(amount.reason);
    const capped = checkDepositCap(amount.units, balances.prepaid, config.sessionCapUnits);
    if (capped) return setDepositError(capped);
    let planned;
    try {
      planned = await planDeposit(deps, amount.units);
    } catch {
      return setDepositError("The router could not be read to plan this deposit. Try again in a moment.");
    }
    if (!planned.ok) return setDepositError(planned.reason);
    setSession(new FlowSession(planned.plan, deps));
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void reviewDeposit(deposit);
  };

  const retry = (plan: Plan) => {
    if (deps) setSession(new FlowSession(plan, deps));
  };

  return (
    <div className="stack gap-lg" data-testid="live-demo">
      <div className={config.network.realFunds ? "banner banner-info" : "banner banner-info"} data-testid="live-banner">
        <strong>{config.network.label}, chain {config.chainId}.</strong>{" "}
        {config.network.realFunds
          ? "This page uses your own wallet and real QUSDC. Start small: the page will not let one session put in more than its cap."
          : "The funds on this network have no value. Use it to see how the flow works before anything real."}
      </div>

      {missing.length > 0 ? (
        <div className="empty" data-testid="live-unconfigured">
          <h3>This site is not set up for real payments yet</h3>
          <p>It still needs: {missing.join("; ")}. Nothing on this page is simulated, so without them there is nothing to run. The Sandbox tab shows the flow with no funds.</p>
        </div>
      ) : (
        <>
          <section className="stack" aria-labelledby="live-connect">
            <h2 id="live-connect" className="h-section">1. Connect</h2>
            <WalletBar />
            {readerState.status === "error" ? <p className="banner banner-error" role="alert" data-testid="reader-error">{readerState.message}.</p> : null}
          </section>

          <section className="stack" aria-labelledby="live-balances">
            <h2 id="live-balances" className="h-section">2. Your balances</h2>
            {!account ? (
              <p className="muted" data-testid="live-connect-prompt">Connect your wallet on {config.network.label} to see them.</p>
            ) : readError ? (
              <p className="banner banner-error" role="alert" data-testid="live-read-error">{readError}</p>
            ) : balances ? (
              <div className="stats" data-testid="live-balances-view">
                <div className="card card-solid stat">
                  <span className="stat-label">QUSDC in your wallet</span>
                  <span className="stat-value" data-testid="live-qusdc">{formatUsdc(balances.qusdc)}</span>
                  <span className="stat-note">Not yet in the router</span>
                </div>
                <div className="card card-solid stat">
                  <span className="stat-label">QIE for gas</span>
                  <span className="stat-value" data-testid="live-qie">{formatQie(balances.qie, 4)}</span>
                  <span className="stat-note">{balances.qie === 0n ? "None: a facilitator can send your deposit" : "Pays the network fee"}</span>
                </div>
                <div className="card card-solid stat">
                  <span className="stat-label">Prepaid in the router</span>
                  <span className="stat-value" data-testid="live-prepaid">{formatUsdc(balances.prepaid)}</span>
                  <span className="stat-note">Yours until a signed call spends it</span>
                </div>
              </div>
            ) : (
              <p className="muted">Reading your balances…</p>
            )}
          </section>

          <section className="card card-solid stack" aria-labelledby="live-deposit">
            <h2 id="live-deposit" className="h-card">3. Put a small amount in the router</h2>
            <p className="muted">
              A call is paid from your prepaid balance in the router. A deposit is two steps, an approval for exactly the amount and then the deposit. This page will not let one session put in more than {formatUsdc(BigInt(config.sessionCapUnits))} QUSDC. You can take the unspent part back at any time.
            </p>
            {balances && balances.qie === 0n && config.facilitatorUrl ? (
              <p className="banner banner-info" data-testid="zero-qie-note">
                Your wallet holds no QIE. Your wallet will sign the approval and the deposit without sending them, and the facilitator will send you exactly the QIE they need, then broadcast both. The review shows each transaction, the gas limit of each and the QIE amount the facilitator sends, before your wallet opens.
              </p>
            ) : null}
            <form className="stack" onSubmit={onSubmit} noValidate>
              <div className={depositError ? "field field-error" : "field"}>
                <label htmlFor="live-deposit-amount">Amount (QUSDC)</label>
                <input id="live-deposit-amount" value={deposit} onChange={(e) => setDeposit(e.target.value)} inputMode="decimal" autoComplete="off" data-testid="live-deposit-amount" />
              </div>
              {depositError ? <p className="field-error-text" role="alert" data-testid="live-deposit-error">{depositError}</p> : null}
              <div className="row">
                <button type="submit" className="btn btn-dark" disabled={!deps || !balances} data-testid="live-deposit-review">Review deposit</button>
              </div>
            </form>
          </section>

          <PaidCallPanel reader={reader} account={account} deps={deps} onPaid={() => void load()} title="4. Pay for a real tool call" />
        </>
      )}

      <FlowDialog
        session={session}
        onClose={() => {
          setSession(null);
          void load();
        }}
        onRetry={retry}
      />
    </div>
  );
}

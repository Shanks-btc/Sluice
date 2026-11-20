"use client";
// The payer and agent budget screen: balances, the agent keys the owner has authorised with their on-chain limits, and the flows to
// deposit, refund, authorise and revoke. Every flow goes through the review step. The page handles public addresses and the owner's
// wallet signatures. It has no field for a private key or a seed phrase, and agent session keys are made on the owner's own machine.
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { FlowSession, MAX_TOOLS, planAuthorize, planDeposit, planExit, planRevoke } from "../lib/flows";
import type { PlanResult, ToolGrant } from "../lib/flows";
import { validateFacilitatorUrl } from "../lib/facilitator";
import { formatQie, formatUsdc, formatUtc, isAddress, parseAmountInput, shortAddress } from "../lib/format";
import { readPayer } from "../lib/reads";
import type { PayerView } from "../lib/reads";
import { FlowDialog } from "./flow-dialog";
import { NotConfigured } from "./builder-dashboard";
import { useConfig, useReader, useWallet } from "./providers";
import { useFlowDeps } from "./use-flow";
import { WalletBar } from "./wallet-bar";

const DAY = 86_400;

export function PayerDashboard() {
  const config = useConfig();
  const wallet = useWallet();
  const readerState = useReader();
  const reader = readerState.status === "ready" ? readerState.reader : null;

  const [facilitatorText, setFacilitatorText] = useState(config.facilitatorUrl ?? "");
  const facilitatorCheck = facilitatorText.trim() === "" ? null : validateFacilitatorUrl(facilitatorText);
  const facilitatorUrl = facilitatorCheck?.ok ? facilitatorCheck.url : null;
  const deps = useFlowDeps(reader, facilitatorUrl);

  const [view, setView] = useState<PayerView | null>(null);
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [extraAgents, setExtraAgents] = useState<string[]>([]);
  const [session, setSession] = useState<FlowSession | null>(null);
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  const [deposit, setDeposit] = useState("");
  const [refund, setRefund] = useState("");
  const [refundTo, setRefundTo] = useState("");
  const [agent, setAgent] = useState("");
  const [budget, setBudget] = useState("");
  const [cap, setCap] = useState("");
  const [days, setDays] = useState("7");
  const [tools, setTools] = useState<ToolGrant[]>([{ payee: "", toolName: "" }]);
  const [checkAgent, setCheckAgent] = useState("");

  const account = wallet.status === "connected" && wallet.network === "ok" ? wallet.account : null;

  const load = useCallback(async () => {
    if (!reader || !account) return;
    setLoading(true);
    setReadError(null);
    try {
      setView(await readPayer(reader, account, { extraAgents, nowSeconds: Math.floor(Date.now() / 1000), startBlock: config.fromBlock }));
    } catch {
      setView(null);
      setReadError("The router and vault could not be read just now.");
    } finally {
      setLoading(false);
    }
  }, [reader, account, extraAgents, config.fromBlock]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (account) setRefundTo((current) => current || account);
  }, [account]);

  const fail = (key: string, message: string | null) => setErrors((e) => ({ ...e, [key]: message }));
  const open = (key: string, planned: PlanResult | null) => {
    if (!planned) return fail(key, "The chain could not be read to plan this.");
    if (!planned.ok) return fail(key, planned.reason);
    fail(key, null);
    if (deps) setSession(new FlowSession(planned.plan, deps));
  };

  const onDeposit = async (e: FormEvent) => {
    e.preventDefault();
    if (!deps || !view) return;
    const amount = parseAmountInput(deposit);
    if (!amount.ok) return fail("deposit", amount.reason);
    open("deposit", await planDeposit(deps, amount.units).catch(() => null));
  };

  const onRefund = async (e: FormEvent) => {
    e.preventDefault();
    if (!deps || !view) return;
    const amount = parseAmountInput(refund, view.prepaid);
    if (!amount.ok) return fail("refund", amount.reason);
    open("refund", await planExit(deps, "refund", amount.units, refundTo.trim() || deps.account).catch(() => null));
  };

  const onAuthorize = async (e: FormEvent) => {
    e.preventDefault();
    if (!deps) return;
    const b = parseAmountInput(budget);
    if (!b.ok) return fail("authorize", `Budget: ${b.reason}`);
    const c = parseAmountInput(cap);
    if (!c.ok) return fail("authorize", `Cap per call: ${c.reason}`);
    if (!/^\d{1,4}$/.test(days) || Number(days) < 1 || Number(days) > 3650) return fail("authorize", "Days until expiry: enter a whole number from 1 to 3650.");
    const expiry = Math.floor(Date.now() / 1000) + Number(days) * DAY;
    open("authorize", await planAuthorize(deps, { agent: agent.trim(), budget: b.units, perCallCap: c.units, expiry, tools }).catch(() => null));
  };

  const onRevoke = async (address: string) => {
    if (!deps) return;
    open("revoke", await planRevoke(deps, address).catch(() => null));
  };

  const updateTool = (i: number, patch: Partial<ToolGrant>) => setTools((list) => list.map((t, k) => (k === i ? { ...t, ...patch } : t)));

  return (
    <div className="stack gap-lg">
      <WalletBar />
      {readerState.status === "unconfigured" ? <NotConfigured what="the budget screen" /> : null}
      {readerState.status === "error" ? <p className="banner banner-error" role="alert" data-testid="reader-error">{readerState.message}.</p> : null}

      {readerState.status === "ready" && !account ? (
        <div className="empty" data-testid="connect-prompt">
          <h3>Connect your wallet</h3>
          <p>The balances, the agent keys and the actions on this page belong to one wallet. Connect it on {config.network.label} to see them.</p>
        </div>
      ) : null}

      {readerState.status === "ready" && account ? (
        <>
          {readError ? <p className="banner banner-error" role="alert">{readError}</p> : null}
          {loading && !view ? <p className="muted">Reading the router and vault…</p> : null}
          {view ? (
            <div className="stats" data-testid="payer-stats">
              <div className="card card-solid stat">
                <span className="stat-label">QUSDC in your wallet</span>
                <span className="stat-value" data-testid="wallet-qusdc">{formatUsdc(view.qusdcBalance)}</span>
                <span className="stat-note">Not yet deposited</span>
              </div>
              <div className="card card-solid stat">
                <span className="stat-label">Prepaid in the router</span>
                <span className="stat-value" data-testid="prepaid">{formatUsdc(view.prepaid)}</span>
                <span className="stat-note">Yours until a signed call spends it</span>
              </div>
              <div className="card card-solid stat">
                <span className="stat-label">QIE for gas</span>
                <span className="stat-value" data-testid="qie">{formatQie(view.qieBalance, 4)}</span>
                <span className="stat-note">{view.qieBalance === 0n ? "None: a facilitator can send your transactions" : "Pays the network fee"}</span>
              </div>
            </div>
          ) : null}

          <section className="card card-solid stack" aria-labelledby="facilitator-title">
            <h2 id="facilitator-title" className="h-card">Facilitator</h2>
            <p className="muted">
              A wallet with no QIE cannot send a transaction. A facilitator can send it for you, and pays the gas. Set the address of one you trust; it is used only when your wallet has no QIE.
            </p>
            <div className={facilitatorCheck && !facilitatorCheck.ok ? "field field-error" : "field"}>
              <label htmlFor="facilitator-url">Facilitator address</label>
              <input id="facilitator-url" value={facilitatorText} onChange={(e) => setFacilitatorText(e.target.value)} placeholder="https://…" autoComplete="off" spellCheck={false} />
              {facilitatorCheck && !facilitatorCheck.ok ? <span className="field-error-text">{facilitatorCheck.reason}</span> : <span className="hint">Optional. Leave empty to use only your own QIE.</span>}
            </div>
          </section>

          <section className="card card-solid stack" aria-labelledby="deposit-title">
            <h2 id="deposit-title" className="h-card">Deposit</h2>
            <p className="muted">
              QUSDC has no permit function, so a deposit is two steps: approve exactly the amount, then deposit it. If your wallet holds QUSDC and no QIE, a facilitator can send both and top up exactly the gas they need (the review shows how).
            </p>
            <form className="stack" onSubmit={(e) => void onDeposit(e)} noValidate>
              <div className={errors.deposit ? "field field-error" : "field"}>
                <label htmlFor="deposit-amount">Amount (QUSDC)</label>
                <input id="deposit-amount" value={deposit} onChange={(e) => setDeposit(e.target.value)} inputMode="decimal" placeholder="0.000000" autoComplete="off" />
              </div>
              {errors.deposit ? <p className="field-error-text" role="alert" data-testid="deposit-error">{errors.deposit}</p> : null}
              <div className="row">
                <button type="submit" className="btn btn-dark" disabled={!deps} data-testid="deposit-review">Review deposit</button>
              </div>
            </form>
          </section>

          <section className="card card-solid stack" aria-labelledby="refund-title">
            <h2 id="refund-title" className="h-card">Refund unspent balance</h2>
            <p className="muted">Takes prepaid QUSDC back out of the router. There is no delay and no one to ask.</p>
            <form className="stack" onSubmit={(e) => void onRefund(e)} noValidate>
              <div className="field-row">
                <div className={errors.refund ? "field field-error" : "field"}>
                  <label htmlFor="refund-amount">Amount (QUSDC)</label>
                  <input id="refund-amount" value={refund} onChange={(e) => setRefund(e.target.value)} inputMode="decimal" placeholder="0.000000" autoComplete="off" />
                  {view ? <span className="hint">Up to {formatUsdc(view.prepaid)}.</span> : null}
                </div>
                <div className="field">
                  <label htmlFor="refund-to">Recipient</label>
                  <input id="refund-to" value={refundTo} onChange={(e) => setRefundTo(e.target.value.trim())} placeholder="0x…" autoComplete="off" spellCheck={false} />
                </div>
              </div>
              {errors.refund ? <p className="field-error-text" role="alert" data-testid="refund-error">{errors.refund}</p> : null}
              <div className="row">
                <button type="submit" className="btn btn-dark" disabled={!deps || !view || view.prepaid === 0n} data-testid="refund-review">Review refund</button>
              </div>
            </form>
          </section>

          <section className="stack" aria-labelledby="sessions-title">
            <h2 id="sessions-title" className="h-section">Agent keys</h2>
            <p className="muted">
              Each key can spend only inside the limits you set, which the vault enforces on chain. The keys themselves are made by the proxy or the wallet MCP on your machine; this page only ever sees their public addresses.
            </p>
            {view && view.sessions.length === 0 ? (
              <div className="empty" data-testid="no-sessions">
                <h3>No agent keys authorised</h3>
                <p>Authorise one below, or look up an address you already authorised. The latest {view.scan.toBlock - view.scan.fromBlock + 1} blocks were searched.</p>
              </div>
            ) : null}
            {view && view.sessions.length > 0 ? (
              <div className="table-wrap">
                <table className="table" data-testid="sessions">
                  <thead>
                    <tr>
                      <th>Agent key</th>
                      <th>State</th>
                      <th className="right">Budget</th>
                      <th className="right">Spent</th>
                      <th className="right">Left</th>
                      <th className="right">Cap per call</th>
                      <th>Expires</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.sessions.map((s) => (
                      <tr key={s.agent}>
                        <td data-label="Agent key" className="address">{shortAddress(s.agent)}</td>
                        <td data-label="State"><span className={s.status === "active" ? "tag tag-success" : "tag tag-warn"}>{s.status}</span></td>
                        <td data-label="Budget" className="right amount">{formatUsdc(s.budget)}</td>
                        <td data-label="Spent" className="right amount">{formatUsdc(s.spent)}</td>
                        <td data-label="Left" className="right amount">{formatUsdc(s.remaining)}</td>
                        <td data-label="Cap per call" className="right amount">{formatUsdc(s.perCallCap)}</td>
                        <td data-label="Expires" className="mono">{formatUtc(s.expiry)}</td>
                        <td data-label="Action">
                          <button type="button" className="btn btn-soft btn-sm" onClick={() => void onRevoke(s.agent)} disabled={!deps} data-testid={`revoke-${s.agent}`}>Revoke</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {errors.revoke ? <p className="field-error-text" role="alert" data-testid="revoke-error">{errors.revoke}</p> : null}
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                if (isAddress(checkAgent)) setExtraAgents((list) => (list.includes(checkAgent) ? list : [...list, checkAgent]));
              }}
            >
              <div className="field grow">
                <label htmlFor="check-agent">Look up an agent address</label>
                <input id="check-agent" value={checkAgent} onChange={(e) => setCheckAgent(e.target.value.trim())} placeholder="0x…" autoComplete="off" spellCheck={false} />
              </div>
              <button type="submit" className="btn btn-soft btn-sm" disabled={!isAddress(checkAgent)}>Look up</button>
            </form>
          </section>

          <section className="card card-solid stack" aria-labelledby="authorize-title">
            <h2 id="authorize-title" className="h-card">Authorise an agent key</h2>
            <p className="muted">
              Sets a budget, a cap per call, an expiry and the tools the key may pay for. The key cannot raise its own limits; only this wallet can change them. Enter the key&apos;s public address only.
            </p>
            <form className="stack" onSubmit={(e) => void onAuthorize(e)} noValidate>
              <div className="field">
                <label htmlFor="agent-address">Agent key address</label>
                <input id="agent-address" value={agent} onChange={(e) => setAgent(e.target.value.trim())} placeholder="0x…" autoComplete="off" spellCheck={false} />
              </div>
              <div className="field-row">
                <div className="field">
                  <label htmlFor="agent-budget">Budget (QUSDC)</label>
                  <input id="agent-budget" value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" placeholder="5.000000" autoComplete="off" />
                </div>
                <div className="field">
                  <label htmlFor="agent-cap">Cap per call (QUSDC)</label>
                  <input id="agent-cap" value={cap} onChange={(e) => setCap(e.target.value)} inputMode="decimal" placeholder="0.050000" autoComplete="off" />
                </div>
                <div className="field">
                  <label htmlFor="agent-days">Days until expiry</label>
                  <input id="agent-days" value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" autoComplete="off" />
                </div>
              </div>
              <fieldset className="stack tools">
                <legend className="label">Tools the key may pay for</legend>
                {tools.map((t, i) => (
                  <div key={i} className="field-row tool-row">
                    <div className="field">
                      <label htmlFor={`tool-payee-${i}`}>Payee address</label>
                      <input id={`tool-payee-${i}`} value={t.payee} onChange={(e) => updateTool(i, { payee: e.target.value.trim() })} placeholder="0x…" autoComplete="off" spellCheck={false} />
                    </div>
                    <div className="field">
                      <label htmlFor={`tool-name-${i}`}>Tool name</label>
                      <input id={`tool-name-${i}`} value={t.toolName} onChange={(e) => updateTool(i, { toolName: e.target.value })} placeholder="token_risk_check" autoComplete="off" disabled={t.anyTool === true} />
                    </div>
                    <div className="tool-actions">
                      <label className="check">
                        <input type="checkbox" checked={t.anyTool === true} onChange={(e) => updateTool(i, { anyTool: e.target.checked })} />
                        <span>Any tool from this payee</span>
                      </label>
                      {tools.length > 1 ? (
                        <button type="button" className="btn btn-soft btn-sm" onClick={() => setTools((l) => l.filter((_, k) => k !== i))}>Remove</button>
                      ) : null}
                    </div>
                  </div>
                ))}
                <div>
                  <button type="button" className="btn btn-soft btn-sm" onClick={() => setTools((l) => [...l, { payee: "", toolName: "" }])} disabled={tools.length >= MAX_TOOLS}>Add a tool</button>
                </div>
              </fieldset>
              {errors.authorize ? <p className="field-error-text" role="alert" data-testid="authorize-error">{errors.authorize}</p> : null}
              <div className="row">
                <button type="submit" className="btn btn-dark" disabled={!deps} data-testid="authorize-review">Review authorisation</button>
              </div>
            </form>
          </section>
        </>
      ) : null}

      <FlowDialog
        session={session}
        onClose={() => {
          setSession(null);
          void load();
        }}
      />
    </div>
  );
}

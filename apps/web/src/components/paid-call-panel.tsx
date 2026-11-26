"use client";
// Pay for one real tool call from the connected wallet, and follow it until it settles on chain. Used by the live demo and by the
// builder's "test your tool" button. It never signs by itself: every call goes through the review dialog and its Confirm button.
//
// A payment that was sent is kept in this browser (id, tool, amount, payer, nonce: src/lib/resume.ts) until it is seen settled, so a
// refresh in the middle picks it up again. The facilitator and the chain say where it stands; the browser's record never does.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { explain } from "../lib/errors";
import type { Explained } from "../lib/errors";
import type { FlowDeps } from "../lib/flows";
import { formatUsdc, formatUtc, shortAddress, shortHash } from "../lib/format";
import { defaultArgs, parseToolArgs, showOutput } from "../lib/live";
import { PaidCallSession, checkSettlement, describeIntent, planPaidCall, readToolServer, trackSettlement } from "../lib/paid-call";
import type { PaidCallDeps, PaidCallPlan, PaidCallResult, SettlementView, ToolServerRead } from "../lib/paid-call";
import { addInflight, loadInflight, looksDuplicate, removeInflight } from "../lib/resume";
import type { ChainReader } from "../lib/reads";
import { PaidCallDialog } from "./paid-call-dialog";
import { useConfig } from "./providers";

type Entry = {
  key: string;
  tool: string;
  amount: bigint;
  payer: string;
  nonce: string;
  intentId?: string;
  /** Present for a call made in this page's life; a resumed one has no answer to show. */
  result?: PaidCallResult;
  view: SettlementView;
  resumed: boolean;
};

const nowSeconds = () => Math.floor(Date.now() / 1000);
const store = () => {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
};

export function SettlementLine({ view, onCheck }: { view: SettlementView; onCheck?: () => void }) {
  return (
    <div className="stack" data-testid="settlement">
      {view.state === "settled" ? (
        <>
          <p>
            <span className="tag tag-success" data-testid="settlement-status">Settled on chain</span>
          </p>
          <dl className="kv" data-testid="receipt">
            <div><dt>Transaction</dt><dd className="mono">{view.receipt.explorerUrl ? <a className="link" href={view.receipt.explorerUrl} rel="noopener noreferrer" target="_blank">{shortHash(view.receipt.transaction)}</a> : shortHash(view.receipt.transaction)}</dd></div>
            <div><dt>Block</dt><dd className="mono">{view.receipt.blockNumber.toLocaleString("en-US")}{view.receipt.timestamp ? `, ${formatUtc(view.receipt.timestamp)}` : ""}</dd></div>
            <div><dt>Paid</dt><dd>{formatUsdc(view.receipt.amount)} QUSDC from {shortAddress(view.receipt.payer)} to {shortAddress(view.receipt.payee)}</dd></div>
            <div><dt>Fee taken from the builder&apos;s side</dt><dd>{formatUsdc(view.receipt.fee)} QUSDC</dd></div>
            <div><dt>Tool id</dt><dd className="mono">{shortHash(view.receipt.toolId)}</dd></div>
          </dl>
          <p className="muted">This receipt is built from the router&apos;s own Settled event, not from what the facilitator said.</p>
        </>
      ) : view.state === "pending" ? (
        <p>
          <span className="tag tag-info" data-testid="settlement-status">Settling: {view.status}</span> The facilitator settles in batches, usually within a minute.
          {onCheck ? <> <button type="button" className="btn btn-soft btn-sm" onClick={onCheck} data-testid="settlement-check">Check again</button></> : null}
        </p>
      ) : view.state === "not_settled" ? (
        <p className="banner banner-error" role="alert" data-testid="settlement-status">
          The payment was not settled: {view.status}{view.reason ? ` (${view.reason})` : ""}. You were not charged for a settlement that did not happen; check your balance.
        </p>
      ) : (
        <p>
          <span className="tag" data-testid="settlement-status">Not known</span> {view.reason} {onCheck ? <button type="button" className="btn btn-soft btn-sm" onClick={onCheck}>Check again</button> : null}
        </p>
      )}
    </div>
  );
}

export function PaidCallPanel({
  reader,
  account,
  deps,
  onPaid,
  title = "Pay for a real tool call",
  intro,
  initialTool,
}: {
  reader: ChainReader | null;
  account: string | null;
  deps: FlowDeps | null;
  /** Called after a payment is accepted, so the page can read its balances again. */
  onPaid?: () => void;
  title?: string;
  intro?: string;
  initialTool?: string;
}) {
  const config = useConfig();
  const [server, setServer] = useState<ToolServerRead | "loading" | "unconfigured">(config.toolsUrl ? "loading" : "unconfigured");
  const [tool, setTool] = useState<string>(initialTool ?? "");
  const [argsText, setArgsText] = useState("");
  const [argsTouched, setArgsTouched] = useState(false);
  const [problem, setProblem] = useState<Explained | { headline: string; advice: string } | null>(null);
  const [session, setSession] = useState<PaidCallSession | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const paidDeps: PaidCallDeps | null = useMemo(
    () => (deps && config.toolsUrl ? { ...deps, toolsUrl: config.toolsUrl, sessionCapUnits: config.sessionCapUnits, network: config.network } : null),
    [deps, config.toolsUrl, config.sessionCapUnits, config.network],
  );

  const loadServer = useCallback(async () => {
    if (!config.toolsUrl || !reader) return;
    setServer("loading");
    const read = await readToolServer(config.toolsUrl, { chainId: config.chainId, router: reader.routerAddress });
    if (!alive.current) return;
    setServer(read);
    if (read.ok) {
      setTool((t) => (t && read.info.tools.some((x) => x.name === t) ? t : (read.info.tools[0]?.name ?? "")));
    }
  }, [config.toolsUrl, config.chainId, reader]);

  useEffect(() => {
    void loadServer();
  }, [loadServer]);

  useEffect(() => {
    if (reader && tool && !argsTouched) setArgsText(defaultArgs(tool, reader.tokenAddress));
  }, [reader, tool, argsTouched]);

  const update = useCallback((key: string, view: SettlementView) => {
    if (!alive.current) return;
    setEntries((list) => list.map((e) => (e.key === key ? { ...e, view } : e)));
  }, []);

  const follow = useCallback(
    async (e: Entry) => {
      if (!e.intentId || !paidDeps) return;
      const view = await trackSettlement(paidDeps, e.intentId, e.nonce, e.payer, { onUpdate: (v) => update(e.key, v) });
      update(e.key, view);
      if (view.state === "settled" || view.state === "not_settled") removeInflight(store(), e.intentId, nowSeconds());
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [paidDeps?.reader, paidDeps?.facilitatorUrl, update],
  );

  // A refresh in the middle of a flow: payments this browser sent and has not seen settled are looked up again.
  const resumedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!account || !paidDeps || resumedFor.current === account) return;
    resumedFor.current = account;
    const found = loadInflight(store(), nowSeconds(), account);
    if (found.length === 0) return;
    const resumed: Entry[] = found.map((r) => ({ key: r.id, tool: r.tool, amount: BigInt(r.amount), payer: r.payer, nonce: r.nonce, intentId: r.id, view: { state: "pending", status: "looking it up" }, resumed: true }));
    setEntries((list) => [...resumed.filter((r) => !list.some((l) => l.key === r.key)), ...list]);
    for (const r of resumed) void follow(r);
  }, [account, paidDeps, follow]);

  const review = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    if (!paidDeps || server === "loading" || server === "unconfigured" || !server.ok) return;
    const parsed = parseToolArgs(argsText);
    if (!parsed.ok) return setProblem({ headline: parsed.reason, advice: "Fix the arguments and review again." });
    let planned;
    try {
      planned = await planPaidCall(paidDeps, server.info, tool, parsed.args);
    } catch (err) {
      return setProblem(explain(err));
    }
    if (!planned.ok) return setProblem({ headline: planned.reason, advice: planned.kind === "insufficient_prepaid" ? "Use the deposit step above, then review again." : "Nothing was signed." });
    const dup = looksDuplicate(loadInflight(store(), nowSeconds(), account ?? undefined), tool, account ?? "", nowSeconds());
    const plan: PaidCallPlan = dup ? { ...planned.plan, warnings: [`A payment for this tool was sent less than a minute ago and has not settled yet. Pay again only if you mean to make a second call.`, ...planned.plan.warnings] } : planned.plan;
    setSession(new PaidCallSession(plan, paidDeps));
  };

  const accepted = (result: PaidCallResult, plan: PaidCallPlan) => {
    const entry: Entry = { key: result.intentId ?? plan.intent.nonce, tool: result.tool, amount: result.amount, payer: result.payer, nonce: plan.intent.nonce, intentId: result.intentId, result, view: { state: "pending", status: result.status ?? "queued" }, resumed: false };
    setEntries((list) => [entry, ...list.filter((l) => l.key !== entry.key)]);
    if (result.intentId) addInflight(store(), { id: result.intentId, tool: result.tool, amount: result.amount.toString(), payer: result.payer, nonce: plan.intent.nonce, createdAt: nowSeconds() }, nowSeconds());
    onPaid?.();
    void follow(entry);
  };

  const connected = Boolean(account && deps);
  const ready = server !== "loading" && server !== "unconfigured" && server.ok;
  const selected = ready ? server.info.tools.find((t) => t.name === tool) : undefined;

  return (
    <section className="card card-solid stack" aria-labelledby="paid-title" data-testid="paid-panel">
      <h2 id="paid-title" className="h-card">{title}</h2>
      <p className="muted">{intro ?? "The tool server prices each call. You review the payment, your wallet signs one message, the tool runs, and the facilitator settles the payment on chain."}</p>
      {server === "unconfigured" ? (
        <p className="banner banner-info" data-testid="tools-unconfigured">No tool server is set on this site (NEXT_PUBLIC_TOOLS_URL), so there is nothing to pay here yet.</p>
      ) : server === "loading" ? (
        <p className="muted" data-testid="tools-loading">Reading the tool server…</p>
      ) : !server.ok ? (
        <div className="stack">
          <p className="banner banner-error" role="alert" data-testid="tools-error">{server.reason}{server.down ? " Nothing was paid. See the Status page, and try again in a minute." : ""}</p>
          <div><button type="button" className="btn btn-soft btn-sm" onClick={() => void loadServer()} data-testid="tools-retry">Try again</button></div>
        </div>
      ) : (
        <form className="stack" onSubmit={(e) => void review(e)} noValidate>
          <div className="field">
            <label htmlFor="tool-select">Tool</label>
            <select id="tool-select" value={tool} onChange={(e) => { setTool(e.target.value); setArgsTouched(false); }} data-testid="tool-select">
              {server.info.tools.map((t) => (
                <option key={t.name} value={t.name}>{t.name}: {t.price} QUSDC</option>
              ))}
            </select>
            <span className="hint">Prices are the builder&apos;s. The price is read again, and checked, when you review.</span>
          </div>
          <div className="field">
            <label htmlFor="tool-args">Arguments (JSON)</label>
            <textarea id="tool-args" rows={3} value={argsText} onChange={(e) => { setArgsText(e.target.value); setArgsTouched(true); }} spellCheck={false} autoComplete="off" data-testid="tool-args" />
          </div>
          {problem ? (
            <p className="banner banner-error" role="alert" data-testid="pay-error">
              <strong>{problem.headline}</strong> {problem.advice}
            </p>
          ) : null}
          <div className="row">
            <button type="submit" className="btn btn-dark" disabled={!connected || !selected} data-testid="pay-review">
              {selected ? `Review payment of ${selected.price} QUSDC` : "Review payment"}
            </button>
            {!connected ? <span className="muted">Connect your wallet on {config.network.label} first.</span> : null}
          </div>
        </form>
      )}

      {entries.length > 0 ? (
        <div className="stack" data-testid="paid-results">
          <h3>Your calls</h3>
          {entries.map((e) => (
            <article key={e.key} className="card card-sm stack" data-testid="paid-result">
              <p>
                <strong>{e.tool.replace(/_/g, " ")}</strong>, {formatUsdc(e.amount)} QUSDC{e.resumed ? " (picked up again after a reload)" : ""}
                {e.intentId ? <span className="muted"> · intent <span className="mono">{shortHash(e.intentId)}</span></span> : null}
              </p>
              {e.result ? (
                <>
                  {/* A box that scrolls has to be reachable from the keyboard, or a long answer cannot be read without a mouse. */}
                  {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
                  <pre className="code code-scroll" tabIndex={0} aria-label="What the tool returned" data-testid="pay-output">{showOutput(e.result.output)}</pre>
                  <details>
                    <summary>What you signed</summary>
                    <dl className="kv">
                      {describeIntent(e.result.intent).map((f) => (
                        <div key={f.label}><dt>{f.label}</dt><dd className="mono">{f.value}</dd></div>
                      ))}
                      <div><dt>Signature</dt><dd className="mono" data-testid="pay-signature">{shortHash(e.result.signature.slice(0, 66))}…</dd></div>
                      {e.result.requestId ? <div><dt>Request id</dt><dd className="mono">{e.result.requestId}</dd></div> : null}
                    </dl>
                  </details>
                </>
              ) : null}
              <SettlementLine
                view={e.view}
                onCheck={
                  e.intentId && paidDeps
                    ? () => {
                        void checkSettlement(paidDeps, e.intentId as string, e.nonce, e.payer).then((v) => {
                          update(e.key, v);
                          // A payment this check shows as finished is no longer in flight: it must not come back after the next reload.
                          if (v.state === "settled" || v.state === "not_settled") removeInflight(store(), e.intentId as string, nowSeconds());
                        });
                      }
                    : undefined
                }
              />
            </article>
          ))}
        </div>
      ) : null}

      <PaidCallDialog session={session} onClose={() => setSession(null)} onPaid={accepted} onRetry={(plan) => { void (async () => { if (paidDeps && server !== "loading" && server !== "unconfigured" && server.ok) { const again = await planPaidCall(paidDeps, server.info, plan.quote.tool, plan.args).catch(() => null); if (again?.ok) setSession(new PaidCallSession(again.plan, paidDeps)); else setProblem({ headline: again ? again.reason : "The tool server did not answer.", advice: "Nothing was signed." }); } })(); }} />
    </section>
  );
}

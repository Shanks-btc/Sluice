"use client";
// "Connect to a Sluice facilitator": paste a facilitator's address and read its /health and /status. It reads and nothing else: no
// payment is made from this panel. The network is chosen by the person, starts on "Local" and never on mainnet, and is named on
// the panel wherever it matters.
import { useState } from "react";
import { getHealth, getStatus, targetWarning, validateFacilitatorUrl } from "../lib/facilitator";
import type { HealthView, StatusView } from "../lib/facilitator";
import { formatQie, shortAddress } from "../lib/format";
import { NETWORKS } from "../lib/networks";
import type { NetworkId } from "../lib/networks";
import { useConfig } from "./providers";

const ORDER: NetworkId[] = ["local", "testnet", "mainnet"];

export function FacilitatorPanel() {
  const config = useConfig();
  const [target, setTarget] = useState<NetworkId>("local");
  const [text, setText] = useState(config.facilitatorUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthView | null>(null);
  const [intent, setIntent] = useState("");
  const [status, setStatus] = useState<StatusView | null>(null);
  const [statusProblem, setStatusProblem] = useState<string | null>(null);

  const check = validateFacilitatorUrl(text);
  const network = NETWORKS[target];
  const warning = check.ok ? targetWarning(target, check.url) : undefined;
  const chainNote = health?.chainId !== undefined && health.chainId !== network.chainId ? `The facilitator reports chain ${health.chainId}, not ${network.chainId}.` : undefined;

  const readHealth = async () => {
    if (!check.ok) return setProblem(check.reason);
    setBusy(true);
    setProblem(null);
    setHealth(null);
    const res = await getHealth(check.url);
    setBusy(false);
    if (res.ok) setHealth(res.health);
    else setProblem(res.reason);
  };

  const readStatus = async () => {
    if (!check.ok) return setStatusProblem(check.reason);
    setStatus(null);
    setStatusProblem(null);
    const res = await getStatus(check.url, intent);
    if (res.ok) setStatus(res.status);
    else setStatusProblem(res.reason);
  };

  return (
    <div className="card card-solid stack" data-testid="facilitator-panel">
      <h3 className="h-card">Connect to a Sluice facilitator</h3>
      <p className="muted">Paste the address of a facilitator to read its health and the state of an intent. This panel only reads. It sends no payment and holds no key.</p>

      <fieldset className="stack networks">
        <legend className="label">Network you are checking</legend>
        <div className="seg" role="radiogroup" aria-label="Network">
          {ORDER.map((id) => (
            <button key={id} type="button" role="radio" aria-checked={target === id} onClick={() => setTarget(id)} data-testid={`target-${id}`}>
              {NETWORKS[id].label}
              {id !== "local" ? ` (${NETWORKS[id].chainId})` : ""}
            </button>
          ))}
        </div>
        <p className={network.realFunds ? "banner" : "banner banner-info"} data-testid="target-note">
          <span className={network.realFunds ? "tag tag-warn" : "tag tag-info"}>{network.realFunds ? "Real funds" : "No real funds"}</span>
          <span>
            {network.label}, chain {network.chainId}. {network.note}
          </span>
        </p>
      </fieldset>

      <div className={text && !check.ok ? "field field-error" : "field"}>
        <label htmlFor="fac-url">Facilitator address</label>
        <input id="fac-url" value={text} onChange={(e) => setText(e.target.value)} placeholder="http://127.0.0.1:8402" autoComplete="off" spellCheck={false} />
        {text && !check.ok ? <span className="field-error-text">{check.reason}</span> : <span className="hint">An https address, or an http address on this machine.</span>}
      </div>
      {warning ? <p className="banner banner-info" role="status">{warning}</p> : null}
      <div className="row">
        <button type="button" className="btn btn-dark" onClick={() => void readHealth()} disabled={busy || !check.ok} data-testid="fac-health">
          {busy ? "Reading…" : "Read /health"}
        </button>
      </div>
      {problem ? <p className="banner banner-error" role="alert" data-testid="fac-problem">{problem}</p> : null}
      {chainNote ? <p className="banner banner-error" role="alert">{chainNote}</p> : null}
      {health ? (
        <dl className="kv" data-testid="fac-result">
          <div><dt>Chain</dt><dd>{health.chainId ?? "not reported"}</dd></div>
          <div><dt>Router</dt><dd>{health.router ?? "not reported"}</dd></div>
          <div><dt>Vault</dt><dd>{health.vault ?? "not reported"}</dd></div>
          <div><dt>Relayer</dt><dd>{health.relayer ? shortAddress(health.relayer) : "not reported"}</dd></div>
          <div><dt>Relayer balance</dt><dd>{health.relayerBalanceWei ? `${formatQie(BigInt(health.relayerBalanceWei))} QIE` : "not reported"}</dd></div>
          <div><dt>Gas budget today</dt><dd>{health.budgetWei && health.spentWei ? `${formatQie(BigInt(health.spentWei))} of ${formatQie(BigInt(health.budgetWei))} QIE spent` : "not reported"}</dd></div>
          <div><dt>Queued intents</dt><dd>{health.queued ?? "not reported"}</dd></div>
          <div><dt>Alerts</dt><dd>{health.alerts.length === 0 ? "none" : health.alerts.join(", ")}</dd></div>
        </dl>
      ) : null}

      <div className="field">
        <label htmlFor="fac-intent">Intent id</label>
        <input id="fac-intent" value={intent} onChange={(e) => setIntent(e.target.value.trim())} placeholder="0x… (64 hex characters)" autoComplete="off" spellCheck={false} />
      </div>
      <div className="row">
        <button type="button" className="btn btn-soft" onClick={() => void readStatus()} disabled={!check.ok || intent === ""} data-testid="fac-status">
          Read /status
        </button>
      </div>
      {statusProblem ? <p className="field-error-text" role="alert" data-testid="fac-status-problem">{statusProblem}</p> : null}
      {status ? (
        <dl className="kv" data-testid="fac-status-result">
          <div><dt>State</dt><dd>{status.status}</dd></div>
          <div><dt>Transaction</dt><dd>{status.transaction ?? "none yet"}</dd></div>
          <div><dt>Block</dt><dd>{status.blockNumber ?? "none yet"}</dd></div>
          {status.reason ? <div><dt>Reason</dt><dd>{status.reason}</dd></div> : null}
        </dl>
      ) : null}
    </div>
  );
}

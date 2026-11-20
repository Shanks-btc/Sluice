"use client";
// The risk check: the same read-only token_risk_check logic as the paid example tool, run for a pasted token address through the
// site's own server route. The default example is the real QUSDC, whose finding comes from chain data when the button is pressed.
import { useState } from "react";
import type { Flag, RoleInfo, TokenRisk } from "@sluice/paid-tools/tokenRisk";
import { QUSDC_ADDRESS } from "@sluice/sdk/protocol";
import { shortAddress } from "../lib/format";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export type RiskOutcome = { ok: true; result: TokenRisk } | { ok: false; message: string };

/** Turns the route's answer into something to show. Never shows an upstream message. */
export function readRiskResponse(status: number, body: unknown): RiskOutcome {
  const b = (typeof body === "object" && body !== null ? body : {}) as { ok?: unknown; result?: unknown; error?: unknown; retryAfterSeconds?: unknown };
  if (status === 200 && b.ok === true && typeof b.result === "object" && b.result !== null) return { ok: true, result: b.result as TokenRisk };
  if (status === 429) {
    const wait = typeof b.retryAfterSeconds === "number" ? b.retryAfterSeconds : 60;
    return { ok: false, message: `Too many checks just now. Try again in ${wait} seconds.` };
  }
  if (b.error === "invalid_address") return { ok: false, message: "That is not a token address. Use 0x followed by 40 hex characters." };
  if (status === 504) return { ok: false, message: "The check took too long. The chain's RPC may be slow; try again." };
  return { ok: false, message: "The check could not be completed. Try again in a moment." };
}

const severityClass = (s: Flag["severity"]) => (s === "high" ? "tag tag-error" : s === "medium" ? "tag tag-warn" : "tag tag-info");

function Roles({ roles }: { roles: RoleInfo[] }) {
  if (roles.length === 0) return null;
  return (
    <ul className="stack roles">
      {roles.map((r) => (
        <li key={r.id}>
          <strong>{r.name ?? shortAddress(r.id)}</strong>
          {r.adminRoleName ? <span className="muted"> (managed by {r.adminRoleName})</span> : null}
          <ul>
            {r.holders.map((h) => (
              <li key={h.address} className="mono">
                {h.address} <span className="muted">{h.kind}</span>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

export function RiskResult({ risk }: { risk: TokenRisk }) {
  return (
    <div className="stack" data-testid="risk-result">
      <p>
        <strong>{risk.token?.name ?? "Token"}</strong> {risk.token?.symbol ? <span className="muted">({risk.token.symbol})</span> : null}
        <span className="mono muted"> {risk.address}</span>
      </p>
      {risk.flags.length > 0 ? (
        <ul className="stack flags" data-testid="risk-flags">
          {risk.flags.map((f) => (
            <li key={f.code} className="flag">
              <span className={severityClass(f.severity)}>{f.severity}</span> <span>{f.text}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No flags were raised. That is not a clean bill of health; see the limits below.</p>
      )}
      {risk.accessControl.present ? (
        <div className="stack">
          <h4>Roles and who holds them</h4>
          <Roles roles={risk.accessControl.roles} />
        </div>
      ) : null}
      {risk.burn.canBurnNow.length > 0 || risk.burn.viaRoleAdmin.length > 0 ? (
        <div className="stack" data-testid="risk-burn">
          <h4>Who can burn a holder&apos;s tokens</h4>
          <ul>
            {risk.burn.canBurnNow.map((b) => (
              <li key={`${b.address}-${b.via}`} className="mono">
                {b.address} <span className="muted">{b.kind}, through {b.via}</span>
              </li>
            ))}
            {risk.burn.viaRoleAdmin.map((a) => (
              <li key={`${a.role}-${a.adminRole}`}>
                <span className="muted">{a.role} can be granted by {a.adminRole}, held by</span>{" "}
                {a.adminHolders.map((h) => (
                  <span key={h.address} className="mono">{h.address} </span>
                ))}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="stack">
        <h4>What this check cannot see</h4>
        <ul>
          {risk.limits.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        <p className="muted">{risk.disclaimer}</p>
      </div>
    </div>
  );
}

export function RiskPanel() {
  const [address, setAddress] = useState<string>(QUSDC_ADDRESS);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<RiskOutcome | null>(null);
  const valid = ADDRESS.test(address);

  const run = async () => {
    if (!valid) return setOutcome({ ok: false, message: "That is not a token address. Use 0x followed by 40 hex characters." });
    setBusy(true);
    setOutcome(null);
    try {
      const res = await fetch("/api/risk", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address }), credentials: "omit" });
      setOutcome(readRiskResponse(res.status, await res.json().catch(() => ({}))));
    } catch {
      setOutcome({ ok: false, message: "The check could not be reached. Try again in a moment." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card card-solid stack" data-testid="risk-panel">
      <h3 className="h-card">Risk check for a token</h3>
      <p className="muted">
        Reads a token on QIE mainnet and reports what its admin can do to holders: proxy, owner, roles, and who can burn or mint. It is the same read-only logic as the paid example tool. It sends nothing, and it is not a security review.
      </p>
      <div className={address && !valid ? "field field-error" : "field"}>
        <label htmlFor="risk-address">Token address</label>
        <input id="risk-address" value={address} onChange={(e) => setAddress(e.target.value.trim())} autoComplete="off" spellCheck={false} />
        <span className="hint">The default is QUSDC, the token Sluice settles in.</span>
      </div>
      <div className="row">
        <button type="button" className="btn btn-dark" onClick={() => void run()} disabled={busy} data-testid="risk-run">
          {busy ? "Reading the chain…" : "Check this token"}
        </button>
      </div>
      {outcome && !outcome.ok ? <p className="banner banner-error" role="alert" data-testid="risk-error">{outcome.message}</p> : null}
      {outcome?.ok ? <RiskResult risk={outcome.result} /> : null}
    </div>
  );
}

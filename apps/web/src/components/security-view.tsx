// The security page's body: the limits that apply, what the owner can and cannot do, what the facilitator is held to, QUSDC and how deep its
// market is, and what has not been reviewed. A plain component: the liquidity reading is passed in, so a test can show each state and the
// page itself makes the one read.
import Link from "next/link";
import { FACILITATOR_LIMITS, OWNER_POWERS, QUSDC_FINDING, liveLimits } from "../content/copy";
import type { Liquidity } from "../lib/liquidity";

export function SecurityView({ sessionCapUnits, networkLabel, depth }: { sessionCapUnits: number; networkLabel: string; depth: Liquidity | undefined }) {
  return (
    <div className="wrap stack gap-xl security" data-testid="security-view">
      <section className="stack" aria-labelledby="sec-limits" data-testid="live-limits">
        <h2 id="sec-limits" className="h-section">Limits that apply to you</h2>
        <ul className="stack">
          {liveLimits(sessionCapUnits).map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </section>

      <section className="stack" aria-labelledby="sec-owner">
        <h2 id="sec-owner" className="h-section">What the owner can and cannot do</h2>
        <div className="table-wrap">
          <table className="table" data-testid="owner-powers">
            <thead>
              <tr><th>Can or cannot</th><th>Power</th><th>How it is limited</th></tr>
            </thead>
            <tbody>
              {OWNER_POWERS.map(([kind, power, how]) => (
                <tr key={power}>
                  <td data-label="Can or cannot"><span className={kind === "Can" ? "tag tag-warn" : "tag tag-success"}>{kind}</span></td>
                  <td data-label="Power">{power}</td>
                  <td data-label="How it is limited">{how}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="stack" aria-labelledby="sec-facilitator">
        <h2 id="sec-facilitator" className="h-section">What the facilitator is held to</h2>
        <p className="muted">
          The facilitator sends transactions and pays their gas. Its limits are constants in code: a setting can lower one and can never raise it above its ceiling. The operator may run it below the defaults.
        </p>
        <div className="table-wrap">
          <table className="table" data-testid="facilitator-limits">
            <thead>
              <tr><th>Limit</th><th className="right">Default</th><th className="right">Ceiling</th></tr>
            </thead>
            <tbody>
              {FACILITATOR_LIMITS.map(([what, def, ceiling]) => (
                <tr key={what}>
                  <td data-label="Limit">{what}</td>
                  <td data-label="Default" className="right amount">{def}</td>
                  <td data-label="Ceiling" className="right amount">{ceiling}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="stack" aria-labelledby="sec-qusdc">
        <h2 id="sec-qusdc" className="h-section">QUSDC</h2>
        <p>{QUSDC_FINDING.body}</p>
        <p><strong>What helps.</strong> {QUSDC_FINDING.advice}</p>
        <div className="card card-solid stack" data-testid="liquidity">
          <h3>Liquidity depth</h3>
          {depth === undefined ? (
            <p data-testid="liquidity-value">QUSDC&apos;s market on QIEDEX is read on QIE mainnet. This site is set to {networkLabel}, so there is no reading to show.</p>
          ) : depth.ok ? (
            <p data-testid="liquidity-value">
              The QUSDC and WQIE pool on QIEDEX holds <strong>{depth.qusdc} QUSDC</strong>, read from the chain just now. A swap that is a large share of that moves the price. Sluice does not swap: a refund or a withdrawal returns QUSDC from the router, and does not touch the pool.
            </p>
          ) : (
            <p data-testid="liquidity-value">{depth.reason} No figure is shown rather than a guess.</p>
          )}
        </div>
      </section>

      <section className="stack" aria-labelledby="sec-review">
        <h2 id="sec-review" className="h-section">What has not been reviewed</h2>
        <ul className="stack">
          {QUSDC_FINDING.others.map((o) => (
            <li key={o}>{o}</li>
          ))}
        </ul>
        <p>
          <Link className="link" href="/docs/risks">All the risks</Link> · <Link className="link" href="/terms">Terms</Link> · <Link className="link" href="/privacy">Privacy</Link> · <Link className="link" href="/status">Status</Link>
        </p>
      </section>
    </div>
  );
}

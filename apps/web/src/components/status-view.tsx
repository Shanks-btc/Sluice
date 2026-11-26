// The /status page's body. It only shows what src/lib/service-status.ts read: nothing here is a number the page made up, and a service that
// could not be read is shown as unreachable, never as fine. No hooks and no client code: it is rendered on the server.
import { formatQie, formatUtc } from "../lib/format";
import type { ServiceStatus } from "../lib/service-status";

const OVERALL: Record<ServiceStatus["overall"], { label: string; tag: string }> = {
  operational: { label: "Working", tag: "tag tag-success" },
  degraded: { label: "Working with problems", tag: "tag tag-warn" },
  down: { label: "Not working", tag: "tag tag-error" },
  not_configured: { label: "Nothing to check", tag: "tag" },
};

/** "42 seconds ago", "5 minutes ago", "3 hours ago". */
export function ago(seconds: number): string {
  if (seconds < 90) return `${seconds} second${seconds === 1 ? "" : "s"} ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} minutes ago`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)} hours ago`;
  return `${Math.round(seconds / 86_400)} days ago`;
}

const yesNo = (ok: boolean, good = "Yes", bad = "No") => <span className={ok ? "tag tag-success" : "tag tag-warn"}>{ok ? good : bad}</span>;

export function StatusView({ status }: { status: ServiceStatus }) {
  const o = OVERALL[status.overall];
  const f = status.facilitator;
  const t = status.tools;
  return (
    <div className="stack gap-lg" data-testid="status-view">
      <div className="card card-solid stack" data-testid="status-overall">
        <p>
          <span className={o.tag} data-testid="status-overall-tag">{o.label}</span>{" "}
          <span className="muted">
            {status.network}, chain {status.chainId}{status.realFunds ? ", real funds" : ", no real funds"}. Read {formatUtc(Math.floor(status.checkedAt / 1000))}; an answer is held for up to ten seconds.
          </span>
        </p>
        {status.problems.length > 0 ? (
          <ul className="stack" data-testid="status-problems">
            {status.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        ) : (
          <p>Everything this page can read from the facilitator, the tool server and the QIE nodes looks as it should.</p>
        )}
      </div>

      <section className="stack" aria-labelledby="fac-status">
        <h2 id="fac-status" className="h-section">Facilitator</h2>
        {!f.configured ? (
          <p className="muted" data-testid="facilitator-status">No facilitator is set on this site.</p>
        ) : !f.reachable ? (
          <p className="banner banner-error" role="alert" data-testid="facilitator-status">The facilitator is not answering. {f.reason}</p>
        ) : (
          <div className="table-wrap" data-testid="facilitator-status">
            <table className="table">
              <tbody>
                <tr><th scope="row">Healthy</th><td>{yesNo(f.ok)}</td></tr>
                <tr><th scope="row">Kill switch</th><td>{f.killSwitch ? <span className="tag tag-warn">On: payments and top-ups paused</span> : <span className="tag tag-success">Off</span>}</td></tr>
                <tr><th scope="row">Relayer QIE</th><td>{f.relayerBalanceWei ? `${formatQie(BigInt(f.relayerBalanceWei), 4)} QIE` : "unknown"} {f.lowBalance ? <span className="tag tag-warn">Low</span> : <span className="tag tag-success">Enough</span>}</td></tr>
                <tr><th scope="row">Waiting for a batch</th><td data-testid="status-queued">{f.queued}</td></tr>
                <tr><th scope="row">In a batch, not yet recorded</th><td>{f.inFlight}{f.inFlight > 0 ? `, the oldest ${ago(f.oldestInFlightAgeSeconds)}` : ""}</td></tr>
                <tr><th scope="row">Last settled</th><td data-testid="status-last-settled">{f.lastSettled ? `${ago(f.lastSettled.ageSeconds)}${f.lastSettled.blockNumber !== null ? `, block ${f.lastSettled.blockNumber.toLocaleString("en-US")}` : ""}` : "Nothing settled yet"}</td></tr>
                <tr><th scope="row">Journal</th><td>{yesNo(f.storeHealthy, "Healthy", "Not healthy")}</td></tr>
                <tr><th scope="row">Chain</th><td>{f.chainId ?? "unknown"} {yesNo(f.chainMatches, "Matches this site", "Different from this site")}</td></tr>
                <tr><th scope="row">Router</th><td>{yesNo(f.routerMatches, "Matches this site", "Different from this site")}</td></tr>
                <tr><th scope="row">Open alerts</th><td>{f.alerts.length === 0 ? "None" : f.alerts.join(", ")}</td></tr>
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="stack" aria-labelledby="tools-status">
        <h2 id="tools-status" className="h-section">Tool server</h2>
        {!t.configured ? (
          <p className="muted" data-testid="tools-status">No tool server is set on this site.</p>
        ) : !t.reachable ? (
          <p className="banner banner-error" role="alert" data-testid="tools-status">The tool server is not answering. {t.reason}</p>
        ) : (
          <div className="table-wrap" data-testid="tools-status">
            <table className="table">
              <tbody>
                <tr><th scope="row">Chain</th><td>{yesNo(t.chainMatches, "Matches this site", "Different from this site")}</td></tr>
                <tr><th scope="row">Router</th><td>{yesNo(t.routerMatches, "Matches this site", "Different from this site")}</td></tr>
                <tr><th scope="row">Tools</th><td>{t.tools.length === 0 ? "None" : t.tools.map((x) => `${x.name} (${x.price} QUSDC)`).join(", ")}</td></tr>
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="stack" aria-labelledby="rpc-status">
        <h2 id="rpc-status" className="h-section">QIE endpoints</h2>
        <p className="muted">Each is asked for its chain id. Pages read through the earliest in the list that answers with the right one and fall back to the others.</p>
        <div className="table-wrap">
          <table className="table" data-testid="rpc-status">
            <thead>
              <tr><th>Endpoint</th><th>State</th><th className="right">Time</th></tr>
            </thead>
            <tbody>
              {status.rpc.endpoints.map((e) => (
                <tr key={e.host}>
                  <td data-label="Endpoint" className="mono">{e.host}</td>
                  <td data-label="State">{e.ok ? <span className="tag tag-success">Answers</span> : <span className="tag tag-warn">{e.reason === "timeout" ? "Too slow" : e.reason === "wrong_chain" ? "Wrong chain" : "Not answering"}</span>}</td>
                  <td data-label="Time" className="right">{e.ok ? `${e.ms} ms` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted">{status.rpc.healthy} of {status.rpc.endpoints.length} answering.</p>
      </section>
    </div>
  );
}

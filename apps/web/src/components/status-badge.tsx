// A component's status as a badge. The badge takes the evidence rows and runs `effectiveStatus`, so it cannot show Live without a
// verified mainnet row, whatever the typed list says.
import { COMPONENTS, badgeClass, effectiveStatus } from "../status";
import type { ComponentStatus, EvidenceKey } from "../status";

export function StatusBadge({ component, rows }: { component: ComponentStatus; rows: readonly EvidenceKey[] }) {
  const { status, reason } = effectiveStatus(component, rows);
  return (
    <span className={badgeClass(status)} data-status={status} title={reason}>
      {status}
    </span>
  );
}

export function StatusGrid({ rows }: { rows: readonly EvidenceKey[] }) {
  return (
    <ul className="status-grid">
      {COMPONENTS.map((c) => (
        <li key={c.id} className="card card-solid card-sm status-item" data-component={c.id}>
          <div className="row status-head">
            <h3>{c.name}</h3>
            <StatusBadge component={c} rows={rows} />
          </div>
          <p className="muted">{c.summary}</p>
        </li>
      ))}
    </ul>
  );
}

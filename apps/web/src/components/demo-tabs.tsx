"use client";
// The demo page's two modes. Real payment is the default and comes first. The sandbox is a secondary tab, labelled as what it is: a
// simulation with no wallet and no funds, whose output is never a record of anything real.
import { useId, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

export const DEMO_TABS = [
  { id: "live", label: "Real payment" },
  { id: "sandbox", label: "Sandbox (no funds)" },
] as const;
export type DemoTabId = (typeof DEMO_TABS)[number]["id"];

export function DemoTabs({ live, sandbox, initial = "live" }: { live: ReactNode; sandbox: ReactNode; initial?: DemoTabId }) {
  const [active, setActive] = useState<DemoTabId>(initial);
  const base = useId();
  const ids = (tab: DemoTabId) => ({ tab: `${base}-tab-${tab}`, panel: `${base}-panel-${tab}` });

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next = (index + (e.key === "ArrowRight" ? 1 : DEMO_TABS.length - 1)) % DEMO_TABS.length;
    const tab = DEMO_TABS[next]!.id;
    setActive(tab);
    document.getElementById(ids(tab).tab)?.focus();
  };

  return (
    <div className="stack gap-lg">
      <div role="tablist" aria-label="Demo mode" className="tabs" data-testid="demo-tabs">
        {DEMO_TABS.map((t, i) => (
          <button
            key={t.id}
            id={ids(t.id).tab}
            role="tab"
            type="button"
            aria-selected={active === t.id}
            aria-controls={ids(t.id).panel}
            tabIndex={active === t.id ? 0 : -1}
            className={active === t.id ? "tab tab-active" : "tab"}
            onClick={() => setActive(t.id)}
            onKeyDown={(e) => onKey(e, i)}
            data-testid={`tab-${t.id}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={ids("live").panel} aria-labelledby={ids("live").tab} hidden={active !== "live"} data-testid="panel-live">
        {live}
      </div>
      <div role="tabpanel" id={ids("sandbox").panel} aria-labelledby={ids("sandbox").tab} hidden={active !== "sandbox"} data-testid="panel-sandbox">
        <p className="banner banner-info" data-testid="sandbox-banner">
          Sandbox: simulated, no wallet, no chain, no funds. What it shows is built from the messages in the spec&apos;s test vectors. It is not a record of anything that happened, and nothing here is counted as evidence.
        </p>
        {sandbox}
      </div>
    </div>
  );
}

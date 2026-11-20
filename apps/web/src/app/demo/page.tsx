import type { Metadata } from "next";
import { FacilitatorPanel } from "../../components/demo-facilitator";
import { RefusalExamples, SimulationPlayer } from "../../components/demo-simulation";
import { PageHead } from "../../components/page-head";
import { RiskPanel } from "../../components/risk-panel";

export const metadata: Metadata = {
  title: "Demo",
  description: "A simulated paid call from request to settlement, a panel to read a facilitator, and a read-only risk check for a token.",
};

export default function DemoPage() {
  return (
    <>
      <PageHead eyebrow="Demo" title="One paid call, from request to settlement">
        <p>
          The walkthrough runs in your browser against the messages in the spec&apos;s test vectors. It uses no chain and no funds. Below it, you can read a facilitator you run yourself, and run the read-only risk check on a token.
        </p>
      </PageHead>
      <div className="wrap stack gap-xl demo">
        <section id="walkthrough" aria-labelledby="walk-title" className="stack gap-lg">
          <h2 id="walk-title" className="h-section">Walkthrough</h2>
          <SimulationPlayer />
          <RefusalExamples />
        </section>
        <section id="facilitator" aria-labelledby="fac-title" className="stack gap-lg">
          <h2 id="fac-title" className="h-section">Read a facilitator</h2>
          <FacilitatorPanel />
        </section>
        <section id="risk" aria-labelledby="risk-title" className="stack gap-lg">
          <h2 id="risk-title" className="h-section">Risk check</h2>
          <RiskPanel />
        </section>
      </div>
    </>
  );
}

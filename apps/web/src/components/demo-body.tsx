// The demo page's body, as a plain component so a test can render it: the real payment first and the sandbox second, then the read-only tools.
import { DemoTabs } from "./demo-tabs";
import { FacilitatorPanel } from "./demo-facilitator";
import { RefusalExamples, SimulationPlayer } from "./demo-simulation";
import { LiveDemo } from "./live-demo";
import { PageHead } from "./page-head";
import { WalletProvider } from "./providers";
import { RiskPanel } from "./risk-panel";

export function DemoBody() {
  return (
    <>
      <PageHead eyebrow="Demo" title="Pay for one real tool call">
        <p>
          Connect a wallet, put a small amount in the router, pay for a tool call with one signed message, and follow the payment to its settlement on chain. Every step shows what your wallet will be asked to sign before it opens. The sandbox tab runs a simulated call with no wallet and no funds.
        </p>
      </PageHead>
      <div className="wrap stack gap-xl demo">
        <WalletProvider>
          <DemoTabs
            live={<LiveDemo />}
            sandbox={
              <section id="walkthrough" aria-labelledby="walk-title" className="stack gap-lg">
                <h2 id="walk-title" className="h-section">Walkthrough</h2>
                <SimulationPlayer />
                <RefusalExamples />
              </section>
            }
          />
        </WalletProvider>
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

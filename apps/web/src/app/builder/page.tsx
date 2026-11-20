import type { Metadata } from "next";
import { BuilderDashboard } from "../../components/builder-dashboard";
import { PageHead } from "../../components/page-head";
import { WalletProvider } from "../../components/providers";
import { content } from "../../lib/content";

export const metadata: Metadata = {
  title: "Builders",
  description: "Earnings, recent settlements and the fee in effect, read from the router, and how to put a price on an MCP tool.",
};

export default function BuilderPage() {
  return (
    <>
      <PageHead eyebrow="For MCP builders" title="Builder dashboard">
        <p>Read what the router holds for a builder, withdraw it, and see how to put a price on a tool. Reading needs no wallet.</p>
      </PageHead>
      <div className="wrap stack gap-xl">
        <WalletProvider>
          <BuilderDashboard />
        </WalletProvider>
        <section className="stack gap-lg" id="wrap" aria-labelledby="wrap-title" data-testid="wrap-guide">
          <h2 id="wrap-title" className="h-section">Wrap your tool</h2>
          <p className="muted">
            Add the SDK to an MCP server and register each paid tool through the paywall. A call without payment gets the price back. A call with a valid payment runs the tool and queues the payment. This is the SDK&apos;s own call, written the way the example paid tools use it, and a test type-checks it against the SDK.
          </p>
          <pre className="code" data-testid="wrap-snippet">{content.snippets.wrapTool}</pre>
          <p className="muted">
            The price is a decimal in QUSDC with at most six places. The payee is an address; a <code>.qie</code> name needs a resolver you supply, because no documented on-chain read for QIE ID names was found. See the <a className="link" href="/docs/sdk">SDK document</a> and the <a className="link" href="/docs/facilitator">facilitator document</a>.
          </p>
        </section>
      </div>
    </>
  );
}

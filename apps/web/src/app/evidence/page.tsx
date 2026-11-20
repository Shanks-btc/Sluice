import type { Metadata } from "next";
import { EvidenceTable, SummaryView } from "../../components/evidence-view";
import { Prose } from "../../components/doc-view";
import { PageHead } from "../../components/page-head";
import { content } from "../../lib/content";
import { loadConfigFromProcess } from "../../lib/config";
import { renderMarkdown } from "../../lib/markdown";
import { cached, computeSummary, safeRpcUrl } from "../../lib/summary-handler";
import type { SummaryAnswer } from "../../lib/summary-handler";

export const metadata: Metadata = {
  title: "Evidence",
  description: "The transactions that back a public claim, with explorer links, and the paid-call counts the chain shows.",
};

// One scan serves every visitor for a minute.
const once = cached<SummaryAnswer>(60_000);

export default async function EvidencePage() {
  const config = loadConfigFromProcess();
  const founder = content.founderWallets as { version: number; wallets: unknown[] };
  const answer = await once(() => computeSummary({ config, founderListRaw: content.founderWallets, rpcUrl: safeRpcUrl(process.env["SLUICE_RPC_URL"]), fromBlock: Number(process.env["SLUICE_FROM_BLOCK"]) || null }));
  const intro = renderMarkdown(content.evidence.intro, { source: "docs/EVIDENCE.md", repoUrl: config.repoUrl });
  return (
    <>
      <PageHead eyebrow="Evidence" title="What a transaction on QIE shows">
        <p>
          Sluice claims what a transaction can show. These are the rows in <span className="mono">docs/EVIDENCE.md</span>. Verified rows: mainnet {content.evidence.mainnet}, testnet {content.evidence.testnet}.
        </p>
      </PageHead>
      <div className="wrap stack gap-xl">
        <EvidenceTable network="mainnet" rows={content.evidence.rows} />
        <EvidenceTable network="testnet" rows={content.evidence.rows} />
        <SummaryView answer={answer} founder={{ version: founder.version, wallets: founder.wallets.length }} />
        <details className="stack" open>
          <summary className="h-section summary-title">How a row gets here</summary>
          <Prose html={intro.html} source="docs/EVIDENCE.md" />
        </details>
      </div>
    </>
  );
}

import Link from "next/link";
import type { Metadata } from "next";
import { PageHead } from "../../components/page-head";
import { DOC_SOURCES } from "../../lib/content-types";
import type { DocGroup } from "../../lib/content-types";

export const metadata: Metadata = {
  title: "Docs",
  description: "The spec, the risks, the gas report, the decisions and the package documents, rendered from the repository's own files.",
};

const ABOUT: Record<string, string> = {
  "connect-a-client": "The proxy configuration for Claude Code and Cursor. Documented, not yet tested with real clients.",
  spec: "The Sluice payment scheme for MCP on QIE, written to be implemented by someone else, with test vectors.",
  risks: "What can go wrong, who can do it, and what a user can still do about it.",
  gas: "Measured gas and cost on a local copy of QIE mainnet.",
  decisions: "The choices made while building, each with its reason.",
  sdk: "paidTool middleware, the EIP-712 intent and the facilitator client.",
  facilitator: "Verify, settle, status, onboard and relay, behind hard limits in code.",
  proxy: "The stdio payment proxy and the owner's budget.",
  "wallet-mcp": "Five read-only tools for an agent. It cannot sign.",
  "paid-tools": "Three example paid tools with real, read-only output.",
};

const GROUPS: DocGroup[] = ["Start", "Reference", "Packages"];

export default function DocsIndex() {
  return (
    <>
      <PageHead eyebrow="Docs" title="Documents">
        <p>
          Every page here is rendered from a file in the repository when the site is built, so it cannot drift from the source. The evidence file has its own page: <Link className="link" href="/evidence">Evidence</Link>.
        </p>
      </PageHead>
      <div className="wrap stack gap-xl">
        {GROUPS.map((group) => (
          <section key={group} className="stack gap-lg" aria-labelledby={`g-${group}`}>
            <h2 id={`g-${group}`} className="h-section">{group}</h2>
            <ul className="grid-2 doc-cards">
              {DOC_SOURCES.filter((d) => d.group === group).map((d) => (
                <li key={d.slug}>
                  <Link className="card card-solid doc-card" href={`/docs/${d.slug}`}>
                    <h3>{d.title}</h3>
                    <p className="muted">{ABOUT[d.slug]}</p>
                    <span className="mono muted">{d.source}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}

// The footer: the same structure as the rest of the family (a brand column, three link columns, a line of small print), with
// Sluice's own links. The GitHub link appears only when the deployer has set the repository address.
import Link from "next/link";
import { Wordmark } from "./brand";

type FooterLink = readonly [href: string, label: string];

const COLUMNS: ReadonlyArray<{ heading: string; links: readonly FooterLink[] }> = [
  {
    heading: "Product",
    links: [
      ["/#how", "How it works"],
      ["/demo", "Demo"],
      ["/builder", "For builders"],
      ["/wallet", "Wallet and budgets"],
    ],
  },
  {
    heading: "Read",
    links: [
      ["/docs/spec", "The spec"],
      ["/docs/risks", "Risks"],
      ["/docs/gas", "Gas and cost"],
      ["/evidence", "Evidence"],
    ],
  },
  {
    heading: "Trust",
    links: [
      ["/security", "Security and limits"],
      ["/status", "Status"],
      ["/terms", "Terms"],
      ["/privacy", "Privacy"],
    ],
  },
  {
    heading: "Project",
    links: [
      ["/docs", "All documents"],
      ["/docs/decisions", "Decisions"],
      ["/docs/connect-a-client", "Connect an MCP client"],
    ],
  },
];

/** `deployed` is whether the evidence file holds a mainnet `Deployed` row: the footer's line about the chain follows it. */
export function Footer({ repoUrl, deployed }: { repoUrl: string | null; deployed: boolean }) {
  const year = new Date().getUTCFullYear();
  return (
    <footer className="footer">
      <div className="wrap">
        <div className="ftop">
          <div className="fbrand">
            <Link href="/" aria-label="Sluice, home">
              <Wordmark />
            </Link>
            <p>
              Payment middleware for MCP tools, on QIE, in QUSDC.{" "}
              {deployed ? "The contracts are on QIE mainnet: the evidence page lists what is recorded there." : "Not deployed to a QIE network yet."}
            </p>
            <Link className="btn btn-sm btn-footer" href="/demo">
              Try the demo
            </Link>
          </div>
          <div className="fcols">
            {COLUMNS.map((c) => (
              <nav key={c.heading} aria-labelledby={`f-${c.heading}`}>
                <h2 id={`f-${c.heading}`}>{c.heading}</h2>
                {c.links.map(([href, label]) => (
                  <Link key={href} href={href}>
                    {label}
                  </Link>
                ))}
                {c.heading === "Project" && repoUrl ? (
                  <a href={repoUrl} rel="noopener noreferrer" target="_blank">
                    GitHub
                  </a>
                ) : null}
              </nav>
            ))}
          </div>
        </div>
        <div className="fbot">
          <span>© {year} Sluice. MIT licence.</span>
          <span>Code written and tested by Claude Code, Anthropic&apos;s coding agent.</span>
          <span>An independent scheme, not an official x402 one.</span>
        </div>
      </div>
    </footer>
  );
}

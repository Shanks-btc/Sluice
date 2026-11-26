// The shape of apps/web/src/generated/content.json, which `pnpm web:content` writes from the repository's own documents. The web app
// renders from that file, so the documents on the site are the documents in the repository, never a copy that can drift.
import type { EvidenceRow } from "../../../../src/evidence";

export type DocGroup = "Start" | "Reference" | "Packages" | "Legal";

export type DocSource = { slug: string; title: string; group: DocGroup; source: string };

/** Every document the site renders, in the order the sidebar lists them. */
export const DOC_SOURCES: readonly DocSource[] = [
  { slug: "connect-a-client", title: "Connect a real MCP client", group: "Start", source: "packages/proxy/README.md" },
  { slug: "spec", title: "The payment scheme (spec)", group: "Reference", source: "docs/SPEC.md" },
  { slug: "risks", title: "Risks", group: "Reference", source: "docs/RISKS.md" },
  { slug: "gas", title: "Gas and cost", group: "Reference", source: "docs/GAS.md" },
  { slug: "decisions", title: "Decisions", group: "Reference", source: "DECISIONS.md" },
  { slug: "sdk", title: "SDK", group: "Packages", source: "packages/sdk/README.md" },
  { slug: "facilitator", title: "Facilitator", group: "Packages", source: "packages/facilitator/README.md" },
  { slug: "proxy", title: "Payment proxy", group: "Packages", source: "packages/proxy/README.md" },
  { slug: "wallet-mcp", title: "Wallet MCP", group: "Packages", source: "packages/wallet-mcp/README.md" },
  { slug: "paid-tools", title: "Example paid tools", group: "Packages", source: "examples/paid-tools/README.md" },
  { slug: "terms", title: "Terms", group: "Legal", source: "docs/TERMS.md" },
  { slug: "privacy", title: "Privacy", group: "Legal", source: "docs/PRIVACY.md" },
];

/** The first block of a legal draft in the repository: a line saying it is a draft and is not legal advice. It is for people reading the repository, and the site does not show it. */
export const DRAFT_BANNER = /^> \*\*Draft: not legal advice\.\*\*[^\n]*\n(?:>[^\n]*\n)*\n?/;

/** Repository paths that have a page on the site, for rewriting links between documents. The evidence file has its own page. */
export const PAGE_FOR_SOURCE: Readonly<Record<string, string>> = {
  ...Object.fromEntries(DOC_SOURCES.filter((d) => d.slug !== "connect-a-client" && d.group !== "Legal").map((d) => [d.source, `/docs/${d.slug}`])),
  "docs/EVIDENCE.md": "/evidence",
  "docs/TERMS.md": "/terms",
  "docs/PRIVACY.md": "/privacy",
};

export type DocEntry = DocSource & { sha256: string; markdown: string };

export type ReadmeStatusRow = { surface: string; status: string; evidence: string };

export type DiffersRow = { other: string; shows: string; differs: string; unknown: string };

export type WebContent = {
  schema: 1;
  docs: DocEntry[];
  /** `own` counts, for each network, the rows whose Who address is on the founder list: the project's own transactions. */
  evidence: { intro: string; rows: EvidenceRow[]; mainnet: number; testnet: number; own: { mainnet: number; testnet: number }; sha256: string };
  /** docs/founder-wallets.json as written. */
  founderWallets: unknown;
  /** The addresses on that list, in lower case, for marking a row that is about one of them. */
  ownAddresses: string[];
  readme: { description: string; statusRows: ReadmeStatusRow[] };
  /** The README's "How this differs" section: its introduction and its table, as written there. */
  differs: { intro: string; rows: DiffersRow[] };
  /** The code shown in the builder's "Wrap your tool" guide: the file apps/web/snippets/wrap-tool.ts, which a test type-checks. */
  snippets: { wrapTool: string };
  /** What QIE's explorer showed for the vault, from docs/explorer/vault-record.json: null when no record says it showed verified source. */
  vault: { vault: string; readAt: string } | null;
};

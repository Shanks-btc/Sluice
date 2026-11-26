// Builds the content the web app renders from the repository's own documents: the spec, the risks, the gas report, the decisions, the
// package READMEs, the evidence file, the founder wallet list and the README's status table. `pnpm web:content` writes it to
// apps/web/src/generated/content.json before every build, and a test fails if that file is out of date, so the site cannot drift
// from the repository.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseStatusTable } from "./claims";
import { parseEvidenceStrict } from "./evidence";
import { FOUNDER_LIST_PATH, founderAddresses, ownRowCount, parseFounderList } from "./summary";
import { VAULT_RECORD_PATH, explorerShowsVault } from "./vault-record";
import { DOC_SOURCES, DRAFT_BANNER } from "../apps/web/src/lib/content-types";
import type { DiffersRow, DocEntry, WebContent } from "../apps/web/src/lib/content-types";

export const CONTENT_PATH = "apps/web/src/generated/content.json";

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The text of a "## Heading" section, heading included, up to the next "## ". */
export function sectionOf(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start === -1) throw new Error(`no section "${heading}"`);
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start, end === -1 ? undefined : end).join("\n").trimEnd();
}

/** The README's "How this differs" section: the paragraph before the table, and one record per table row. */
export function differsOf(readme: string): { intro: string; rows: DiffersRow[] } {
  const lines = sectionOf(readme, "How this differs").split("\n").slice(1);
  const intro = lines.filter((l) => l.trim() !== "" && !l.startsWith("|")).join(" ").trim();
  const rows: DiffersRow[] = [];
  let seenHeader = false;
  for (const line of lines) {
    if (!line.startsWith("|")) continue;
    const cells = line.replace(/^\||\|\s*$/g, "").split("|").map((c) => c.trim());
    if (!seenHeader) {
      if (cells.join("|") !== "Other work|What the pre-build check shows|How Sluice differs|Unknown") throw new Error("the How this differs table has changed its columns");
      seenHeader = true;
      continue;
    }
    if (/^:?-{3,}:?$/.test(cells[0] ?? "")) continue;
    if (cells.length !== 4) throw new Error("a How this differs row does not have four cells");
    rows.push({ other: cells[0] as string, shows: cells[1] as string, differs: cells[2] as string, unknown: cells[3] as string });
  }
  return { intro, rows };
}

/** The "Connect a real MCP client" page: a plain statement of what has and has not been tested, then the proxy README's section. */
export function connectClientPage(proxyReadme: string, clientsStatus: string): string {
  const label =
    clientsStatus === "Coming soon"
      ? "**Documented, not yet tested with real clients.**"
      : `**Status in the README's table: ${clientsStatus}.**`;
  const body = sectionOf(proxyReadme, "Use it from Claude Code and Cursor").replace(/^## /, "## ");
  return [
    "# Connect a real MCP client",
    "",
    label,
    "",
    "The payment proxy sits between an MCP client and a paid MCP server. The two configurations below were written from the clients' documented formats.",
    "They were **not** run in Claude Code or in Cursor. The proxy and the wallet MCP were run as separate processes under a test client on a local chain, and that is all that has been tried.",
    "Treat these as a starting point, and tell the maintainer what differs.",
    "",
    body,
  ].join("\n");
}

export function buildContent(root: string): WebContent {
  const read = (path: string): string => readFileSync(join(root, path), "utf8");
  const readme = read("README.md");
  const rows = parseStatusTable(readme);
  if (!rows) throw new Error("the README has no status table");
  const clients = rows.find((r) => r.surface === "Use from Claude Code and Cursor");
  if (!clients) throw new Error("the README's status table has no row for Claude Code and Cursor");

  const docs: DocEntry[] = DOC_SOURCES.map((d) => {
    const text = read(d.source);
    // A legal draft carries a "Draft: not legal advice" block in the repository. The site's page for it does not show that block.
    const markdown = d.slug === "connect-a-client" ? connectClientPage(text, clients.status) : d.group === "Legal" ? text.replace(/\r\n/g, "\n").replace(DRAFT_BANNER, "") : text;
    return { ...d, sha256: sha(text), markdown };
  });

  const evidenceText = read("docs/EVIDENCE.md");
  const evidenceRows = parseEvidenceStrict(evidenceText); // every table must carry the Network column, so a row cannot be read as another chain's
  const founderWallets = JSON.parse(read(FOUNDER_LIST_PATH)) as unknown;
  const founders = founderAddresses(parseFounderList(founderWallets)); // a list that cannot be read stops the build: no count is shown unfiltered
  // The paragraph after the title and its screenshot.
  const description = readme.split("\n").slice(1).find((l) => l.trim() !== "" && !l.startsWith("<")) ?? "";

  return {
    schema: 1,
    docs,
    evidence: {
      // The body of "How a row gets here" (its steps and the columns), without the heading or the title the page already shows.
      intro: (evidenceText.split(/^## How a row gets here\s*$/m)[1] ?? "").split(/^## Mainnet/m)[0]?.trim() ?? "",
      rows: evidenceRows,
      mainnet: evidenceRows.filter((r) => r.network === "mainnet").length,
      testnet: evidenceRows.filter((r) => r.network === "testnet").length,
      own: { mainnet: ownRowCount(evidenceRows, "mainnet", founders), testnet: ownRowCount(evidenceRows, "testnet", founders) },
      sha256: sha(evidenceText),
    },
    founderWallets,
    ownAddresses: [...founders].sort(),
    readme: { description, statusRows: rows.map((r) => ({ surface: r.surface, status: r.status, evidence: r.evidence })) },
    differs: differsOf(readme),
    snippets: { wrapTool: read("apps/web/snippets/wrap-tool.ts") },
    vault: explorerShowsVault(existsSync(join(root, VAULT_RECORD_PATH)) ? read(VAULT_RECORD_PATH) : undefined),
  };
}

export const serialize = (content: WebContent): string => `${JSON.stringify(content, null, 2)}\n`;

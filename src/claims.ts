// Checks the documents for claims this repository cannot back up.
//
// Two kinds of rule:
//   1. Words that make a promise the code, the tests and the chain data cannot keep (a first, an only, a
//      yield, a compliance statement, a clean bill of health). They are banned outright in the README and docs.
//   2. A status of "Live" is allowed only when docs/EVIDENCE.md has a verified mainnet row for it, and prose
//      may not say something is deployed or running on mainnet while that file has no mainnet row.
//
// The scanner skips fenced code blocks (commands and code are not claims) and any line that is plainly
// negated or conditional ("nothing is live yet", "only after a verified row"), because those say the opposite.
import { EVENTS } from "./events";
import type { EvidenceRow } from "./evidence";

export type Finding = { file: string; line: number; rule: string; text: string };

type Rule = { rule: string; pattern: RegExp };

/** Words and phrases that are never allowed in the README or docs. */
export const BANNED: readonly Rule[] = [
  // Superlatives about the project.
  { rule: "no first/only/unique claims", pattern: /\b(world'?s|industry|chain'?s|QIE'?s)[ -]first\b/i },
  { rule: "no first/only/unique claims", pattern: /\bfirst[- ](ever|of its kind|on QIE|to|mover|of)\b/i },
  { rule: "no first/only/unique claims", pattern: /\bthe (first|only)\b/i },
  { rule: "no first/only/unique claims", pattern: /\bonly (one|way|solution|platform|protocol|project|chain)\b/i },
  { rule: "no first/only/unique claims", pattern: /\b(unique|one of a kind|unparalleled|unmatched|no other)\b/i },
  { rule: "no first/only/unique claims", pattern: /\b(best|leading|revolutionary|groundbreaking|cutting[- ]edge|next[- ]gen(eration)?)\b/i },
  // Money that grows.
  { rule: "no yield or interest claims", pattern: /\b(yield|yields|APY|APR|interest|passive income|staking rewards?|returns on)\b/i },
  // Regulatory statements.
  { rule: "no compliance claims", pattern: /\b(compliant|compliance|regulated|regulatory approval|KYC|AML|licensed)\b/i },
  // Clean bills of health nobody has issued.
  { rule: "no safety promises", pattern: /\b(audited|audit report|guarantee|guarantees|guaranteed|risk[- ]free|trustless|unhackable|battle[- ]tested|bulletproof|100% safe)\b/i },
  { rule: "no readiness promises", pattern: /\b(production[- ]ready|mainnet[- ]ready|enterprise[- ]grade)\b/i },
];

/** Prose that says something is deployed or running on mainnet. Allowed only with a mainnet evidence row. */
export const DEPLOYMENT_CLAIMS: readonly RegExp[] = [
  /\b(is|are|now|already|currently)\s+(live|deployed|launched)\b/i,
  /\blive (on|in) (QIE )?(mainnet|QIE)\b/i,
  /\bdeployed (on|to|at) (QIE )?(mainnet|QIE)\b/i,
  /\brunning (on|in) (QIE )?(mainnet|QIE)\b/i,
  /\bin production\b/i,
  /\blaunched (on|to)\b/i,
];

/** A line that says the opposite of a claim, or makes it conditional. */
const NEGATED = /\b(not|no|nothing|none|never|until|unless|if|before|once|after|when|will|would|can|cannot|yet|without|only if)\b|n't\b/i;

/** Splits text into lines with their numbers, dropping fenced code blocks (but keeping mermaid diagrams). */
function proseLines(text: string): Array<{ n: number; text: string }> {
  const out: Array<{ n: number; text: string }> = [];
  let fence: string | undefined;
  text.split("\n").forEach((line, i) => {
    const open = /^```(\w*)/.exec(line.trim());
    if (open) {
      fence = fence === undefined ? (open[1] ?? "") : undefined;
      return;
    }
    if (fence !== undefined && fence !== "mermaid") return;
    out.push({ n: i + 1, text: line });
  });
  return out;
}

/** Scans one document. `mainnetRows` is how many verified mainnet rows docs/EVIDENCE.md has. */
export function scanClaims(file: string, text: string, mainnetRows: number): Finding[] {
  const findings: Finding[] = [];
  for (const { n, text: line } of proseLines(text)) {
    for (const { rule, pattern } of BANNED) {
      const hit = pattern.exec(line);
      if (hit) findings.push({ file, line: n, rule, text: hit[0] });
    }
    if (mainnetRows === 0 && !NEGATED.test(line)) {
      for (const pattern of DEPLOYMENT_CLAIMS) {
        const hit = pattern.exec(line);
        if (hit) findings.push({ file, line: n, rule: "no deployment claim without a mainnet evidence row", text: hit[0] });
      }
    }
  }
  return findings;
}

export const STATUSES = ["Live", "Tested on a fork", "Coming soon"] as const;
export type Status = (typeof STATUSES)[number];

export type StatusRow = { surface: string; status: string; evidence: string; line: number };

/** Reads the `| Surface | Status | Evidence |` table. Returns undefined if the README has no such table. */
export function parseStatusTable(markdown: string): StatusRow[] | undefined {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => /^\|\s*Surface\s*\|\s*Status\s*\|\s*Evidence\s*\|\s*$/.test(l.trim()));
  if (start === -1) return undefined;
  const rows: StatusRow[] = [];
  for (let i = start + 2; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (!line.startsWith("|")) break;
    const cells = line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    rows.push({ surface: cells[0] ?? "", status: cells[1] ?? "", evidence: cells[2] ?? "", line: i + 1 });
  }
  return rows;
}

/**
 * The rules for the status table:
 *  - the status is exactly one of Live, Tested on a fork, Coming soon;
 *  - Live names the evidence events it rests on, each with at least one mainnet row in docs/EVIDENCE.md;
 *  - Coming soon has no evidence ("—");
 *  - Tested on a fork points at a file that exists (`exists` is injected so this stays testable).
 */
export function checkStatusTable(
  rows: StatusRow[],
  evidence: EvidenceRow[],
  exists: (path: string) => boolean,
): string[] {
  const problems: string[] = [];
  const mainnet = new Set(evidence.filter((r) => r.network === "mainnet").map((r) => r.event));
  for (const row of rows) {
    const where = `${row.surface} (line ${row.line})`;
    if (!(STATUSES as readonly string[]).includes(row.status)) {
      problems.push(`${where}: status must be one of ${STATUSES.join(", ")}, not ${JSON.stringify(row.status)}`);
      continue;
    }
    if (row.status === "Live") {
      const named = row.evidence.replace(/`/g, "").split(/[,\s]+/).filter((w) => w in EVENTS);
      if (named.length === 0) problems.push(`${where}: Live needs evidence events from docs/EVIDENCE.md`);
      for (const event of named) {
        if (!mainnet.has(event)) problems.push(`${where}: Live, but docs/EVIDENCE.md has no verified mainnet ${event} row`);
      }
    } else if (row.status === "Coming soon") {
      if (row.evidence !== "—") problems.push(`${where}: Coming soon must have — as its evidence`);
    } else {
      const path = row.evidence.replace(/`/g, "");
      if (!path || !exists(path)) problems.push(`${where}: Tested on a fork must point at a file that exists, not ${JSON.stringify(path)}`);
    }
  }
  return problems;
}

/** A line that talks about the word Live in a way that is conditional or negated: "marked Live only when", "nothing is Live". */
const LIVE_CONDITIONAL = /\b(not|no|nothing|none|never|until|unless|only when|only if|if|once|when|will|would|yet)\b/i;

/**
 * The status word Live may appear as a status only in the status table, where checkStatusTable holds it to the evidence file.
 * This scan catches it anywhere else: a table cell that is exactly Live (a status column in another table), and, while the
 * evidence file has no mainnet row, a sentence that says something is Live without being conditional or negated.
 * `tableLines` are the line numbers of the status table's rows, which are left to checkStatusTable.
 */
export function scanLiveWord(file: string, text: string, mainnetRows: number, tableLines: ReadonlySet<number> = new Set()): Finding[] {
  const findings: Finding[] = [];
  for (const { n, text: line } of proseLines(text)) {
    if (tableLines.has(n)) continue;
    const cells = line.trim().startsWith("|") ? line.replace(/^\s*\||\|\s*$/g, "").split("|").map((x) => x.trim()) : [];
    if (cells.includes("Live")) {
      findings.push({ file, line: n, rule: "no Live status outside the status table", text: "Live" });
      continue;
    }
    if (mainnetRows === 0 && /\bLive\b/.test(line) && !LIVE_CONDITIONAL.test(line)) {
      findings.push({ file, line: n, rule: "no unconditional Live without a mainnet evidence row", text: "Live" });
    }
  }
  return findings;
}

// The README and the other documents, held to what the code, the tests and the chain data can show.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";
import { BANNED, checkStatusTable, parseStatusTable, scanClaims, scanLiveWord, STATUSES } from "../../src/claims";
import type { StatusRow } from "../../src/claims";
import { parseEvidenceStrict } from "../../src/evidence";
import { VAULT_RECORD_PATH, explorerShowsVault } from "../../src/vault-record";
import { founderAddresses, ownRowCount, parseFounderList } from "../../src/summary";
import { CLAIM_TYPES } from "../../src/recorder";
import { safeReaddir } from "../../src/secret-paths";
import { MUTATIONS } from "../../scripts/mutation-check";
import { WEB_MUTATIONS } from "../../scripts/mutation-web";
import { LIVE_MUTATIONS } from "../../scripts/mutation-live";
import type { EvidenceRow } from "../../src/evidence";
import {
  BATCH_SIZES,
  formatGwei,
  formatMicro,
  parseGasReport,
  qieCost,
  renderGasReport,
  SIGNED_START_GAS,
  SINGLE_OPERATIONS,
  START_APPROVE_GAS_LIMIT,
  START_DEPOSIT_GAS_LIMIT,
  usdCost,
  withCommas,
} from "../../src/gas";
import { ONBOARD_APPROVE_GAS, ONBOARD_DEPOSIT_GAS } from "@sluice/sdk";

const root = join(__dirname, "..", "..");
// Line endings are LF here whatever git's autocrlf did to the checkout, so the comparisons below do not depend on it.
const read = (path: string) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n");
const README = read("README.md");
const evidenceRows = parseEvidenceStrict(read("docs/EVIDENCE.md"));
const vaultShown = explorerShowsVault(read(VAULT_RECORD_PATH)) !== null;
const mainnetRows = evidenceRows.filter((r) => r.network === "mainnet").length;
const testnetRows = evidenceRows.filter((r) => r.network === "testnet").length;
const FOUNDER_DESCRIPTION =
  "Payment middleware that lets MCP builders get paid, with an MCP-compatible wallet so AI agents can pay for the tools and services they use. Agents pay per request on QIE using HTTP 402-style payments, in QUSDC, with no manual subscriptions or API keys.";
const slug = (heading: string) => heading.toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-");

/** Everything under a "## Heading", up to the next "## ". */
function section(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => l === `## ${heading}`);
  if (start === -1) throw new Error(`no section ${heading}`);
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}

describe("Docs: the files that must exist", () => {
  for (const file of [
    "README.md",
    "LICENSE",
    "AGENTS.md",
    "DECISIONS.md",
    ".env.example",
    ".gitignore",
    "docs/EVIDENCE.md",
    "docs/RISKS.md",
    "docs/GAS.md",
    "docs/SPEC.md",
    "docs/spec-vectors.json",
    "docs/FOUNDER-LOG.md",
    "docs/founder-wallets.json",
    "docs/PREBUILD-VERIFICATION.md",
    "docs/DEPLOY-WEB.md",
    "docs/DEPLOY-FACILITATOR.md",
    "docs/DEPLOY-TOOL-SERVER.md",
    "docs/MAINNET-RUNBOOK.md",
    "docs/REHEARSAL.md",
    "docs/REAL-CLIENT-TEST.md",
    "docs/TRY-IT-BUILDER.md",
    "docs/TRY-IT-AGENT.md",
    "docs/OUTREACH.md",
    "design/PALETTE.md",
    "apps/web/package.json",
    "packages/sdk/README.md",
    "packages/facilitator/README.md",
    "packages/proxy/README.md",
    "packages/wallet-mcp/README.md",
    "examples/paid-tools/README.md",
  ]) {
    it(`${file} exists and is not empty`, () => {
      expect(existsSync(join(root, file)), file).to.equal(true);
      expect(read(file).trim().length, file).to.be.greaterThan(50);
    });
  }

  it("the licence is MIT and the README says so", () => {
    expect(read("LICENSE")).to.match(/^MIT License/);
    expect(section(README, "License")).to.contain("MIT");
    expect(JSON.parse(read("package.json")).license).to.equal("MIT");
  });

  it("the working rules come first in AGENTS.md and the decisions are listed in DECISIONS.md", () => {
    expect(read("AGENTS.md")).to.match(/Working rules/);
    const decisions = read("DECISIONS.md");
    expect(decisions).to.match(/^# Decisions I made/m);
    expect((decisions.match(/^\d+\. \*\*/gm) ?? []).length).to.be.greaterThan(30);
  });
});

describe("Docs: the README's sections", () => {
  const headings = README.split("\n").filter((l) => /^## /.test(l)).map((l) => l.slice(3));

  it("starts with the title, one screenshot, and one plain paragraph describing the product", () => {
    const lines = README.split("\n");
    expect(lines[0]).to.equal("# Sluice");
    expect(lines[1]).to.equal("");
    // One image, in the style of the founder's other READMEs, then the paragraph.
    expect(lines[2]).to.match(/^<p align="center"><img src="design\/screenshots\/sluice-landing\.png" alt="[^"]+" width="100%"><\/p>$/);
    expect(existsSync(join(root, "design/screenshots/sluice-landing.png"))).to.equal(true);
    expect(lines[3]).to.equal("");
    expect((README.match(/<img /g) ?? []).length, "the README has one image").to.equal(1);
    const paragraph = lines[4] ?? "";
    expect(paragraph.length).to.be.within(300, 1400);
    // The founder's description, word for word.
    expect(paragraph.startsWith(FOUNDER_DESCRIPTION), "the paragraph opens with the founder's description, unchanged").to.equal(true);
    expect(paragraph).to.match(/QUSDC/);
    // It says plainly where it stands, and what it says follows the evidence file.
    const mainnet = evidenceRows.filter((r) => r.network === "mainnet");
    if (mainnet.length === 0) {
      expect(paragraph).to.match(/has not been deployed/);
    } else {
      expect(paragraph).to.not.match(/has not been deployed|evidence file\]\(docs\/EVIDENCE\.md\) is empty/);
      if (mainnet.some((r) => r.event === "Deployed")) expect(paragraph).to.match(/deployed on QIE mainnet/);
      if (!mainnet.some((r) => r.event === "Settled")) expect(paragraph).to.match(/no row for a settled payment/);
      else expect(paragraph).to.not.match(/no row for a settled payment/);
      // While every row is about a listed wallet, the paragraph says the rows are founder-run and that nobody outside paid.
      const list = parseFounderList(JSON.parse(read("docs/founder-wallets.json")));
      if (ownRowCount(evidenceRows, "mainnet", founderAddresses(list)) === mainnet.length) {
        expect(paragraph).to.contain("All of it is founder-run");
        expect(paragraph).to.contain("0 paid calls by anyone outside the project");
      } else {
        expect(paragraph).to.not.contain("All of it is founder-run");
      }
    }
    expect(lines[5]).to.equal("");
    expect(lines[6]).to.equal("## Contents");
  });

  it("has exactly the required sections, in order", () => {
    expect(headings).to.deep.equal([
      "Contents",
      "The problem",
      "What it does",
      "How it works",
      "Architecture",
      "The pay flow",
      "For MCP builders",
      "For agents",
      "The example paid tools",
      "Web app",
      "What the owner can and cannot do",
      "What QIE provides",
      "How this differs",
      "Current status",
      "Evidence",
      "Safety and tests",
      "Quick start",
      "Going live",
      "Environment variables",
      "Repository layout",
      "Built for the QIE Hackathon",
      "License",
    ]);
  });

  it("lists every section in the contents, with links that point at real headings", () => {
    const links = [...section(README, "Contents").matchAll(/^- \[([^\]]+)\]\(#([^)]+)\)$/gm)].map((m) => [m[1], m[2]]);
    expect(links.map((l) => l[0])).to.deep.equal(headings.slice(1));
    for (const [name, anchor] of links) expect(anchor, name).to.equal(slug(name as string));
    for (const [name, anchor] of links) {
      expect(headings.map(slug), `${name} -> #${anchor}`).to.include(anchor);
    }
  });

  it("has a principles table", () => {
    const body = section(README, "What it does");
    expect(body).to.contain("| Principle | What it means |");
    expect((body.match(/^\| [A-Z]/gm) ?? []).length).to.be.greaterThan(6);
  });

  it("has an architecture table whose every path exists", () => {
    const body = section(README, "Architecture");
    expect(body).to.contain("| Part | Path | What it does |");
    const paths = [...body.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string).filter((p) => p.includes("/"));
    expect(paths.length).to.be.greaterThan(10);
    for (const path of paths) expect(existsSync(join(root, path)), path).to.equal(true);
  });

  it("describes the pay flow as numbered steps", () => {
    const steps = [...section(README, "The pay flow").matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    expect(steps).to.deep.equal([1, 2, 3, 4, 5, 6, 7]);
  });

  it("says what the owner can and cannot do, and points at the one power outside Sluice", () => {
    const body = section(README, "What the owner can and cannot do");
    expect((body.match(/^\| Can \|/gm) ?? []).length).to.equal(2);
    expect((body.match(/^\| Cannot \|/gm) ?? []).length).to.equal(4);
    expect(body).to.contain("docs/RISKS.md");
    expect(body).to.match(/QUSDC's own admin/);
  });

  it("says what QIE provides: QUSDC, QIE ID, QIE Wallet and relayers", () => {
    const body = section(README, "What QIE provides");
    for (const word of ["QUSDC", "QIE ID", "QIE Wallet", "Relayers"]) expect(body, word).to.contain(word);
    expect(body).to.contain("0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5");
  });

  it("discloses that Claude Code wrote and tested the code, points at the founder log, names the libraries, and states the track", () => {
    const body = section(README, "Built for the QIE Hackathon");
    expect(body).to.contain("Claude Code, Anthropic's coding agent, wrote and tested the code");
    expect(body).to.contain("docs/FOUNDER-LOG.md");
    expect(body).to.contain("AI and Autonomous Agents");
    expect(body).to.match(/QIE Hackathon 3\.0/);
    expect(body).to.match(/Nothing was copied or imported from another project/);
    expect(body).to.contain("Libraries and tools");
  });

  it("names library versions that match package.json", () => {
    const body = section(README, "Built for the QIE Hackathon");
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    const versions = { ...pkg.dependencies, ...pkg.devDependencies };
    const named: Array<[string, string]> = [
      ["Hardhat", "hardhat"],
      ["ethers", "ethers"],
      ["hardhat-ethers", "@nomicfoundation/hardhat-ethers"],
      ["hardhat-chai-matchers", "@nomicfoundation/hardhat-chai-matchers"],
      ["hardhat-network-helpers", "@nomicfoundation/hardhat-network-helpers"],
      ["chai", "chai"],
      ["solc", "solc"],
      ["TypeScript", "typescript"],
      ["ts-node", "ts-node"],
      ["cross-env", "cross-env"],
      ["tsconfig-paths", "tsconfig-paths"],
      ["@modelcontextprotocol/sdk", "@modelcontextprotocol/sdk"],
      ["zod", "zod"],
    ];
    for (const [display, pkgName] of named) {
      const match = new RegExp(`(?<![\\w-])${display} (\\d+\\.\\d+\\.\\d+)`).exec(body);
      expect(match, `${display} has a version in the README`).to.not.equal(null);
      expect(match![1], display).to.equal(versions[pkgName]);
    }
  });
});

describe("Docs: the diagrams", () => {
  const diagrams = [...README.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1] as string);

  it("has a flow diagram and a sequence diagram, and nothing else", () => {
    expect(diagrams).to.have.length(2);
    expect(diagrams[0]).to.match(/^flowchart (LR|TD)\n/);
    expect(diagrams[1]).to.match(/^sequenceDiagram\n/);
  });

  it("is well formed: quotes and brackets balance on every line, and no tabs", () => {
    for (const diagram of diagrams) {
      expect(diagram).to.not.contain("\t");
      for (const line of diagram.split("\n")) {
        expect((line.match(/"/g) ?? []).length % 2, `quotes in: ${line}`).to.equal(0);
        for (const [open, close] of [["[", "]"], ["(", ")"], ["{", "}"]] as const) {
          expect((line.match(new RegExp(`\\${open}`, "g")) ?? []).length, `${open}${close} in: ${line}`).to.equal(
            (line.match(new RegExp(`\\${close}`, "g")) ?? []).length,
          );
        }
      }
    }
  });

  it("shows every part the architecture names, and the main steps of the flow", () => {
    const flow = diagrams[0] as string;
    for (const word of ["PaymentRouter", "AgentVault", "deposit", "settle", "withdraw", "refund"]) expect(flow, word).to.contain(word);
    const sequence = diagrams[1] as string;
    for (const word of ["authorize", "settle", "consume", "Settled"]) expect(sequence, word).to.contain(word);
  });
});

describe("Docs: the status table and the evidence agree", () => {
  const rows = parseStatusTable(README);

  it("has a status table", () => {
    expect(rows).to.not.equal(undefined);
    expect(rows!.length).to.be.greaterThan(8);
  });

  it("passes the rules: exact words, Live only with a verified mainnet row, files that exist", () => {
    expect(checkStatusTable(rows!, evidenceRows, (path) => existsSync(join(root, path)))).to.deep.equal([]);
  });

  it("marks nothing Live while docs/EVIDENCE.md has no mainnet row", () => {
    const live = rows!.filter((r) => r.status === "Live");
    if (mainnetRows === 0) expect(live).to.deep.equal([]);
    expect(rows!.some((r) => r.status === "Tested on a fork")).to.equal(true);
    expect(rows!.some((r) => r.status === "Coming soon")).to.equal(true);
  });

  it("states the verified row counts, and they match docs/EVIDENCE.md", () => {
    const line = /Verified rows in docs\/EVIDENCE\.md: mainnet (\d+), testnet (\d+)\./.exec(section(README, "Evidence"));
    expect(line, "the Evidence section has the count line").to.not.equal(null);
    expect([Number(line![1]), Number(line![2])]).to.deep.equal([mainnetRows, testnetRows]);
  });

  it("says beside the counts how many rows are the project's own, and which list says so, as the two files have it", () => {
    const list = parseFounderList(JSON.parse(read("docs/founder-wallets.json")));
    const own = ownRowCount(evidenceRows, "mainnet", founderAddresses(list));
    const body = section(README, "Evidence");
    const said = /Of the mainnet rows, (\d+) (?:is|are) about wallets on that list/.exec(body);
    expect(Number(said?.[1]), "the count of the project's own rows").to.equal(own);
    expect(body).to.contain(`The list is at version ${list.version} and holds ${list.wallets.length} wallets`);
    expect(body).to.not.contain("The list is empty");
    // Wherever the README lists the recorded rows, it says whose they are: all of them, only while that is so.
    const places = README.split(/\r?\n/).filter((l) => /rows? for the deployment, the router's source|rows are for the deployment, the router's source/.test(l));
    expect(places).to.have.length(3);
    for (const line of places) {
      if (own === mainnetRows && own > 0) expect(line).to.match(/all (of those rows are )?about the project's own wallets/i);
      else expect(line).to.not.match(/all (of those rows are )?about the project's own wallets/i);
    }
  });

  it("says in the evidence file that a row of a listed wallet shows no use by anyone else", () => {
    const page = read("docs/EVIDENCE.md");
    expect(page).to.contain("A row shows that a transaction happened. It does not show that anyone outside the project used Sluice");
    expect(page).to.contain("[founder list](founder-wallets.json)");
  });

  it("keeps the evidence file's table of claims in one piece, with a row for every claim the recorder knows", () => {
    // A paragraph put between its rows ends the table there: the rows after it then show as text with bars in it, on the page too.
    const claims = read("docs/EVIDENCE.md").replace(/\r\n/g, "\n").split(/^## Claims$/m)[1]!.split(/^## /m)[0]!;
    const tables = claims.split("\n\n").filter((block) => block.trimStart().startsWith("|"));
    expect(tables, "one table").to.have.length(1);
    const named = [...tables[0]!.matchAll(/^\| `([a-z-]+)` \|/gm)].map((m) => m[1] as string);
    expect([...named].sort()).to.deep.equal([...CLAIM_TYPES].sort());
    expect(claims.split("\n").filter((l) => l.startsWith("|")), "no line of a table outside it").to.have.length(named.length + 2);
  });

  it("says in evidence-related documents nothing that takes the list for empty", () => {
    for (const file of ["README.md", ...safeReaddir(join(root, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`)]) {
      expect(read(file), file).to.not.match(/founder list (version 1 )?\(0 wallets\)|list (is|being) empty|which is empty until you add them/i);
    }
  });

  it("says in the evidence section that nothing is claimed beyond the rows", () => {
    const body = section(README, "Evidence");
    expect(body).to.contain("pnpm evidence:check");
    expect(body).to.match(/read-only/);
  });

  describe("controls: the rules reject what they should", () => {
    const evidence = (network: "mainnet" | "testnet", event: string): EvidenceRow => ({
      network, date: "2026-12-01T10:00:00Z", event, hash: `0x${"ab".repeat(32)}`, block: "1",
      contract: `0x${"11".repeat(20)}`, amount: "1.000000", who: `0x${"22".repeat(20)}`,
    });
    const row = (status: string, evidence_: string, surface = "x"): StatusRow => ({ surface, status, evidence: evidence_, line: 1 });
    const none = () => false;
    const yes = () => true;

    it("rejects Live with no evidence named", () => {
      expect(checkStatusTable([row("Live", "—")], [], yes)[0]).to.match(/Live needs evidence events/);
    });
    it("rejects Live when the only matching row is on testnet", () => {
      expect(checkStatusTable([row("Live", "docs/EVIDENCE.md: Deposited")], [evidence("testnet", "Deposited")], yes)[0]).to.match(
        /no verified mainnet Deposited row/,
      );
    });
    it("rejects Live when a named event has no mainnet row, even if another has", () => {
      const problems = checkStatusTable([row("Live", "Deposited, Settled")], [evidence("mainnet", "Deposited")], yes);
      expect(problems).to.have.length(1);
      expect(problems[0]).to.match(/mainnet Settled row/);
    });
    it("accepts Live when every named event has a mainnet row", () => {
      const rows_ = [evidence("mainnet", "Deposited"), evidence("mainnet", "Settled")];
      expect(checkStatusTable([row("Live", "`Deposited`, `Settled`")], rows_, yes)).to.deep.equal([]);
    });
    it("rejects a status that is not one of the three words", () => {
      for (const word of ["live", "Shipped", "In progress", "Deployed", "Beta", ""]) {
        expect(checkStatusTable([row(word, "—")], [], yes)[0], word).to.match(/status must be one of/);
      }
      expect(STATUSES).to.deep.equal(["Live", "Tested on a fork", "Coming soon"]);
    });
    it("rejects Coming soon with evidence, and a fork status pointing at nothing", () => {
      expect(checkStatusTable([row("Coming soon", "test/x.ts")], [], yes)[0]).to.match(/must have — as its evidence/);
      expect(checkStatusTable([row("Tested on a fork", "`test/missing.ts`")], [], none)[0]).to.match(/must point at a file that exists/);
      expect(checkStatusTable([row("Tested on a fork", "")], [], yes)[0]).to.match(/must point at a file that exists/);
    });
  });
});

describe("Docs: claims nobody can back up are not made", () => {
  // docs/PREBUILD-VERIFICATION.md is a dated record of checks that quotes other parties' claims word for word ("best", "audited" and
  // the like appear inside quotations of what vendors say). It is kept as supplied, so it is not scanned for Sluice's own claims.
  const EXEMPT = new Set(["docs/PREBUILD-VERIFICATION.md"]);
  const files = [
    "README.md",
    "DECISIONS.md",
    ...safeReaddir(join(root, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`),
    "design/PALETTE.md",
    ...["packages/sdk", "packages/facilitator", "packages/proxy", "packages/wallet-mcp", "examples/paid-tools"].map((d) => `${d}/README.md`),
  ].filter((f) => !EXEMPT.has(f));

  it("exempts exactly one file, and says which", () => {
    expect([...EXEMPT]).to.deep.equal(["docs/PREBUILD-VERIFICATION.md"]);
  });

  for (const file of files) {
    it(`${file} has no banned claim and no deployment claim without a mainnet row`, () => {
      expect(scanClaims(file, read(file), mainnetRows, vaultShown)).to.deep.equal([]);
    });
  }

  describe("controls: the scanner catches what it should and leaves honest text alone", () => {
    const flagged = (text: string, rows = 0) => scanClaims("x.md", text, rows).map((f) => f.rule);
    const bad: string[] = [
      "The first payment network on QIE.",
      "This is the only way to pay an agent.",
      "A unique design.",
      "A world's first.",
      "It earns yield for depositors.",
      "Up to 12% APY.",
      "Pays interest on balances.",
      "Fully compliant with the rules.",
      "Regulated and licensed.",
      "KYC and AML are handled.",
      "Audited by a leading firm.",
      "Funds are guaranteed.",
      "A risk-free way to pay.",
      "A trustless router.",
      "Battle-tested and production-ready.",
      "The best option on QIE.",
    ];
    for (const text of bad) it(`flags: ${text}`, () => expect(flagged(text, 1).length, text).to.be.greaterThan(0));

    it("flags a deployment claim while there is no mainnet row, and allows it once there is one", () => {
      for (const text of ["Sluice is live on QIE mainnet.", "The router is deployed to QIE mainnet.", "It is now live.", "Running on mainnet in production."]) {
        expect(flagged(text, 0), text).to.include("no deployment claim without a mainnet evidence row");
        expect(flagged(text, 1), `${text} with a row`).to.not.include("no deployment claim without a mainnet evidence row");
      }
    });

    it("flags a claim that the vault is verified on the explorer whatever the evidence file holds, and leaves a denial of it alone", () => {
      for (const text of ["The vault is verified on the explorer.", "Both contracts are verified.", "Verified source for PaymentRouter and AgentVault.", "Verify the router's and the vault's source."]) {
        for (const rows of [0, 3]) expect(flagged(text, rows), `${text} with ${rows} rows`).to.include("no claim that the vault is verified on the explorer");
      }
      for (const text of ["The vault is not verified on the explorer.", "Nothing is submitted for the vault.", "The explorer shows verified source for the router."]) {
        expect(flagged(text, 3), text).to.not.include("no claim that the vault is verified on the explorer");
      }
      // With the explorer's answer on file, the claim has to be the explorer's; the file's rows still play no part.
      const withRecord = (text: string, rows: number) => scanClaims("x.md", text, rows, true).map((f) => f.rule);
      for (const rows of [0, 3]) {
        expect(withRecord("The vault is verified.", rows)).to.deep.equal(["a claim that the vault is verified must say that the explorer shows it"]);
        expect(withRecord("QIE's explorer showed verified source for the vault.", rows)).to.deep.equal([]);
      }
    });

    it("leaves honest sentences alone", () => {
      const fine = [
        "Nothing is live yet.",
        "It has not been deployed to any QIE network.",
        "No outside security review has been done.",
        "A surface is marked Live only when the evidence file holds a verified mainnet row.",
        "| Deposit, first for this payer | 112,937 | 0.00012705 | $0.00002088 |",
        "The owner can change the fee and the fee recipient, and nothing else.",
        "```bash\nyield interest APY\n```",
      ];
      for (const text of fine) expect(scanClaims("x.md", text, 0), text).to.deep.equal([]);
    });

    it("keeps its rule list non-empty and every rule named", () => {
      expect(BANNED.length).to.be.greaterThan(8);
      for (const rule of BANNED) expect(rule.rule.length).to.be.greaterThan(5);
    });
  });
});

describe("Docs: commands, variables and layout are real", () => {
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  const builtin = new Set(["install", "exec", "add", "remove", "dlx", "run"]);

  it("every pnpm command in the README is a script in package.json or a pnpm built-in", () => {
    const commands = [...README.matchAll(/^pnpm ([\w:-]+)/gm)].map((m) => m[1] as string);
    expect(commands.length).to.be.greaterThan(6);
    for (const command of commands) {
      expect(builtin.has(command) || command in pkg.scripts, `pnpm ${command}`).to.equal(true);
    }
    for (const script of ["compile", "typecheck", "test", "test:fork", "gas:report", "evidence:check", "verify"]) {
      expect(pkg.scripts, script).to.have.property(script);
    }
  });

  it("the scripts the README runs with ts-node exist", () => {
    const run = [...README.matchAll(/pnpm exec ts-node (\S+)/g)].map((m) => m[1] as string);
    expect(run.sort()).to.deep.equal(["scripts/live/deploy.ts", "scripts/live/smoke.ts"]);
    for (const file of run) expect(existsSync(join(root, file)), file).to.equal(true);
  });

  describe("environment variables", () => {
    // .env.example holds names and no values, and it is the one env file a test reads. A failure here gives a file's name and a line number,
    // and never what the line says: only the name before the first "=" is kept.
    const declared = read(".env.example")
      .split("\n")
      .flatMap((text, i) => {
        const m = /^([A-Z][A-Z0-9_]*)=/.exec(text);
        return m ? [{ name: m[1] as string, at: `.env.example:${i + 1}`, empty: text.length === m[0].length }] : [];
      });
    const declaredNames = new Set(declared.map((d) => d.name));

    it(".env.example holds names only, never a value", () => {
      expect(declared.length).to.be.greaterThan(10);
      expect(declared.filter((d) => !d.empty).map((d) => d.at), "lines that hold a value").to.deep.equal([]);
      expect(/^\.env$/m.test(read(".gitignore")), ".gitignore ignores .env").to.equal(true);
      expect(/^!\.env\.example$/m.test(read(".gitignore")), ".gitignore keeps .env.example").to.equal(true);
    });

    it("the README table lists exactly the names in .env.example", () => {
      const lines = README.split("\n");
      const from = lines.indexOf("## Environment variables");
      const to = lines.findIndex((l, i) => i > from && l.startsWith("## "));
      const inReadme = lines.flatMap((text, i) => {
        const m = i > from && i < to ? /^\| `([A-Z][A-Z0-9_]*)` \|/.exec(text) : null;
        return m ? [{ name: m[1] as string, at: `README.md:${i + 1}` }] : [];
      });
      const tableNames = new Set(inReadme.map((r) => r.name));
      expect(declared.filter((d) => !tableNames.has(d.name)).map((d) => d.at), "names the README table does not list").to.deep.equal([]);
      expect(inReadme.filter((r) => !declaredNames.has(r.name)).map((r) => r.at), "names .env.example does not declare").to.deep.equal([]);
      expect(inReadme.length, "no name twice in either").to.equal(declared.length);
    });

    it("every variable the code reads is declared in .env.example", () => {
      const files = [
        "hardhat.config.ts",
        ...["src", "scripts", "scripts/live", "scripts/evidence", "scripts/client", "test/helpers", "test/fork", "packages/sdk/src", "packages/facilitator/src", "packages/proxy/src", "packages/wallet-mcp/src", "examples/paid-tools/src", "apps/web/src", "apps/web/src/lib", "apps/web/src/app/evidence"].flatMap((dir) =>
          safeReaddir(join(root, dir)).filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => `${dir}/${f}`),
        ),
      ];
      /** Each name the code reads, with the first place it is read. */
      const used = new Map<string, string>();
      for (const file of files) {
        read(file).split("\n").forEach((line, i) => {
          if (line.trim().startsWith("//")) return;
          for (const rule of [/process\.env\.([A-Z][A-Z0-9_]*)/g, /process\.env\["([A-Z][A-Z0-9_]*)"\]/g, /\b(SLUICE_[A-Z0-9_]+|EVIDENCE_RPC_URL|NEXT_PUBLIC_[A-Z0-9_]+)\b/g]) {
            for (const m of line.matchAll(rule)) if (!used.has(m[1] as string)) used.set(m[1] as string, `${file}:${i + 1}`);
          }
        });
      }
      used.delete("NODE_ENV");
      expect(used.size).to.be.greaterThan(10);
      expect([...used].filter(([name]) => !declaredNames.has(name)).map(([, at]) => at), "places that read a name .env.example does not declare").to.deep.equal([]);
      expect(declared.filter((d) => !used.has(d.name)).map((d) => d.at), "names declared that no code reads").to.deep.equal([]);
    });

    it("no file in the repository assigns a value to SLUICE_KEY, SLUICE_RELAYER_KEY or SLUICE_AGENT_KEY", () => {
      // Secret files are skipped by their names, before anything is opened, so of the env files this reads .env.example alone.
      const walk = (dir: string): string[] =>
        safeReaddir(join(root, dir)).flatMap((name) => {
          if (["node_modules", "artifacts", "cache", "dist", ".git", ".next"].includes(name)) return [];
          const rel = dir ? `${dir}/${name}` : name;
          return statSync(join(root, rel)).isDirectory() ? walk(rel) : [rel];
        });
      const files = walk("").filter((f) => /\.(ts|md|json|example|yaml|sol)$/.test(f));
      expect(files).to.include(".env.example");
      expect(files.filter((f) => /(^|\/)\.env/.test(f)), "the env files read").to.deep.equal([".env.example"]);
      const found: string[] = [];
      for (const file of files) {
        const text = read(file);
        for (const m of text.matchAll(/SLUICE_(RELAYER_|AGENT_)?KEY\s*=\s*['"]?0x[0-9a-fA-F]{8,}/g)) found.push(`${file}:${text.slice(0, m.index).split("\n").length}`);
      }
      expect(found, "lines that assign a key").to.deep.equal([]);
    });
  });

  describe("repository layout", () => {
    const body = section(README, "Repository layout");
    const block = /```text\n([\s\S]*?)```/.exec(body)![1] as string;
    const listed = new Set<string>();
    const stack: string[] = [];
    for (const line of block.split("\n")) {
      if (!line.trim()) continue;
      const indent = (line.length - line.trimStart().length) / 2;
      const name = line.trim().split(/\s+/)[0] as string;
      stack.length = indent;
      stack[indent] = name;
      listed.add(stack.join(""));
    }

    it("every path in the layout exists", () => {
      expect(listed.size).to.be.greaterThan(40);
      for (const path of listed) expect(existsSync(join(root, path)), path).to.equal(true);
    });

    it("every source file in the repository is in the layout", () => {
      // Build output and generated files are git-ignored, so they are not part of the source. The screenshots folder is listed, but its
      // images are not named one by one.
      // The rehearsal's state file and its folder are git-ignored too. Secret files (key files, env files, the deployment record and the
      // local run's folder) are left out by safeReaddir, and none of them is ever listed in a document.
      const ignored = new Set(["node_modules", "artifacts", "cache", "dist", ".git", "evidence-draft.json", "testnet-token.json", "rehearsal-state.json", ".rehearsal", ".next", "generated", "fonts", "test-results", "next-env.d.ts"]);
      const walk = (dir: string): string[] =>
        safeReaddir(join(root, dir)).flatMap((name) => {
          if (ignored.has(name) || name.endsWith(".tsbuildinfo")) return [];
          const rel = dir ? `${dir}/${name}` : name;
          if (dir === "design/screenshots/slice3" || dir === "design/screenshots/slice5") return [];
          return statSync(join(root, rel)).isDirectory() ? walk(rel) : [rel];
        });
      for (const file of walk("")) expect(listed.has(file), `${file} is missing from the README layout`).to.equal(true);
    });
  });
});

describe("Docs: the test counts the README states are the real counts", function () {
  this.timeout(180_000);

  /** Lists the tests in a folder without running them, using Mocha's dry-run mode through the Hardhat config. */
  function count(dir: "test/unit" | "test/fork"): number {
    const file = join(tmpdir(), `sluice-count-${process.pid}-${dir.replace("/", "-")}.json`);
    const env: NodeJS.ProcessEnv = { ...process.env, SLUICE_COUNT_FILE: file, SLUICE_TEST_DIR: dir };
    delete env.FORK;
    const run = spawnSync(process.execPath, [require.resolve("hardhat/internal/cli/bootstrap.js"), "test", "--no-compile"], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    expect(existsSync(file), `the count run wrote its totals: ${run.stderr.slice(0, 300)}`).to.equal(true);
    const stats = (JSON.parse(readFileSync(file, "utf8")) as { stats: { tests: number; failures: number } }).stats;
    expect(stats.failures, "a count-only run runs nothing, so nothing fails").to.equal(0);
    return stats.tests;
  }

  const stated = (command: string) => {
    const match = new RegExp(`\`${command}\` runs \\*\\*(\\d+)\\*\\* tests`).exec(section(README, "Safety and tests"));
    expect(match, `the README states how many tests ${command} runs`).to.not.equal(null);
    return Number(match![1]);
  };

  it("pnpm test runs as many tests as the README says", () => {
    expect(count("test/unit")).to.equal(stated("pnpm test"));
  });

  it("pnpm test:fork runs as many tests as the README says", () => {
    expect(count("test/fork")).to.equal(stated("pnpm test:fork"));
  });
});

describe("Docs: the gas report", () => {
  const report = parseGasReport(read("docs/GAS.md"));

  it("has every operation, in order, and a batch of 1, 10 and 50 in both scenarios", () => {
    expect(report.singles.map((s) => s.label)).to.deep.equal([...SINGLE_OPERATIONS]);
    for (const scenario of ["A", "B"] as const) {
      expect(report.batches.filter((b) => b.scenario === scenario).map((b) => b.size)).to.deep.equal([...BATCH_SIZES]);
    }
  });

  it("states a basis: the gas price, the QIE price, the block it was measured at, and where each came from", () => {
    expect(report.gasPriceWei).to.be.greaterThan(0n);
    expect(report.qiePriceMicroUsd).to.be.greaterThan(0n);
    expect(report.forkBlock).to.be.greaterThan(11_000_000);
    expect(report.blockGasLimit).to.be.greaterThan(0n);
    const md = read("docs/GAS.md");
    expect(md).to.match(/\| Gas price \| [\d.]+ gwei \| .+ \|/);
    expect(md).to.match(/\| QIE price \| \$\d+\.\d{6} \| .+ \|/);
    expect(md).to.contain("Nothing was sent to QIE");
  });

  it("every cost in the file is exactly the gas times the stated gas price and QIE price", () => {
    const { gasPriceWei: price, qiePriceMicroUsd: usd } = report;
    for (const s of report.singles) {
      expect(s.qie, `${s.label} QIE`).to.equal(qieCost(s.gas, price));
      expect(s.usd, `${s.label} USD`).to.equal(usdCost(s.gas, price, usd));
    }
    for (const b of report.batches) {
      const per = b.gas / BigInt(b.size);
      expect(b.perIntent, `batch ${b.size} per intent`).to.equal(per);
      expect(b.qie, `batch ${b.size} QIE`).to.equal(qieCost(per, price));
      expect(b.usd, `batch ${b.size} USD`).to.equal(usdCost(per, price, usd));
    }
  });

  it("states the cost of a start with no QIE, from the SDK's signed gas limits and the measured transfer, and quotes no stale limit", () => {
    expect(START_APPROVE_GAS_LIMIT, "the report's approve limit is the SDK's").to.equal(ONBOARD_APPROVE_GAS);
    expect(START_DEPOSIT_GAS_LIMIT, "the report's deposit limit is the SDK's").to.equal(ONBOARD_DEPOSIT_GAS);
    const transfer = report.singles.find((s) => s.label.startsWith("QIE top-up transfer"))!.gas;
    const md = read("docs/GAS.md");
    expect(md).to.contain(`${qieCost(SIGNED_START_GAS + transfer, report.gasPriceWei)} QIE in all`);
    expect(md).to.contain(`(${withCommas(SIGNED_START_GAS)} gas at the price above, ${qieCost(SIGNED_START_GAS, report.gasPriceWei)} QIE)`);
  });

  it("the numbers are consistent with each other", () => {
    const gas = (label: string) => report.singles.find((s) => s.label === label)!.gas;
    expect(gas("Deposit, first for this payer")).to.be.greaterThan(gas("Deposit, later"));
    expect(gas("Settle, first payment to a builder")).to.be.greaterThan(gas("Settle, later payment"));
    expect(gas("QUSDC transfer to a new holder (for comparison)")).to.be.within(50_000n, 54_000n);
    expect(gas("QUSDC transfer to an existing holder (for comparison)")).to.be.within(33_000n, 37_000n);
    expect(gas("QIE top-up transfer by a facilitator, for a wallet with no QIE"), "a plain transfer of QIE costs 21,000 gas").to.equal(21_000n);
    for (const scenario of ["A", "B"] as const) {
      const rows = report.batches.filter((b) => b.scenario === scenario);
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i]!.gas).to.be.greaterThan(rows[i - 1]!.gas);
        expect(rows[i]!.perIntent).to.be.lessThanOrEqual(rows[i - 1]!.perIntent);
      }
    }
    const a50 = report.batches.find((b) => b.scenario === "A" && b.size === 50)!;
    const b50 = report.batches.find((b) => b.scenario === "B" && b.size === 50)!;
    expect(b50.gas, "different payers and builders cost more than one pair").to.be.greaterThan(a50.gas);
  });

  it("does the cost arithmetic exactly, with no floating point", () => {
    expect(qieCost(100_000n, 1_125_000_000n)).to.equal("0.00011250");
    expect(usdCost(100_000n, 1_125_000_000n, 164_378n)).to.equal("0.00001849");
    expect(usdCost(0n, 1_125_000_000n, 164_378n)).to.equal("0.00000000");
    expect(formatGwei(1_125_000_000n)).to.equal("1.125 gwei");
    expect(formatMicro(164_378n)).to.equal("$0.164378");
    expect(withCommas(4_294_967_295n)).to.equal("4,294,967,295");
  });

  it("writes a report that reads back to the same numbers", () => {
    const basis = {
      date: "2026-01-01", forkBlock: 12_000_000, blockGasLimit: 4_294_967_295n, gasPriceWei: 2_000_000_000n,
      gasPriceSource: "a test", qiePriceMicroUsd: 500_000n, qiePriceSource: "a test",
    };
    const singles = SINGLE_OPERATIONS.map((label, i) => ({ label, gas: 50_000n + BigInt(i) * 1_111n }));
    const batches = (["A", "B"] as const).flatMap((scenario) => BATCH_SIZES.map((size) => ({ scenario, size, gas: BigInt(size) * 60_000n + 21_000n })));
    const parsed = parseGasReport(renderGasReport(basis, singles, batches));
    expect(parsed.gasPriceWei).to.equal(2_000_000_000n);
    expect(parsed.qiePriceMicroUsd).to.equal(500_000n);
    expect(parsed.forkBlock).to.equal(12_000_000);
    expect(parsed.singles.map((s) => s.gas)).to.deep.equal(singles.map((s) => s.gas));
    expect(parsed.batches.map((b) => b.gas)).to.deep.equal(batches.map((b) => b.gas));
    expect(parsed.singles[0]!.qie).to.equal(qieCost(singles[0]!.gas, 2_000_000_000n));
  });
});

describe("Docs: the risks document says what the tests and the chain showed", () => {
  const risks = read("docs/RISKS.md");

  it("names QUSDC's admin power with the real addresses and role", () => {
    expect(risks).to.match(/^## 1\. QUSDC's admin can burn any holder's balance/m);
    for (const needle of [
      "0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5",
      "0xdC20F1fee9e03184ddabcCe96F01E3c570E43D45",
      "0xe1acec6312eb701D4A14De700CCec8DeE17a8D28",
      "VAULT_ROLE",
      "DEFAULT_ADMIN_ROLE",
      "burn(address,uint256)",
      "solvency()",
    ]) {
      expect(risks, needle).to.contain(needle);
    }
  });

  it("every file it cites as a test exists", () => {
    const cited = [...risks.matchAll(/`(test\/[^`]+)`/g)].map((m) => m[1] as string);
    expect(cited.length).to.be.greaterThan(3);
    for (const path of cited) expect(existsSync(join(root, path)), path).to.equal(true);
  });

  it("has a table of what the owner can and cannot do, and a list of what was not tested", () => {
    expect(risks).to.match(/^## 2\. What the Sluice owner can and cannot do/m);
    expect((risks.match(/^\| Can \|/gm) ?? []).length).to.equal(2);
    expect((risks.match(/^\| Cannot \|/gm) ?? []).length).to.equal(5);
    expect(risks).to.match(/^## 7\. What was not tested/m);
    // What was not tested on the live chain follows the evidence file.
    if (mainnetRows === 0) expect(risks).to.contain("Anything on QIE mainnet or testnet");
    else {
      expect(risks).to.contain("Anything on QIE mainnet beyond what the rows of `docs/EVIDENCE.md` show");
      expect(risks).to.not.match(/has no rows|has never been written|row has never been written/i);
    }
  });

  it("names exactly the kinds of claim that have a mainnet row, and the ones that have none, as the evidence file does", () => {
    const kinds: string[] = [...CLAIM_TYPES];
    // A claim cell may carry more after the claim type (a top-up's hash, a tool's name).
    const recorded = new Set(evidenceRows.filter((r) => r.network === "mainnet").map((r) => (r.claim ?? "").split(/[\s(:,]+/)[0] ?? ""));
    for (const kind of recorded) expect(kinds, `a claim type this test knows: ${kind}`).to.include(kind);
    if (recorded.size === 0) return;
    const bullet = /- Part of the recorder against a real QIE network\.[\s\S]*?(?=\n- )/.exec(risks.replace(/\r\n/g, "\n"))?.[0] ?? "";
    const [have, rest] = bullet.split("have no mainnet row");
    if (testnetRows === 0) expect(bullet).to.contain("No testnet row has been written");
    if (kinds.every((kind) => recorded.has(kind))) {
      expect(rest, "no kind is said to have no mainnet row when every kind has one").to.equal(undefined);
      const listed = bullet.split("every claim it knows has a mainnet row:")[1]?.split(". ")[0] ?? "";
      for (const kind of kinds) expect(listed, `${kind} is named`).to.contain(`\`${kind}\``);
      return;
    }
    expect(bullet).to.not.contain("every claim it knows has a mainnet row");
    const before = (have ?? "").split(". The claims ");
    for (const kind of kinds) {
      if (recorded.has(kind)) expect(before[0], `${kind} has a mainnet row`).to.contain(`\`${kind}\``);
      else expect(before[1], `${kind} has no mainnet row`).to.contain(`\`${kind}\``);
    }
    expect(rest, "the bullet says where the rest were run").to.not.equal(undefined);
  });

  it("dates every measurement of the live chain", () => {
    expect(risks).to.contain("2026-11-18");
    expect(risks).to.match(/read-only/);
  });
});

describe("Docs: the previous project name appears only in the rename row", () => {
  // The project was renamed on 2026-11-19. This test is the standing search: it finds the old name in any case in
  // every file name and file body of the project, and allows exactly one place, the rename row in DECISIONS.md.
  // The old name is assembled from pieces so that this file does not contain it either.
  const OLD = ["pay", "meter"].join("");
  // "generated" holds copies of the documents (DECISIONS.md and the dated pre-build record), which are checked at their source.
  // Secret files are left out by safeReaddir before anything is opened.
  const skip = new Set(["node_modules", "artifacts", "cache", "dist", ".git", ".next", "generated"]);
  const walk = (dir: string): string[] =>
    safeReaddir(join(root, dir)).flatMap((name) => {
      if (skip.has(name)) return [];
      const rel = dir ? `${dir}/${name}` : name;
      return statSync(join(root, rel)).isDirectory() ? [rel, ...walk(rel)] : [rel];
    });
  const entries = walk("");

  it("no file or folder name contains it, in any case", () => {
    expect(entries.filter((path) => path.toLowerCase().includes(OLD))).to.deep.equal([]);
  });

  // docs/PREBUILD-VERIFICATION.md carries the previous name in its dated title and is kept as supplied (see the claims scan above).
  it("no file contains it, in any case, except DECISIONS.md and the dated pre-build record", () => {
    const hits: string[] = [];
    for (const path of entries) {
      if (statSync(join(root, path)).isDirectory()) continue;
      const bytes = readFileSync(join(root, path));
      if (bytes.includes(0)) continue; // binary
      if (bytes.toString("utf8").toLowerCase().includes(OLD)) hits.push(path);
    }
    expect(hits).to.deep.equal(["DECISIONS.md", "docs/PREBUILD-VERIFICATION.md"]);
  });

  it("in DECISIONS.md it appears only inside the one rename item, which says what changed", () => {
    const lines = read("DECISIONS.md").split("\n");
    const start = lines.findIndex((line) => /^\d+\. \*\*The project was renamed/.test(line));
    expect(start, "the rename is a numbered decision").to.be.greaterThan(-1);
    let end = start + 1;
    while (end < lines.length && lines[end] && !/^\d+\. \*\*/.test(lines[end] as string) && !(lines[end] as string).startsWith("#")) end++;
    const outside = lines.filter((line, i) => (i < start || i >= end) && line.toLowerCase().includes(OLD));
    expect(outside, "no other line may name the old project").to.deep.equal([]);
    const item = lines.slice(start, end).join("\n");
    expect(item.toLowerCase()).to.contain(OLD);
    expect(item).to.contain("2026-11-19");
    expect(item).to.contain("founder decision");
    for (const changed of ["SLUICE_*", "SLUICE_APPROVE", "SluiceRouter", "SluiceAgentVault", "ISluiceErrors"]) {
      expect(item, changed).to.contain(changed);
    }
  });
});

describe("Docs: the README says nothing is Live without a verified evidence row", () => {
  const rows = parseStatusTable(README)!;
  const tableLines = new Set(rows.map((r) => r.line));

  it("fails the build if any surface is marked Live and docs/EVIDENCE.md has no verified mainnet row for it", () => {
    expect(checkStatusTable(rows, evidenceRows, (path) => existsSync(join(root, path)))).to.deep.equal([]);
    if (mainnetRows === 0) expect(rows.filter((r) => r.status === "Live")).to.deep.equal([]);
  });

  it("finds no Live status, and no unconditional use of the word, anywhere else in the README or the package READMEs", () => {
    for (const file of ["README.md", "packages/sdk/README.md", "packages/facilitator/README.md", "packages/proxy/README.md", "packages/wallet-mcp/README.md", "examples/paid-tools/README.md", "docs/SPEC.md"]) {
      expect(scanLiveWord(file, read(file), mainnetRows, file === "README.md" ? tableLines : new Set()), file).to.deep.equal([]);
    }
  });

  describe("controls: the scan catches what it should and leaves honest text alone", () => {
    const found = (text: string, rows_ = 0) => scanLiveWord("x.md", text, rows_).map((f) => f.rule);
    it("flags a Live status in another table, even with evidence-sounding words around it", () => {
      expect(found("| Part | Status |\n| --- | --- |\n| Proxy | Live |")).to.deep.equal(["no Live status outside the status table"]);
      expect(found("| Proxy | Live | after the evidence |", 1)).to.deep.equal(["no Live status outside the status table"]);
    });
    it("flags a sentence that says something is Live while there is no mainnet row, and allows it once there is one", () => {
      expect(found("The proxy is Live for everyone.")).to.deep.equal(["no unconditional Live without a mainnet evidence row"]);
      expect(found("The proxy is Live for everyone.", 1)).to.deep.equal([]);
    });
    it("leaves conditional and negated sentences alone", () => {
      for (const text of [
        "Nothing is Live yet.",
        "A surface is marked Live only when docs/EVIDENCE.md holds a verified mainnet row for it. None does, so no surface is marked Live.",
        "It will be Live after the evidence exists.",
        "```text\n| X | Live |\n```",
      ]) {
        expect(found(text), text).to.deep.equal([]);
      }
    });
    it("leaves the status table to checkStatusTable", () => {
      const status = "| Surface | Status | Evidence |\n| --- | --- | --- |\n| X | Live | `Deposited` |";
      expect(scanLiveWord("x.md", status, 0, new Set([3])).map((f) => f.rule)).to.deep.equal([]);
      const bad = [{ surface: "X", status: "Live", evidence: "`Deposited`", line: 3 }];
      expect(checkStatusTable(bad, [], () => true)[0]).to.match(/no verified mainnet Deposited row/);
    });
  });
});

describe("Docs: the README does not say what the founder did", () => {
  const body = README;
  // Claims about the founder's own actions are theirs to make in docs/FOUNDER-LOG.md. The README may refer to the log and to the
  // founder's role in what they run (git, the network), but may not say the founder decided, explained, tested or reviewed anything.
  const CLAIMS = /(?:^|[.!?]\s+)The founder (set|made|decided|directed|explained|understood|reviewed|tested|wrote|designed|chose|approved|verified|ran|understands|has explained|has reviewed|has tested|did)\b/m;

  it("has no sentence that attributes decisions, understanding, tests or reviews to the founder", () => {
    expect(CLAIMS.exec(body)?.[0] ?? null).to.equal(null);
  });

  it("controls: the pattern catches such sentences", () => {
    for (const text of ["The founder decided the product.", "The founder explained every contract.", "It was built. The founder reviewed the code.", "The founder set the design."]) {
      expect(CLAIMS.test(text), text).to.equal(true);
    }
    expect(CLAIMS.test("What the founder decided is for the founder to record in the log.")).to.equal(false);
  });

  it("points at a founder log that is a template with the four headings and no entries", () => {
    const log = read("docs/FOUNDER-LOG.md");
    for (const heading of ["## Decisions the founder made", "## Parts the founder has explained", "## Tests the founder ran", "## Reviews"]) {
      expect(log, heading).to.contain(heading);
    }
    expect(log).to.match(/^This file is a template\./m);
    const filled = log.split("\n").filter((l) => /^\| \d{4}-\d{2}-\d{2}/.test(l));
    expect(filled, "no entry has been written for the founder").to.deep.equal([]);
  });
});

describe("Docs: the numbers the README gives about the new tooling are the real ones", () => {
  it("states how many changes the mutation check makes, and it is the length of the list", () => {
    const match = /`pnpm mutation:check` changes one condition at a time in the verification, budget and cap code, (\d+) changes in all/.exec(section(README, "Safety and tests"));
    expect(match, "the README states the number of mutations").to.not.equal(null);
    expect(Number(match![1])).to.equal(MUTATIONS.length);
    expect(read("DECISIONS.md")).to.contain(`It has ${MUTATIONS.length} changes`);
  });

  it("states how many changes the web mutation check makes, and it is the length of its list", () => {
    const match = /`pnpm mutation:web` changes one condition at a time in the web app's logic, (\d+) changes in all/.exec(section(README, "Safety and tests"));
    expect(match, "the README states the number of web mutations").to.not.equal(null);
    expect(Number(match![1])).to.equal(WEB_MUTATIONS.length);
  });

  it("states how many changes the go-live mutation check makes, and it is the length of its list", () => {
    const match = /`pnpm mutation:live` changes one condition at a time in the go-live code, (\d+) changes in all/.exec(section(README, "Safety and tests"));
    expect(match, "the README states the number of go-live mutations").to.not.equal(null);
    expect(Number(match![1])).to.equal(LIVE_MUTATIONS.length);
    // 30 for the journal and the recorder, 43 for the mainnet path's guards and tools, and V01 to V66 for the hosted services' guards.
    // The lower figure is the number there are now, so that none is dropped unnoticed.
    expect(LIVE_MUTATIONS.length).to.be.within(139, 180);
    expect(new Set(LIVE_MUTATIONS.map((m) => m.id)).size, "no two share an id").to.equal(LIVE_MUTATIONS.length);
  });

  it("every web command the README gives is a script, and the web app's own pages and checks exist", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    for (const name of ["lint", "web:content", "web:build", "web:start", "web:dev", "web:e2e", "web:shots", "mutation:web"]) {
      expect(pkg.scripts, name).to.have.property(name);
      expect(README, name).to.contain(`pnpm ${name}`);
    }
    for (const file of ["scripts/web-e2e.ts", "scripts/web-shots.ts", "scripts/mutation-web.ts", "scripts/web-content.ts", "apps/web/scripts/og.mjs"]) {
      expect(existsSync(join(root, file)), file).to.equal(true);
    }
  });

  it("every program the README starts has a script, and each script's file exists once built", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    for (const name of ["start:facilitator", "start:proxy", "start:wallet", "start:paid-tools", "build", "evidence:summary", "mutation:check", "spec:vectors"]) {
      expect(pkg.scripts, name).to.have.property(name);
    }
    for (const dir of ["packages/sdk", "packages/facilitator", "packages/proxy", "packages/wallet-mcp", "examples/paid-tools"]) {
      expect(existsSync(join(root, dir, "tsconfig.json")), `${dir}/tsconfig.json`).to.equal(true);
      expect(existsSync(join(root, dir, "package.json")), `${dir}/package.json`).to.equal(true);
    }
  });

  it("the package versions in every package.json are exact, never a range", () => {
    for (const dir of ["", "packages/sdk", "packages/facilitator", "packages/proxy", "packages/wallet-mcp", "examples/paid-tools"]) {
      const pkg = JSON.parse(read(join(dir, "package.json"))) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
        if (version.startsWith("workspace:")) continue;
        expect(version, `${dir || "root"}: ${name}`).to.match(/^\d+\.\d+\.\d+$/);
      }
    }
  });
});

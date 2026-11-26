// What each component shows in each state, rendered to HTML. The browser tests cover clicking; these cover the words and the links.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";
import * as ts from "typescript";
import type { EvidenceRow } from "../../../src/evidence";
import { BuilderDashboard } from "../../../apps/web/src/components/builder-dashboard";
import { vaultVerifiedClaims } from "../../../src/claims";
import { ContractsNote, EvidenceTable, SummaryView } from "../../../apps/web/src/components/evidence-view";
import { MAINNET, TESTNET } from "../../../apps/web/src/lib/networks";
import { content } from "../../../apps/web/src/lib/content";
import { explorerShowsVault } from "../../../src/vault-record";
import { parseFounderList } from "../../../src/summary";
import { countOwn, ownRowsPhrase, ownRowsSentence } from "../../../apps/web/src/lib/own-rows";
import { Footer } from "../../../apps/web/src/components/footer";
import { PayerDashboard } from "../../../apps/web/src/components/payer-dashboard";
import { EMPTY_MAINNET, FORK_LABEL, ProofStrip } from "../../../apps/web/src/components/proof-strip";
import type { ForkSample } from "../../../apps/web/src/components/proof-strip";
import { RiskResult } from "../../../apps/web/src/components/risk-panel";
import { StatusBadge, StatusGrid } from "../../../apps/web/src/components/status-badge";
import { SimulationBanner } from "../../../apps/web/src/components/demo-simulation";
import { WalletBar } from "../../../apps/web/src/components/wallet-bar";
import { readConfig } from "../../../apps/web/src/lib/config";
import { COMPONENTS } from "../../../apps/web/src/status";
import type { ComponentStatus } from "../../../apps/web/src/status";
import { h, html, textOf, withApp } from "../../../apps/web/test-support/render";

const root = join(__dirname, "..", "..", "..");
const hash = (c: string) => `0x${c.repeat(64)}`;
const who = "0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5";
const row = (network: "mainnet" | "testnet", over: Partial<EvidenceRow> = {}): EvidenceRow => ({
  network,
  date: "2026-12-01T10:00:00Z",
  event: "Settled",
  hash: hash("a"),
  block: "12345",
  contract: who,
  amount: "0.010000",
  who,
  ...over,
});
const sample: ForkSample = {
  source: "local fork",
  note: "From a test run.",
  chainId: 1990,
  rows: [{ event: "Settled", amount: "0.010000", who, hash: hash("b"), block: 7 }],
};

describe("Web components: the proof strip", () => {
  it("says no mainnet transactions are recorded when there are none, and shows no sample it was not given", () => {
    const out = html(h(ProofStrip, { rows: [], sample: null, own: [] }));
    expect(out).to.contain(EMPTY_MAINNET);
    expect(out).to.not.contain("fork-sample");
    expect(out).to.not.contain("explorer");
  });

  it("shows a fork sample only with its label, with no explorer link, and says the hashes are not on QIE", () => {
    const out = html(h(ProofStrip, { rows: [], sample, own: [] }));
    expect(out).to.contain(FORK_LABEL);
    expect(out).to.contain(EMPTY_MAINNET);
    expect(out).to.contain("not on QIE");
    expect(out).to.not.match(/href="https:\/\/mainnet\.qie\.digital\/tx/);
    expect(out).to.contain('data-kind="fork"');
  });

  it("lists a mainnet row with a link to its transaction on the explorer, and hides the fork sample", () => {
    const out = html(h(ProofStrip, { rows: [row("mainnet")], sample, own: [] }));
    expect(out).to.contain(`href="https://mainnet.qie.digital/tx/${hash("a")}"`);
    expect(out).to.contain('data-kind="mainnet"');
    expect(out).to.not.contain(FORK_LABEL);
    expect(out).to.not.contain(EMPTY_MAINNET);
  });

  it("lists a testnet row only as a count, never as a mainnet transaction and never with a link", () => {
    const out = html(h(ProofStrip, { rows: [row("testnet")], sample: null, own: [] }));
    expect(out).to.contain("1 testnet transaction");
    expect(out).to.contain(EMPTY_MAINNET);
    expect(out).to.not.contain("mainnet.qie.digital/tx");
  });

  it("ignores a row whose hash is not a transaction hash", () => {
    const out = html(h(ProofStrip, { rows: [row("mainnet", { hash: "0x1234" })], sample: null, own: [] }));
    expect(out).to.contain(EMPTY_MAINNET);
    expect(out).to.not.contain('data-kind="mainnet"');
  });

  it("shows the newest rows first and no more than its limit", () => {
    const rows = Array.from({ length: 9 }, (_, i) => row("mainnet", { hash: hash(String(i + 1)) }));
    const out = html(h(ProofStrip, { rows, limit: 3, own: [] }));
    expect((out.match(/data-kind="mainnet"/g) ?? []).length).to.equal(3);
    expect(out.indexOf(hash("9").slice(0, 10))).to.be.lessThan(out.indexOf(hash("8").slice(0, 10)));
  });
});

describe("Web components: whose rows they are", () => {
  const mine = `0x${"AA".repeat(20)}`;
  const theirs = `0x${"bb".repeat(20)}`;
  const own = [mine.toLowerCase()];
  const rowsOf = (...whos: string[]) => whos.map((w, i) => row("mainnet", { who: w, hash: hash(String(i + 1)) }));
  const strip = (rows: EvidenceRow[]) => textOf(h(ProofStrip, { rows, own }));
  const table = (rows: EvidenceRow[]) => textOf(h(EvidenceTable, { network: "mainnet", rows, own }));

  it("says under the transactions that all are the project's own, and that none counts as use by anyone else", () => {
    for (const text of [strip(rowsOf(mine, mine)), table(rowsOf(mine, mine))]) {
      expect(text).to.contain("Of the mainnet rows, all are about the project's own wallets, by the founder list.");
      expect(text).to.contain("None of them is counted as use by anyone else.");
    }
  });

  it("says how many are, when only some are, and that none are, when none are", () => {
    for (const view of [strip, table]) {
      expect(view(rowsOf(mine, theirs, theirs))).to.contain("Of the mainnet rows, 1 is about the project's own wallets");
      expect(view(rowsOf(mine, mine, theirs))).to.contain("Of the mainnet rows, 2 are about the project's own wallets");
      expect(view(rowsOf(theirs))).to.contain("Of the mainnet rows, none are about the project's own wallets");
      expect(view(rowsOf(mine, theirs))).to.not.contain("None of them is counted");
    }
  });

  it("matches an address whatever its letter case, counts every row and not only the newest shown, and says nothing with no row", () => {
    expect(countOwn([{ who: mine }, { who: mine.toLowerCase() }, { who: theirs }], own)).to.equal(2);
    const many = rowsOf(theirs, mine, mine, mine, mine, mine, mine, mine);
    expect(textOf(h(ProofStrip, { rows: many, limit: 2, own }))).to.contain("Of the mainnet rows, 7 are about");
    for (const text of [strip([]), table([])]) expect(text).to.not.contain("own wallets");
    expect(ownRowsSentence("testnet", 0, 0)).to.equal("");
    expect(ownRowsPhrase(0, 0)).to.equal("");
    expect([ownRowsPhrase(4, 4), ownRowsPhrase(4, 1), ownRowsPhrase(4, 0)]).to.deep.equal([", all of them about the project's own wallets", ", 1 of them about the project's own wallets", ", none of them about the project's own wallets"]);
  });

  it("says it of testnet rows too, beside their count on the landing page", () => {
    const text = textOf(h(ProofStrip, { rows: [row("testnet", { who: mine })], own }));
    expect(text).to.contain("1 testnet transaction, all of them about the project's own wallets listed on");
  });

  it("passes the pages the published list, and every count of rows on them is followed by what the list finds", () => {
    const published = parseFounderList(JSON.parse(readFileSync(join(root, "docs", "founder-wallets.json"), "utf8")));
    expect(content.ownAddresses).to.deep.equal(published.wallets.map((w) => w.address.toLowerCase()).sort());
    for (const network of ["mainnet", "testnet"] as const) {
      expect(content.evidence.own[network], network).to.equal(countOwn(content.evidence.rows.filter((r) => r.network === network), content.ownAddresses));
    }
    const source = (path: string) => readFileSync(join(root, "apps", "web", "src", ...path.split("/")), "utf8");
    for (const page of ["app/page.tsx", "app/evidence/page.tsx"]) {
      const text = source(page);
      expect(text, page).to.contain("own={content.ownAddresses}");
      // A count of rows written into a page is always followed by the phrase that says how many are the project's own.
      for (const m of text.matchAll(/\{(?:content\.evidence\.)?(mainnet|testnet)\}(.{0,40})/g)) expect(m[2], `${page}: the ${m[1]} count`).to.match(/^\{ownRowsPhrase\(/);
    }
    expect([...source("app/page.tsx").matchAll(/\{(mainnet|testnet)\}/g)].length).to.equal(4);
    expect([...source("app/evidence/page.tsx").matchAll(/\{content\.evidence\.(mainnet|testnet)\}/g)].length).to.equal(2);
  });
});

describe("Web components: status badges", () => {
  const live: ComponentStatus = { ...COMPONENTS[1]!, status: "Live", evidenceEvents: ["Settled"] };

  it("shows every component's real status, and none is Live while the evidence file has no mainnet row", () => {
    const out = html(h(StatusGrid, { rows: [] }));
    for (const c of COMPONENTS) expect(out).to.contain(c.name);
    expect(out).to.not.contain('data-status="Live"');
    expect((out.match(/>Tested on a fork</g) ?? []).length).to.equal(COMPONENTS.length);
  });

  it("shows Live as Coming soon when the typed list says Live and the evidence does not", () => {
    const out = html(h(StatusBadge, { component: live, rows: [] }));
    expect(out).to.contain('data-status="Coming soon"');
    expect(out).to.not.contain(">Live<");
    expect(out).to.contain("No verified mainnet row");
  });

  it("shows Live only with a mainnet row for the event", () => {
    expect(html(h(StatusBadge, { component: live, rows: [{ network: "testnet", event: "Settled" }] }))).to.not.contain(">Live<");
    expect(html(h(StatusBadge, { component: live, rows: [{ network: "mainnet", event: "Settled" }] }))).to.contain('data-status="Live"');
  });
});

describe("Web components: the evidence view", () => {
  it("shows an empty table as empty, with the command that re-checks rows", () => {
    const out = html(h(EvidenceTable, { network: "mainnet", rows: [], own: [] }));
    expect(out).to.contain("No verified rows");
    expect(out).to.contain("pnpm evidence:check");
    expect(out).to.not.contain("<table");
  });

  it("shows a mainnet row with a dated explorer link, and a testnet row without a link", () => {
    const m = html(h(EvidenceTable, { network: "mainnet", rows: [row("mainnet")], own: [] }));
    expect(m).to.contain("2026-12-01T10:00:00Z");
    expect(m).to.contain(`https://mainnet.qie.digital/tx/${hash("a")}`);
    const t = html(h(EvidenceTable, { network: "testnet", rows: [row("testnet")], own: [] }));
    expect(t).to.not.contain("mainnet.qie.digital");
    expect(t).to.contain("2026-12-01T10:00:00Z");
  });

  it("does not mix networks", () => {
    expect(html(h(EvidenceTable, { network: "testnet", rows: [row("mainnet")], own: [] }))).to.contain("No verified rows");
  });

  describe("the router and the vault", () => {
    const router = "0xf6F4C1Cc954B1798d134750438ada58768978716";
    const vault = "0xC8bfECBF9Dc5d18943b38873705DeeE9D13d751B";
    const shown = { vault, readAt: "2026-11-26T06:11:51Z" };
    const note = (rows: EvidenceRow[], addresses: { router: string | null; vault: string | null } = { router, vault }, record: typeof shown | null = null, net = MAINNET) => h(ContractsNote, { rows, ...addresses, network: net, shown: record });
    /** Each paragraph is read as a paragraph: the heading above them runs into the first one when the tags are taken out. */
    const paragraphsOf = (node: ReturnType<typeof note>) => [...html(node).matchAll(/<p [^>]*>([\s\S]*?)<\/p>/g)].map((m) => (m[1] as string).replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " "));

    it("says the router's source is verified on the explorer only when a mainnet SourceVerified row says so", () => {
      const none = textOf(note([row("mainnet", { event: "Deployed" })]));
      expect(none).to.contain("No row says the explorer shows verified source for the router yet");
      expect(none).to.not.contain("The explorer shows verified source for the router");
      const some = textOf(note([row("mainnet", { event: "SourceVerified" })]));
      expect(some).to.contain("The explorer shows verified source for the router: the SourceVerified row above links to its page");
      expect(some).to.not.contain("No row says");
      // A testnet row is not mainnet proof.
      expect(textOf(note([row("testnet", { event: "SourceVerified" })]))).to.contain("No row says the explorer shows verified source for the router yet");
    });

    it("says nothing about the explorer verifying the vault without a record, and says what anyone can run, whatever the rows hold", () => {
      for (const rows of [[], [row("mainnet", { event: "Deployed" })], [row("mainnet", { event: "SourceVerified" })]]) {
        const text = textOf(note(rows));
        expect(text).to.contain("The vault is not deployed on its own: the router's constructor creates it, so it has no deployment transaction and no SourceVerified row");
        expect(text).to.contain("No record on this site shows the explorer verifying the vault's source.");
        expect(text).to.contain("pnpm live:vaultcheck");
        expect(text).to.contain("compares its hash with the compiled AgentVault of this repository (solc 0.8.24, the optimizer on at 200 runs, the Shanghai EVM)");
        expect(text).to.contain("It is a command to run, not a recorded row");
        const paragraphs = paragraphsOf(note(rows));
        expect(paragraphs).to.have.length(2);
        for (const paragraph of paragraphs) expect(vaultVerifiedClaims(paragraph), paragraph).to.deep.equal([]);
        expect(text).to.not.match(/showed verified source for the vault/);
      }
    });

    it("with the explorer's answer on file, says what it showed, whose statement it is and when it was read, and keeps the code check", () => {
      for (const addresses of [{ router, vault }, { router, vault: vault.toLowerCase() }, { router: null, vault: null }]) {
        const node = note([], addresses, shown);
        const text = textOf(node);
        expect(text).to.contain(`QIE's explorer showed verified source for the vault at ${vault} when the explorer was read on 2026-11-26`);
        expect(text).to.contain("its answer is saved in docs/explorer/vault-record.json");
        // The address is 42 characters with nowhere to break: it is in a box that may wrap, or a phone's page scrolls sideways.
        expect(html(node)).to.contain(`<span class="address">${vault}</span>`);
        expect(text).to.contain("What anyone can check without the explorer is its code");
        expect(text).to.contain("no deployment transaction and no SourceVerified row");
        expect(text).to.not.contain("No record on this site");
        // Allowed because the explorer is named and its answer is on file; the same words without a record would be refused.
        const paragraphs = paragraphsOf(node);
        for (const paragraph of paragraphs) expect(vaultVerifiedClaims(paragraph, true), paragraph).to.deep.equal([]);
        expect(paragraphs.flatMap((p) => vaultVerifiedClaims(p))).to.not.deep.equal([]);
      }
    });

    it("says nothing of the record on a site set to another vault, or to another network", () => {
      const other = textOf(note([], { router, vault: `0x${"12".repeat(20)}` }, shown));
      const testnet = textOf(note([], { router, vault }, shown, TESTNET));
      for (const text of [other, testnet]) {
        expect(text).to.contain("No record on this site shows the explorer verifying the vault's source.");
        expect(text).to.not.contain("showed verified source");
      }
    });

    it("passes the page what the generated content holds, which is what the saved record shows", () => {
      expect(content.vault).to.deep.equal(explorerShowsVault(readFileSync(join(root, "docs", "explorer", "vault-record.json"), "utf8")));
      expect(content.vault).to.not.equal(null);
      expect(readFileSync(join(root, "apps", "web", "src", "app", "evidence", "page.tsx"), "utf8")).to.contain("shown={content.vault}");
    });

    it("links the router and the vault to the explorer's address pages when they are configured, and shows none when they are not", () => {
      const out = html(note([]));
      expect(out).to.contain(`href="https://mainnet.qie.digital/address/${router}"`);
      expect(out).to.contain(`href="https://mainnet.qie.digital/address/${vault}"`);
      expect(html(note([], { router: null, vault: null }))).to.not.contain("contract-addresses");
      expect(html(note([], { router, vault: null }))).to.not.contain(vault);
    });
  });

  const founder = { version: 1, wallets: 0 };
  it("shows counts only when they were read, and an empty state otherwise, never zero", () => {
    const notConfigured = html(h(SummaryView, { answer: { state: "not_configured", reason: "No router is configured." }, founder }));
    expect(notConfigured).to.contain("No router is configured.").and.to.contain('data-state="not_configured"');
    expect(notConfigured).to.not.contain("paid-calls");
    const unavailable = html(h(SummaryView, { answer: { state: "unavailable", reason: "The chain could not be read just now." }, founder }));
    expect(unavailable).to.contain("could not be read").and.to.not.contain("paid-calls");
  });

  it("shows the counts, the QUSDC paid and what was left out when they were read", () => {
    const out = html(
      h(SummaryView, {
        answer: { state: "ok", router: who, listVersion: 1, founderWallets: 2, fromBlock: 1, toBlock: 99, settledEvents: 5, excluded: 2, paidCalls: 3, distinctPayers: 2, distinctBuilders: 1, amountUnits: "3500000" },
        founder: { version: 1, wallets: 2 },
      }),
    );
    expect(out).to.contain('data-testid="paid-calls">3<');
    expect(out).to.contain('data-testid="distinct-payers">2<');
    expect(out).to.contain('data-testid="distinct-builders">1<');
    expect(out).to.contain("3.500000");
    expect(out).to.contain("left out as founder wallets: 2");
    expect(out).to.contain("version 1, 2 wallets");
  });
});

describe("Web components: states with nothing configured", () => {
  const empty = readConfig({});

  it("the builder dashboard says the contracts are not configured, and is not an error page", () => {
    const out = html(withApp(h(BuilderDashboard), empty));
    expect(out).to.contain("Contracts not configured");
    expect(out).to.contain("NEXT_PUBLIC_ROUTER_ADDRESS");
    expect(out).to.not.contain("reader-error");
    expect(out).to.contain('data-testid="connect"');
  });

  it("the payer screen says the same", () => {
    const out = html(withApp(h(PayerDashboard), empty));
    expect(out).to.contain("Contracts not configured");
  });

  it("names the network and says whether the funds are real, before anything is connected", () => {
    expect(textOf(withApp(h(WalletBar), empty))).to.contain("QIE mainnet · chain 1990 · real funds");
    const local = readConfig({ NEXT_PUBLIC_RPC_URL: "http://127.0.0.1:8545" });
    expect(textOf(withApp(h(WalletBar), local))).to.contain("no real funds");
  });

  it("shows the permanent simulation banner", () => {
    expect(textOf(h(SimulationBanner))).to.contain("Simulated — no real funds, no chain");
  });
});

describe("Web components: the risk result", () => {
  const risk = {
    address: who,
    isContract: true,
    codeSizeBytes: 100,
    token: { name: "QUSDC", symbol: "QUSDC", decimals: 6 },
    functionsFound: {},
    accessControl: { present: true, roles: [{ id: hash("1"), name: "VAULT_ROLE", adminRoleName: "DEFAULT_ADMIN_ROLE", holders: [{ address: "0xdC20F1fee9e03184ddabcCe96F01E3c570E43D45", kind: "contract" as const }] }], holdersSource: "explorer-logs" as const },
    burn: { canBurnNow: [{ address: "0xdC20F1fee9e03184ddabcCe96F01E3c570E43D45", kind: "contract", roles: ["VAULT_ROLE"], via: "VAULT_ROLE" }], viaRoleAdmin: [] },
    mint: { canMintNow: [], viaRoleAdmin: [] },
    flags: [{ severity: "high" as const, code: "burn", text: "A contract can burn a holder's balance." }],
    limits: ["It cannot see off-chain controls."],
    disclaimer: "Read-only checks, not a security review.",
  };

  it("shows the flags, the roles, who can burn and what the check cannot see", () => {
    const out = html(h(RiskResult, { risk: risk as never }));
    expect(out).to.contain("QUSDC").and.to.contain("A contract can burn a holder&#x27;s balance.");
    expect(out).to.contain("VAULT_ROLE").and.to.contain("0xdC20F1fee9e03184ddabcCe96F01E3c570E43D45");
    expect(out).to.contain("What this check cannot see").and.to.contain("not a security review");
  });

  it("never calls a token with no flags safe", () => {
    const out = textOf(h(RiskResult, { risk: { ...risk, flags: [], burn: { canBurnNow: [], viaRoleAdmin: [] }, accessControl: { present: false, roles: [], holdersSource: "not-applicable" } } as never }));
    expect(out).to.contain("not a clean bill of health");
    expect(out).to.not.match(/\bsafe\b/i);
  });
});

describe("Web components: the footer", () => {
  it("has Sluice's own links, and no GitHub link unless the repository address is set", () => {
    const without = html(h(Footer, { repoUrl: null, deployed: true }));
    expect(without).to.not.contain("github.com");
    for (const href of ["/docs/spec", "/docs/risks", "/evidence", "/docs", "/demo", "/builder", "/wallet"]) expect(without, href).to.contain(`href="${href}"`);
    const withRepo = html(h(Footer, { repoUrl: "https://github.com/x/y", deployed: true }));
    expect(withRepo).to.contain('href="https://github.com/x/y"').and.to.contain('rel="noopener noreferrer"');
  });

  it("says the contracts are on mainnet only when told the evidence file has the deployment, and says the opposite otherwise", () => {
    const yes = textOf(h(Footer, { repoUrl: null, deployed: true }));
    expect(yes).to.contain("The contracts are on QIE mainnet").and.to.not.contain("Not deployed");
    const no = textOf(h(Footer, { repoUrl: null, deployed: false }));
    expect(no).to.contain("Not deployed to a QIE network yet.").and.to.not.contain("on QIE mainnet");
    // The layout takes that from the evidence file's rows, not from a constant.
    expect(readFileSync(join(root, "apps", "web", "src", "app", "layout.tsx"), "utf8")).to.contain('content.evidence.rows.some((r) => r.network === "mainnet" && r.event === "Deployed")');
  });

  it("says nothing about NEAR or Veylo, and discloses who wrote the code", () => {
    const out = textOf(h(Footer, { repoUrl: null, deployed: true }));
    expect(out).to.not.match(/\bNEAR\b|Veylo/i);
    expect(out).to.contain("Claude Code");
    expect(out).to.contain("not an official x402 one");
  });
});

describe("Web: the builder's snippet compiles", () => {
  const snippet = join(root, "apps", "web", "snippets", "wrap-tool.ts");

  it("type-checks against the SDK with the repository's own compiler settings", () => {
    const config = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
    const program = ts.createProgram({
      rootNames: [snippet],
      options: { ...parsed.options, noEmit: true, module: ts.ModuleKind.Node16, moduleResolution: ts.ModuleResolutionKind.Node16, target: ts.ScriptTarget.ES2022, types: ["node"] },
    });
    const errors = ts.getPreEmitDiagnostics(program).filter((d) => d.category === ts.DiagnosticCategory.Error && d.file?.fileName.replace(/\\/g, "/").endsWith("wrap-tool.ts"));
    expect(errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).to.deep.equal([]);
  });

  it("uses the same SDK calls as the example paid tools", () => {
    const text = readFileSync(snippet, "utf8");
    const example = readFileSync(join(root, "examples", "paid-tools", "src", "server.ts"), "utf8") + readFileSync(join(root, "examples", "paid-tools", "src", "cli.ts"), "utf8");
    for (const call of ["createPaywall", "registerPaidTool"]) {
      expect(text, call).to.contain(call);
      expect(example, call).to.contain(call);
    }
    expect(text).to.contain("price:").and.to.contain("payee:");
  });

  it("reaches the page unchanged, from the generated content", () => {
    const generated = JSON.parse(readFileSync(join(root, "apps", "web", "src", "generated", "content.json"), "utf8")) as { snippets: { wrapTool: string } };
    expect(generated.snippets.wrapTool).to.equal(readFileSync(snippet, "utf8"));
  });
});

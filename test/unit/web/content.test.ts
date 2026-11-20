// What the site renders comes from the repository's own files. These tests hold the generated content, the Markdown renderer, the status
// list, the evidence view and the simulation to those files and to the SDK.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";
import { parseStatusTable } from "../../../src/claims";
import { parseEvidenceStrict } from "../../../src/evidence";
import { CONTENT_PATH, buildContent, connectClientPage, differsOf, sectionOf, serialize } from "../../../src/web-content";
import { DOC_SOURCES, PAGE_FOR_SOURCE } from "../../../apps/web/src/lib/content-types";
import { escapeHtml, plainText, renderInline, renderMarkdown, resolveHref, slugify } from "../../../apps/web/src/lib/markdown";
import { SIMULATION_BANNER, VECTORS, WALKTHROUGH_VECTOR_NAME, buildSimulation, initialPlayback, playbackReducer, refusalExamples, splitFee, walkthroughVector } from "../../../apps/web/src/lib/simulation";
import { COMPONENTS, STATUSES } from "../../../apps/web/src/status";
import { checkStatusTable } from "../../../src/claims";
import { existsSync } from "node:fs";

const root = join(__dirname, "..", "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("Web content: generated from the repository", () => {
  it("the generated file is current: every document and the evidence file match the sources", () => {
    const built = serialize(buildContent(root));
    expect(read(CONTENT_PATH), "run pnpm web:content").to.equal(built);
  });

  it("holds every document the site lists, with the source's hash", () => {
    const content = buildContent(root);
    expect(content.docs.map((d) => d.slug)).to.deep.equal(DOC_SOURCES.map((d) => d.slug));
    for (const d of content.docs) expect(d.markdown.length, d.slug).to.be.greaterThan(100);
  });

  it("carries the README's founder description, status rows and differs table as written", () => {
    const content = buildContent(root);
    expect(content.readme.description.startsWith("Payment middleware that lets MCP builders get paid")).to.equal(true);
    expect(content.readme.statusRows.length).to.be.greaterThan(10);
    expect(content.differs.rows).to.have.length(8);
    expect(content.differs.rows[0]!.other).to.contain("PayEndpoint");
    expect(content.differs.intro).to.contain("PREBUILD-VERIFICATION");
  });

  it("the evidence in the content is the evidence file", () => {
    const content = buildContent(root);
    expect(content.evidence.rows).to.deep.equal(parseEvidenceStrict(read("docs/EVIDENCE.md")));
    expect(content.evidence.intro).to.contain("pnpm evidence:check");
    expect(content.evidence.intro).to.contain("## Columns");
    expect(content.evidence.intro).to.not.contain("## Mainnet");
    expect(content.evidence.intro).to.not.contain("# Evidence");
  });

  it("the connect-a-client page says plainly that it is documented and not tested with real clients", () => {
    const page = buildContent(root).docs.find((d) => d.slug === "connect-a-client")!.markdown;
    expect(page).to.contain("Documented, not yet tested with real clients");
    expect(page).to.contain("Claude Code");
    expect(page).to.contain("Cursor");
  });

  it("changes that label once the README's own status row changes", () => {
    const readme = read("packages/proxy/README.md");
    expect(connectClientPage(readme, "Coming soon")).to.contain("Documented, not yet tested with real clients");
    expect(connectClientPage(readme, "Tested on a fork")).to.not.contain("Documented, not yet tested");
    expect(connectClientPage(readme, "Tested on a fork")).to.contain("Tested on a fork");
  });

  it("finds sections and the differs table, and refuses a table that changed shape", () => {
    expect(sectionOf("# T\n\n## A\nbody\n\n## B\nmore", "A")).to.equal("## A\nbody");
    expect(() => sectionOf("# T", "A")).to.throw();
    expect(() => differsOf("## How this differs\n\n| a | b |\n| --- | --- |\n| 1 | 2 |")).to.throw(/columns/);
  });
});

describe("Web content: the status list", () => {
  const readme = read("README.md");
  const rows = parseStatusTable(readme)!;
  const evidence = parseEvidenceStrict(read("docs/EVIDENCE.md"));

  it("uses the README's three words", () => {
    expect([...STATUSES]).to.deep.equal(["Live", "Tested on a fork", "Coming soon"]);
  });

  it("agrees with the README's status table for every surface it names", () => {
    for (const c of COMPONENTS) {
      for (const surface of c.readmeSurfaces) {
        const row = rows.find((r) => r.surface === surface);
        expect(row, `${c.name}: the README has a row "${surface}"`).to.not.equal(undefined);
        expect(row!.status, `${c.name}: ${surface}`).to.equal(c.status);
      }
    }
  });

  it("marks nothing Live without a verified mainnet row for every event it rests on", () => {
    for (const c of COMPONENTS) {
      if (c.status !== "Live") continue;
      const mainnet = new Set(evidence.filter((r) => r.network === "mainnet").map((r) => r.event));
      for (const e of c.evidenceEvents) expect(mainnet.has(e), `${c.name} is Live but docs/EVIDENCE.md has no mainnet ${e} row`).to.equal(true);
    }
  });

  it("points a fork-tested component at a test that exists", () => {
    for (const c of COMPONENTS) {
      if (c.status === "Tested on a fork") expect(existsSync(join(root, c.testFile)), c.testFile).to.equal(true);
    }
  });

  it("the README's own rules reject Live with no evidence (the control the web list relies on)", () => {
    const live = { surface: "x", status: "Live", evidence: "—", line: 1 };
    expect(checkStatusTable([live], evidence, () => true)[0]).to.contain("Live needs evidence");
  });
});

describe("Web content: the Markdown renderer", () => {
  const options = { source: "docs/SPEC.md" } as const;
  const html = (md: string, o: { source: string; repoUrl?: string | null } = options) => renderMarkdown(md, o).html;

  it("renders headings with GitHub-style ids and lists them", () => {
    const r = renderMarkdown("# Title\n\n## The pay flow\n\ntext\n\n## The pay flow\n\n### Sub", options);
    expect(r.html).to.contain('<h2 id="the-pay-flow">The pay flow</h2>');
    expect(r.html).to.contain('<h2 id="the-pay-flow-1">');
    expect(r.headings.map((h) => [h.depth, h.id])).to.deep.equal([[1, "title"], [2, "the-pay-flow"], [2, "the-pay-flow-1"], [3, "sub"]]);
    expect(slugify("What QIE provides")).to.equal("what-qie-provides");
  });

  it("never lets source text become markup", () => {
    const out = html('<script>alert(1)</script> and <img src=x onerror=alert(1)> and [x](javascript:alert(1)) and `<b>`\n\n<div onclick="x">hi</div>');
    expect(out).to.not.contain("<script");
    expect(out).to.not.contain("<img");
    expect(out).to.not.contain("<div onclick");
    expect(out).to.not.contain('href="javascript');
    expect(out).to.contain("&lt;script&gt;");
    expect(escapeHtml(`<a href="x">&'`)).to.equal("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });

  it("renders tables, code, lists, quotes and rules", () => {
    const out = html("| A | B |\n| --- | :---: |\n| 1 | `x\\|y` |\n\n```ts\nconst a = 1 < 2;\n```\n\n- one\n  - nested\n- two\n\n1. first\n2. second\n\n> quoted\n\n---");
    expect(out).to.contain("<table>").and.to.contain('class="align-center"').and.to.contain("<code>x|y</code>");
    expect(out).to.contain('<pre class="code"><code data-lang="ts">const a = 1 &lt; 2;</code></pre>');
    expect(out).to.match(/<ul><li>one<ul><li>nested<\/li><\/ul><\/li><li>two<\/li><\/ul>/);
    expect(out).to.contain("<ol><li>first</li><li>second</li></ol>");
    expect(out).to.contain("<blockquote>").and.to.contain("<hr>");
  });

  it("formats bold, italic and code, leaves identifiers with underscores alone, and links bare addresses", () => {
    const out = renderInline("**bold** and *it* and `a_b_c` and snake_case_name and https://example.com/x.", options);
    expect(out).to.contain("<strong>bold</strong>").and.to.contain("<em>it</em>").and.to.contain("<code>a_b_c</code>");
    expect(out).to.contain("snake_case_name");
    expect(out).to.contain('<a href="https://example.com/x" rel="noopener noreferrer" target="_blank">');
    expect(plainText("**a** `b` [c](d)")).to.equal("a b c");
  });

  it("rewrites links between documents to the site's pages", () => {
    expect(resolveHref("RISKS.md", { source: "docs/SPEC.md" })).to.equal("/docs/risks");
    expect(resolveHref("../README.md#current-status", { source: "docs/SPEC.md" })).to.equal(undefined);
    expect(resolveHref("../packages/sdk/README.md", { source: "docs/SPEC.md" })).to.equal("/docs/sdk");
    expect(resolveHref("EVIDENCE.md", { source: "docs/RISKS.md" })).to.equal("/evidence");
    expect(resolveHref("#section", options)).to.equal("#section");
    expect(resolveHref("https://x.example", options)).to.equal("https://x.example");
    expect(resolveHref("mailto:a@b.example", options)).to.equal("mailto:a@b.example");
  });

  it("links a file with no page to the repository only when its address is set", () => {
    expect(resolveHref("../contracts/PaymentRouter.sol", { source: "docs/SPEC.md" })).to.equal(undefined);
    expect(resolveHref("../contracts/PaymentRouter.sol", { source: "docs/SPEC.md", repoUrl: "https://github.com/x/y" })).to.equal("https://github.com/x/y/blob/main/contracts/PaymentRouter.sol");
  });

  it("refuses schemes that run code or load data", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "vbscript:x", "//evil.example/x", "JaVaScRiPt:x"]) {
      expect(resolveHref(bad, options), bad).to.equal(undefined);
    }
  });

  it("every page's links resolve to a page on the site", () => {
    for (const path of Object.values(PAGE_FOR_SOURCE)) expect(path.startsWith("/")).to.equal(true);
  });

  describe("every document in the repository", () => {
    for (const d of DOC_SOURCES) {
      it(`${d.source} renders with headings, no raw markup and working anchors`, () => {
        const md = read(d.source);
        const r = renderMarkdown(md, { source: d.source });
        expect(r.html.length).to.be.greaterThan(500);
        expect(r.headings.length).to.be.greaterThan(2);
        expect(r.html).to.not.match(/<script|<iframe|onerror=|onclick=/i);
        // Every in-page link has an id to land on.
        const ids = new Set(r.headings.map((h) => h.id));
        for (const m of r.html.matchAll(/href="#([^"]+)"/g)) expect(ids.has(m[1] as string), `#${m[1]} in ${d.source}`).to.equal(true);
        // No unrendered Markdown is left behind in a heading, a table cell or a list item.
        expect(r.html).to.not.match(/<h\d[^>]*>[^<]*\*\*/);
        expect(r.html).to.not.match(/<td>[^<]*\*\*[^<]/);
        expect(r.html).to.not.contain("| --- |");
      });
    }

    it("renders the spec's tables as tables", () => {
      expect((renderMarkdown(read("docs/SPEC.md"), { source: "docs/SPEC.md" }).html.match(/<table>/g) ?? []).length).to.be.greaterThan(3);
    });
  });
});

describe("Web content: the simulated walkthrough", () => {
  const steps = buildSimulation();

  it("shows a permanent banner that says it is simulated, with no chain", () => {
    expect(SIMULATION_BANNER).to.equal("Simulated — no real funds, no chain");
  });

  it("runs the walkthrough steps in order, from the call to the batch", () => {
    expect(steps.map((s) => s.id)).to.deep.equal(["call", "payment_required", "sign", "retry", "verify", "result", "settle"]);
  });

  it("uses the spec's vectors, not retyped messages", () => {
    const v = walkthroughVector();
    expect(v.name).to.equal(WALKTHROUGH_VECTOR_NAME);
    const sign = steps.find((s) => s.id === "sign")!.body as { signature: string; digest: string; message: Record<string, string> };
    expect(sign.signature).to.equal(v.signature);
    expect(sign.digest).to.equal(v.digest);
    expect(sign.message).to.deep.equal(v.message);
    const retry = steps.find((s) => s.id === "retry")!.body as { params: { _meta: Record<string, unknown> } };
    expect(retry.params._meta["x402/payment"]).to.deep.equal(v.payload);
  });

  it("the payment-required message is the SDK's: an error result with structured content and a text copy", () => {
    const body = steps.find((s) => s.id === "payment_required")!.body as { isError: boolean; structuredContent: { accepts: unknown[] }; content: Array<{ text: string }> };
    expect(body.isError).to.equal(true);
    expect(body.structuredContent.accepts).to.have.length(1);
    expect(JSON.parse(body.content[0]!.text)).to.deep.equal(body.structuredContent);
  });

  it("verifies the agent's signature in the page with the SDK's own check", () => {
    const verify = steps.find((s) => s.id === "verify")!;
    expect(verify.checks!.every((c) => c.pass)).to.equal(true);
    expect(JSON.stringify(verify.body)).to.contain(walkthroughVector().signer);
  });

  it("marks the settlement as simulated, and the transaction as empty until a batch is sent", () => {
    const result = steps.find((s) => s.id === "result")!;
    expect(result.explain).to.contain("Simulated");
    expect((result.body as { _meta: Record<string, { transaction: string }> })._meta["x402/payment-response"]!.transaction).to.equal("");
    expect(steps.find((s) => s.id === "settle")!.explain).to.contain("Simulated");
  });

  it("splits the fee by the spec's rule, taken from the builder's side", () => {
    expect(splitFee(10_000n, 100)).to.deep.equal({ fee: 100n, toBuilder: 9_900n });
    expect(splitFee(333n, 100)).to.deep.equal({ fee: 3n, toBuilder: 330n });
    expect(splitFee(10_000n, 0)).to.deep.equal({ fee: 0n, toBuilder: 10_000n });
    const settle = steps.find((s) => s.id === "settle")!.body as { Settled: { amount: string; fee: string; builderCredited: string } };
    expect(BigInt(settle.Settled.fee) + BigInt(settle.Settled.builderCredited)).to.equal(BigInt(settle.Settled.amount));
  });

  it("every refusal vector is refused with the code the spec gives", () => {
    const examples = refusalExamples();
    expect(examples).to.have.length(VECTORS.paymentVectors.invalid.length);
    for (const e of examples) expect(e.match, `${e.name}: expected ${e.expected}, got ${e.got}`).to.equal(true);
  });

  it("plays back one step at a time to the end, and a reset starts over", () => {
    const n = steps.length;
    let s = initialPlayback;
    s = playbackReducer(s, { type: "play" }, n);
    expect(s).to.deep.equal({ index: 0, playing: true });
    for (let i = 1; i < n; i++) s = playbackReducer(s, { type: "tick" }, n);
    expect(s).to.deep.equal({ index: n - 1, playing: false });
    expect(playbackReducer(s, { type: "tick" }, n)).to.deep.equal(s);
    expect(playbackReducer(s, { type: "play" }, n)).to.deep.equal({ index: 0, playing: true });
    expect(playbackReducer(s, { type: "reset" }, n)).to.deep.equal(initialPlayback);
    expect(playbackReducer(initialPlayback, { type: "finish" }, n)).to.deep.equal({ index: n - 1, playing: false });
    expect(playbackReducer({ index: 2, playing: true }, { type: "pause" }, n)).to.deep.equal({ index: 2, playing: false });
    expect(playbackReducer({ index: 2, playing: false }, { type: "tick" }, n).index).to.equal(2);
  });
});

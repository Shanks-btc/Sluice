// The web app's honesty guards. They read every word a visitor can see, and every place the app could hold a secret, and fail the build on
// a claim the repository cannot back up, a "Live" with no evidence, an invented number, or anything that could take a key.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";
import { BANNED, scanClaims, scanLiveWord } from "../../../src/claims";
import { parseEvidenceStrict } from "../../../src/evidence";
import { PUBLIC_ENV_NAMES } from "../../../apps/web/src/lib/config";
import { IDEA, IDEA_SENTENCES, QUSDC_FINDING } from "../../../apps/web/src/content/copy";
import { allText, extractText, sourceFiles, webRoot } from "../../helpers/web-copy";
import type { Piece } from "../../helpers/web-copy";

const root = join(__dirname, "..", "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const mainnetRows = parseEvidenceStrict(read("docs/EVIDENCE.md")).filter((r) => r.network === "mainnet").length;
const FOUNDER_DESCRIPTION = read("README.md").split("\n").find((l) => l.startsWith("Payment middleware"))!.slice(0, IDEA.length);

/** Words a visitor reads that the web app must not use, on top of the README's rules. */
export const WEB_BANNED: ReadonlyArray<{ rule: string; pattern: RegExp }> = [
  { rule: "no unqualified 'secure'", pattern: /\bsecur(e|ed|ely)\b/i },
  { rule: "no testimonials", pattern: /\b(testimonials?|trusted by|loved by|as seen (in|on)|featured (in|on)|endorsed by|rated)\b/i },
  { rule: "no invented usage", pattern: /\b\d[\d,.]*\+?\s*(k|m)?\s*(users?|customers?|developers?|builders?|agents?|payers?|teams?|clients?|projects?|installs?|downloads?|stars)\b/i },
  { rule: "no invented volume", pattern: /\$\s?\d[\d,.]*\s*(k|m|b)?\s*(in\s+)?(volume|processed|settled|paid|tvl)\b/i },
  { rule: "no volume or TVL claims", pattern: /\b(tvl|total value locked|trading volume|monthly active|daily active)\b/i },
  { rule: "no hype words", pattern: /\b(revolutionary|game[- ]chang(er|ing)|disrupt(s|ive|ion)?|seamless(ly)?|supercharge[sd]?|unlock(s|ing)? the power|world[- ]class|state[- ]of[- ]the[- ]art|blazing|lightning[- ]fast)\b/i },
  { rule: "no logos or brands as endorsement", pattern: /\b(partner(s|ed)? with|in partnership with|official partner|backed by|powered by (coinbase|vercel|cloudflare|openai|anthropic))\b/i },
];

const FOUNDER_CLAIMS = /(?:^|[.!?]\s+)The founder (set|made|decided|directed|explained|understood|reviewed|tested|wrote|designed|chose|approved|verified|ran|understands|has explained|has reviewed|has tested|did)\b/m;

const scanPieces = (pieces: Piece[]) => {
  const bad: string[] = [];
  for (const p of pieces) {
    for (const f of scanClaims(p.file, p.text, mainnetRows)) bad.push(`${p.file}:${p.line} ${f.rule}: "${f.text}" in "${p.text.slice(0, 80)}"`);
    // src/status.ts is the typed status list: the word is its vocabulary, and test/unit/web/content.test.ts holds every use of it to the evidence file.
    for (const f of p.file === "src/status.ts" ? [] : scanLiveWord(p.file, p.text, mainnetRows)) bad.push(`${p.file}:${p.line} ${f.rule}: "${p.text.slice(0, 80)}"`);
    for (const rule of WEB_BANNED) {
      const hit = rule.pattern.exec(p.text);
      if (hit) bad.push(`${p.file}:${p.line} ${rule.rule}: "${hit[0]}" in "${p.text.slice(0, 80)}"`);
    }
    if (FOUNDER_CLAIMS.test(p.text)) bad.push(`${p.file}:${p.line} says what the founder did: "${p.text.slice(0, 80)}"`);
  }
  return bad;
};

describe("Web honesty: the claims scan", () => {
  const pieces = allText();

  it("reads a useful amount of the app's text", () => {
    expect(pieces.length).to.be.greaterThan(150);
    expect(pieces.some((p) => p.text.includes("Wrap a tool"))).to.equal(true);
    expect(pieces.some((p) => p.file.endsWith("copy.ts"))).to.equal(true);
  });

  it("no visible text makes a banned claim, a Live status without evidence, an invented number, a testimonial or a claim about the founder", () => {
    expect(scanPieces(pieces)).to.deep.equal([]);
  });

  it("the words the README bans are also banned here", () => {
    expect(BANNED.length).to.be.greaterThan(8);
  });

  describe("controls: the scan catches what it should and leaves honest text alone", () => {
    const flagged = (text: string, file = "x.tsx") => scanPieces([{ file, line: 1, text }]).length > 0;
    const bad = [
      "The first payment network for agents.",
      "Trusted by 2,000 builders.",
      "Over 500+ agents already pay with Sluice.",
      "$1.2M in volume processed.",
      "A secure way to pay.",
      "Audited by a leading firm.",
      "Battle-tested and production-ready.",
      "Guaranteed uptime.",
      "Our customers love it. Testimonials below.",
      "Sluice is live on QIE mainnet.",
      "Status: Live is shown for the router.",
      "Powered by Coinbase, in partnership with others.",
      "The founder tested every contract.",
      "A revolutionary, seamless experience.",
      "Earn yield on your balance.",
      "A trustless router.",
    ];
    for (const text of bad) it(`flags: ${text}`, () => expect(flagged(text), text).to.equal(true));

    const fine = [
      "Nothing is deployed to a QIE network yet.",
      "A badge says Live only when the evidence file holds a verified mainnet row for it.",
      "Verified mainnet transactions in the evidence file: 0.",
      "No audit has been done. No outside security review has been done.",
      "A fee capped in code: 2% (200 basis points).",
      "Tested on a fork",
      "Coming soon",
      "The deposit is 12.5 QUSDC.",
      "Written and tested by Claude Code, Anthropic's coding agent.",
    ];
    for (const text of fine) it(`leaves alone: ${text}`, () => expect(flagged(text), text).to.equal(false));
  });
});

describe("Web honesty: the idea wording", () => {
  it("is the founder's wording from the README, word for word", () => {
    expect(IDEA).to.equal(FOUNDER_DESCRIPTION);
    expect(IDEA_SENTENCES.join(" ")).to.equal(IDEA);
  });

  it("is never reworded: any text that starts like it is exactly it, or one of its two sentences", () => {
    for (const p of allText()) {
      if (!/Payment middleware that lets/i.test(p.text) && !/Agents pay per request on QIE/i.test(p.text)) continue;
      const ok = p.text === IDEA || IDEA_SENTENCES.includes(p.text as never);
      expect(ok, `${p.file}:${p.line} rewords the idea: ${p.text.slice(0, 100)}`).to.equal(true);
    }
  });

  it("is on the landing page, from the one constant, and is the site's description", () => {
    const page = read("apps/web/src/app/page.tsx");
    expect(page).to.contain("IDEA_SENTENCES[0]").and.to.contain("IDEA_SENTENCES[1]");
    expect(read("apps/web/src/content/copy.ts")).to.contain("SITE_DESCRIPTION = IDEA");
  });

  it("the risks box's addresses are the ones in docs/RISKS.md", () => {
    const risks = read("docs/RISKS.md");
    for (const [, value] of QUSDC_FINDING.facts) expect(risks, value).to.contain(value);
  });
});

describe("Web honesty: no company logos or images that are not Sluice's own", () => {
  it("the app has no <img> and loads only its own brand files", () => {
    for (const f of sourceFiles()) {
      const text = readFileSync(join(webRoot, f), "utf8");
      expect(/<img\b/.test(text), `${f} has an <img>`).to.equal(false);
      for (const m of text.matchAll(/["'`](\/[\w./-]+\.(png|jpe?g|svg|gif|webp|ico))["'`]/g)) {
        expect(["/og.png", "/icon.svg", "/brand/mark.svg", "/brand/wordmark.svg"], `${f} loads ${m[1]}`).to.include(m[1]);
      }
    }
  });
});

describe("Web honesty: secrets and keys", () => {
  const SECRET_NAME = /(KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE|PRIVATE|MNEMONIC|SEED|CREDENTIAL)/i;
  const SECRET_VALUE = /(0x[0-9a-fA-F]{64}\b|-----BEGIN [A-Z ]*PRIVATE KEY|\bsk-[A-Za-z0-9]{20,}|\b[A-Za-z0-9+/]{40,}={0,2}\b)/;

  it("no NEXT_PUBLIC_* name sounds like a secret, because every one of them reaches the browser", () => {
    for (const name of PUBLIC_ENV_NAMES) expect(name, name).to.not.match(SECRET_NAME);
  });

  it("no NEXT_PUBLIC_* assignment anywhere in the repository holds a secret-looking value", () => {
    const files = ["README.md", ".env.example", "docs/DEPLOY-WEB.md", "apps/web/README.md"].filter((f) => {
      try {
        read(f);
        return true;
      } catch {
        return false;
      }
    });
    for (const f of files) {
      for (const m of read(f).matchAll(/NEXT_PUBLIC_[A-Z_]+\s*=\s*(\S+)/g)) {
        const value = m[1] as string;
        expect(SECRET_VALUE.test(value), `${f}: ${m[0]}`).to.equal(false);
      }
    }
  });

  it("no source file names a server-only secret, and none holds a key-shaped value", () => {
    for (const f of sourceFiles()) {
      const text = readFileSync(join(webRoot, f), "utf8");
      expect(text, f).to.not.match(/SLUICE_(RELAYER_|AGENT_)?KEY|SLUICE_APPROVE/);
      expect(/0x[0-9a-fA-F]{64}\b/.test(text), `${f} has a 32-byte hex value`).to.equal(false);
    }
  });

  it("only the server reads the environment, and only by the names it is allowed", () => {
    const allowed = new Set(["src/lib/config.ts", "src/lib/risk-handler.ts", "src/proxy.ts", "src/app/evidence/page.tsx"]);
    for (const f of sourceFiles()) {
      const text = readFileSync(join(webRoot, f), "utf8");
      if (!/process\.env/.test(text)) continue;
      expect(allowed.has(f), `${f} reads process.env`).to.equal(true);
      expect(text.trimStart().startsWith('"use client"'), `${f} is a client file that reads process.env`).to.equal(false);
      for (const m of text.matchAll(/process\.env(?:\.([A-Z_]+)|\["([A-Z_]+)"\])/g)) {
        const name = (m[1] ?? m[2]) as string;
        expect(name === "NODE_ENV" || name.startsWith("NEXT_PUBLIC_") || ["SLUICE_RPC_URL", "SLUICE_EXPLORER_URL", "SLUICE_FROM_BLOCK"].includes(name), `${f} reads ${name}`).to.equal(true);
      }
    }
  });

  it("no client file imports a module that reads the server environment for a secret", () => {
    const clientFiles = sourceFiles().filter((f) => readFileSync(join(webRoot, f), "utf8").trimStart().startsWith('"use client"'));
    expect(clientFiles.length).to.be.greaterThan(8);
    for (const f of clientFiles) {
      const text = readFileSync(join(webRoot, f), "utf8");
      expect(text, f).to.not.match(/from ["'][^"']*(risk-handler|summary-handler|rate-limit)["']/);
      expect(text, f).to.not.match(/from ["']node:/);
    }
  });
});

describe("Web honesty: nothing can take a private key or a seed phrase", () => {
  const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const FIELD_WORDS = /(private[ -]?key|mnemonic|seed[ -]?phrase|recovery[ -]?phrase|secret[ -]?(key|phrase)|keystore|passphrase|wallet[ -]?json)/i;

  /** Finds inputs, textareas and storage that could hold a key. Returned as readable findings. */
  function findKeyHolders(file: string, rawSource: string): string[] {
    const source = stripComments(rawSource);
    const found: string[] = [];
    const elements = source.match(/<(input|textarea)\b[\s\S]*?\/?>/g) ?? [];
    for (const el of elements) {
      if (FIELD_WORDS.test(el)) found.push(`${file}: a field that names a key: ${el.slice(0, 80)}`);
      if (/type=["']password["']/.test(el)) found.push(`${file}: a password field`);
    }
    for (const label of source.match(/<label\b[^>]*>[\s\S]*?<\/label>/g) ?? []) {
      if (FIELD_WORDS.test(label)) found.push(`${file}: a label that asks for a key: ${label.slice(0, 80)}`);
    }
    if (/\b(privateKey|mnemonic|seedPhrase|secretKey|fromPhrase|HDNodeWallet|createRandom|new Wallet\()/.test(source)) found.push(`${file}: code that makes or holds a key`);
    if (/\b(localStorage|sessionStorage|indexedDB|document\.cookie)\b/.test(source) && file !== "src/components/nav.tsx") found.push(`${file}: uses browser storage`);
    return found;
  }

  it("has no input, label, storage or code that could hold a private key or a mnemonic", () => {
    const bad = sourceFiles().flatMap((f) => findKeyHolders(f, readFileSync(join(webRoot, f), "utf8")));
    expect(bad).to.deep.equal([]);
  });

  it("the only browser storage is the theme choice, in one component", () => {
    const users = sourceFiles().filter((f) => /\b(localStorage|sessionStorage|indexedDB)\b/.test(stripComments(readFileSync(join(webRoot, f), "utf8"))));
    expect(users.sort()).to.deep.equal(["src/components/nav.tsx"]);
  });

  describe("controls: the scan catches what it should", () => {
    it("flags a private-key field, a mnemonic box, a password input, key-making code and storage", () => {
      expect(findKeyHolders("a.tsx", '<input id="pk" placeholder="Paste your private key" />')).to.have.length(1);
      expect(findKeyHolders("a.tsx", '<textarea name="mnemonic"></textarea>')).to.not.be.empty;
      expect(findKeyHolders("a.tsx", '<input type="password" />')).to.have.length(1);
      expect(findKeyHolders("a.tsx", "<label>Enter your seed phrase</label>")).to.have.length(1);
      expect(findKeyHolders("a.tsx", "const w = new Wallet(key);")).to.have.length(1);
      expect(findKeyHolders("a.tsx", "const w = Wallet.createRandom();")).to.have.length(1);
      expect(findKeyHolders("a.tsx", 'localStorage.setItem("k", v)')).to.have.length(1);
    });
    it("leaves an address field and the theme storage alone", () => {
      expect(findKeyHolders("a.tsx", '<input id="agent" placeholder="0x…" />')).to.deep.equal([]);
      expect(findKeyHolders("src/components/nav.tsx", 'window.localStorage.getItem("sluice-theme")')).to.deep.equal([]);
    });
  });
});

describe("Web honesty: the extractor reads what a visitor can read", () => {
  it("takes JSX text and copy, and leaves out class names, links and imports", () => {
    const pieces = extractText("t.tsx", 'import x from "./the-first-module";\nexport const A = () => <a className="the first class" href="/first">Visible words</a>;\nconst c = "A constant";');
    expect(pieces.map((p) => p.text)).to.deep.equal(["Visible words", "A constant"]);
  });
});

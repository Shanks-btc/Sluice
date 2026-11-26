// .gitattributes keeps the repository's text files LF in the working tree whatever git's autocrlf setting is, because the tests compare
// the repository's own files with text that has LF line endings. These tests hold the file to that rule.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";

const root = join(__dirname, "..", "..");
const file = join(root, ".gitattributes");

type Rule = { pattern: string; attrs: string[]; line: number };

/** The rules of the file, in order. The file's own line endings do not matter here, so that this reads the same on any checkout. */
function rules(): Rule[] {
  const out: Rule[] = [];
  readFileSync(file, "utf8").replace(/\r\n/g, "\n").split("\n").forEach((raw, i) => {
    const text = raw.trim();
    if (!text || text.startsWith("#")) return;
    const [pattern, ...attrs] = text.split(/\s+/);
    out.push({ pattern: pattern as string, attrs, line: i + 1 });
  });
  return out;
}

describe(".gitattributes: text files stay LF, binary and key-like files are left alone", () => {
  it("exists at the repository root", () => {
    expect(existsSync(file)).to.equal(true);
  });

  it("has the rule that keeps every text file LF whatever the machine's autocrlf setting says, and it comes first", () => {
    const [first] = rules();
    expect(first, "the file has a rule").to.not.equal(undefined);
    expect(first?.pattern).to.equal("*");
    expect(first?.attrs).to.deep.equal(["text=auto", "eol=lf"]);
  });

  it("marks png, jpg, ico, woff, woff2, pdf and key-like files as binary, after the text rule so that they win for those files", () => {
    const all = rules();
    const wildcard = all.findIndex((r) => r.pattern === "*");
    for (const pattern of ["*.png", "*.jpg", "*.ico", "*.woff", "*.woff2", "*.pdf", "*.key", "*.pem", "*.keystore"]) {
      const at = all.findIndex((r) => r.pattern === pattern);
      expect(at, `${pattern} has a rule`).to.be.greaterThan(wildcard);
      expect(all[at]?.attrs, pattern).to.include("binary");
    }
  });

  it("asks for no CRLF anywhere, and gives the text rule to no pattern but *", () => {
    for (const rule of rules()) {
      expect(rule.attrs.join(" "), `line ${rule.line}`).to.not.match(/eol=crlf/);
      if (rule.pattern !== "*") expect(rule.attrs, `line ${rule.line}`).to.not.include("text=auto");
    }
  });

  it("names every key-like pattern the repository ignores, so no key file is ever treated as text", () => {
    const ignored = readFileSync(join(root, ".gitignore"), "utf8").replace(/\r\n/g, "\n").split("\n").map((l) => l.trim());
    const binary = new Set(rules().filter((r) => r.attrs.includes("binary")).map((r) => r.pattern));
    for (const pattern of ["*.key", "*.keystore", "*.pem"]) {
      expect(ignored, `${pattern} is git-ignored`).to.include(pattern);
      expect(binary.has(pattern), `${pattern} is binary in .gitattributes`).to.equal(true);
    }
  });
});

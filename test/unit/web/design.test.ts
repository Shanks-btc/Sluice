// The design: every colour lives in one file, every text-on-background pair in use meets WCAG AA in both themes, the two copies of
// the dark theme agree, and the theme choice is remembered.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";
import { MINIMUM, composite, contrastRatio, parseColor, parseTokens, resolveToken } from "../../../apps/web/src/lib/contrast";
import { FOREGROUND_TOKENS, PAIRS } from "../../../apps/web/src/design/pairs";
import { THEME_KEY, applyChoice, isChoice, readChoice, resolveTheme, storeChoice, toggled } from "../../../apps/web/src/lib/theme";

const web = join(__dirname, "..", "..", "..", "apps", "web");
const read = (path: string) => readFileSync(join(web, path), "utf8");
const tokensCss = read("src/design/tokens.css");
const themes = parseTokens(tokensCss);

function walk(dir: string, accept: (name: string) => boolean): string[] {
  return readdirSync(join(web, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    if (name === "node_modules" || name === ".next" || name === "generated") return [];
    return statSync(join(web, rel)).isDirectory() ? walk(rel, accept) : accept(name) ? [rel] : [];
  });
}

describe("Web design: colour contrast", () => {
  const sets = { light: themes.light, dark: { ...themes.dark }, "dark (system setting)": { ...themes.darkMedia } } as const;

  /** The colour of a token, laid over the worst page background if it is see-through. */
  function colours(name: string, theme: Record<string, string>, base: Record<string, string>) {
    const parsed = parseColor(resolveToken(name, theme, base));
    if (parsed.a === 1) return [parsed];
    // A see-through surface sits over the page or anywhere on the gradient (its start, two mid stops and end); check each.
    return ["bg", "hero-mid-1", "hero-mid-2", "bg-sky"].map((under) => composite(parsed, parseColor(resolveToken(under, theme, base))));
  }

  for (const [label, theme] of Object.entries(sets)) {
    describe(label, () => {
      for (const pair of PAIRS) {
        it(`${pair.fg} on ${pair.bg} (${pair.where}) is at least ${MINIMUM[pair.kind]}:1`, () => {
          const fgs = colours(pair.fg, theme, themes.light);
          const bgs = colours(pair.bg, theme, themes.light);
          for (const fg of fgs) {
            for (const bg of bgs) {
              const solidFg = fg.a === 1 ? fg : composite(fg, bg);
              expect(contrastRatio(solidFg, bg)).to.be.at.least(MINIMUM[pair.kind]);
            }
          }
        });
      }
    });
  }

  it("the two copies of the dark theme are identical", () => {
    expect(themes.darkMedia).to.deep.equal(themes.dark);
  });

  it("every token a pair names is defined in both themes", () => {
    for (const p of PAIRS) for (const n of [p.fg, p.bg]) {
      expect(() => resolveToken(n, themes.dark, themes.light), n).to.not.throw();
      expect(() => resolveToken(n, themes.light, themes.light), n).to.not.throw();
    }
  });

  describe("controls: the check catches what it should", () => {
    const ratio = (a: string, b: string) => contrastRatio(parseColor(a), parseColor(b));
    it("computes the published extremes", () => {
      expect(ratio("#000000", "#ffffff")).to.be.closeTo(21, 0.01);
      expect(ratio("#ffffff", "#ffffff")).to.equal(1);
      expect(ratio("#777777", "#ffffff")).to.be.closeTo(4.48, 0.02);
    });
    it("fails a pale grey on white, and passes the app's body text", () => {
      expect(ratio("#aaaaaa", "#ffffff")).to.be.lessThan(MINIMUM.text);
      expect(ratio(resolveToken("fg", themes.light, themes.light), resolveToken("bg", themes.light, themes.light))).to.be.greaterThan(MINIMUM.text);
    });
    it("holds text to WCAG AA's 4.5:1 and large text and control edges to 3:1", () => {
      expect(MINIMUM).to.deep.equal({ text: 4.5, large: 3, ui: 3 });
    });
    it("reads short hex, long hex and rgba, and refuses anything else", () => {
      expect(parseColor("#fff")).to.deep.equal({ r: 255, g: 255, b: 255, a: 1 });
      expect(parseColor("rgba(0, 0, 0, 0.5)").a).to.equal(0.5);
      expect(() => parseColor("red")).to.throw();
      expect(() => parseColor("rgba(0,0,0,2)")).to.throw();
    });
    it("lays a see-through colour over what is behind it", () => {
      const c = composite({ r: 255, g: 255, b: 255, a: 0.5 }, { r: 0, g: 0, b: 0, a: 1 });
      expect(c.r).to.equal(127.5);
    });
  });
});

describe("Web design: the stylesheets use only the tokens", () => {
  const cssFiles = walk("src", (n) => n.endsWith(".css")).filter((f) => !f.endsWith("tokens.css"));
  const sourceFiles = walk("src", (n) => /\.(ts|tsx)$/.test(n));

  it("finds the stylesheets", () => {
    expect(cssFiles.length).to.be.greaterThan(3);
  });

  for (const file of cssFiles) {
    it(`${file} has no colour literal`, () => {
      const css = read(file).replace(/\/\*[\s\S]*?\*\//g, "");
      expect(css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [], "hex colours").to.deep.equal([]);
      expect(css.match(/\brgba?\(/g) ?? [], "rgb colours").to.deep.equal([]);
      expect(css.match(/\bhsla?\(/g) ?? [], "hsl colours").to.deep.equal([]);
    });

    it(`${file} reads only tokens that exist`, () => {
      const css = read(file);
      for (const m of css.matchAll(/var\(--([a-z0-9-]+)/g)) {
        const name = m[1] as string;
        if (name === "a") continue;
        expect(themes.light, `--${name} used in ${file}`).to.have.property(name);
      }
    });

    it(`${file} sets a text colour only from the checked foreground tokens`, () => {
      const css = read(file).replace(/\/\*[\s\S]*?\*\//g, "");
      for (const m of css.matchAll(/(?<![-\w])color:\s*var\(--([a-z0-9-]+)\)/g)) {
        const name = m[1] as string;
        const ok = FOREGROUND_TOKENS.includes(name) || ["fg-secondary", "fg-muted"].includes(name) || name === "footer-fg";
        expect(ok, `color: var(--${name}) in ${file} is not a checked foreground`).to.equal(true);
      }
    });
  }

  it("no source file sets a colour or a style attribute", () => {
    for (const file of sourceFiles) {
      const text = read(file);
      expect(/#[0-9a-fA-F]{6}\b/.test(text.replace(/\/\/.*$/gm, "")), `${file} has a hex colour`).to.equal(file.endsWith("layout.tsx") && /themeColor/.test(text));
      expect(/\bstyle=\{/.test(text), `${file} has a style attribute, which the Content Security Policy blocks`).to.equal(false);
    }
  });
});

describe("Web design: the theme choice", () => {
  const memory = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  };

  it("follows the system until the person chooses", () => {
    expect(readChoice(memory())).to.equal("system");
    expect(resolveTheme("system", true)).to.equal("dark");
    expect(resolveTheme("system", false)).to.equal("light");
    expect(resolveTheme("light", true)).to.equal("light");
    expect(resolveTheme("dark", false)).to.equal("dark");
  });

  it("remembers an explicit choice and ignores anything else in storage", () => {
    const store = memory();
    expect(storeChoice(store, "dark")).to.equal(true);
    expect(readChoice(store)).to.equal("dark");
    store.setItem(THEME_KEY, "purple");
    expect(readChoice(store)).to.equal("system");
    expect(isChoice("light") && isChoice("dark") && isChoice("system")).to.equal(true);
    expect(isChoice("blue")).to.equal(false);
  });

  it("survives storage that is missing or throws", () => {
    expect(readChoice(undefined)).to.equal("system");
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readChoice(blocked)).to.equal("system");
    expect(storeChoice(blocked, "dark")).to.equal(false);
    expect(storeChoice(undefined, "dark")).to.equal(true);
  });

  it("the toggle flips to the opposite theme, and applying it sets or clears the attribute", () => {
    expect(toggled("light")).to.equal("dark");
    expect(toggled("dark")).to.equal("light");
    const attrs = new Map<string, string>();
    const root = { setAttribute: (n: string, v: string) => void attrs.set(n, v), removeAttribute: (n: string) => void attrs.delete(n) };
    applyChoice(root, "dark");
    expect(attrs.get("data-theme")).to.equal("dark");
    applyChoice(root, "system");
    expect(attrs.has("data-theme")).to.equal(false);
  });

  it("the script that runs before paint reads the same key and sets the same attribute", () => {
    const init = read("public/theme-init.js");
    expect(init).to.contain(`"${THEME_KEY}"`);
    expect(init).to.contain("data-theme");
    expect(init).to.contain("catch");
  });
});

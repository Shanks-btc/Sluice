// Draws public/og.png, the image a link preview shows, from the design tokens and the brand mark. Run by hand after a change to either:
//   node apps/web/scripts/og.mjs
// It reads the colours from src/design/tokens.css (so the image cannot drift from the site) and the mark from public/brand/mark.svg,
// renders a page in the system's Edge through playwright-core, and saves a 1200 by 630 PNG. It reaches no network.
/* global document */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..");
const require = createRequire(join(web, "package.json"));
const { chromium } = require("playwright-core");

const tokens = readFileSync(join(web, "src", "design", "tokens.css"), "utf8");
const token = (name) => {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(tokens);
  if (!m) throw new Error(`token --${name} not found`);
  return m[1];
};
const c = { ice: token("c-ice"), sky: token("c-sky"), ink: token("c-ink"), accent: token("c-accent"), waterA: token("water-a"), waterB: token("water-b"), waterC: token("water-c") };

// The first sentence of the idea, word for word.
const copy = readFileSync(join(web, "src", "content", "copy.ts"), "utf8");
const sentence = /IDEA_SENTENCES = \[\s*"([^"]+)"/.exec(copy)?.[1];
if (!sentence) throw new Error("the idea's first sentence was not found in copy.ts");

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:"Inter Tight";font-weight:600;src:url("${pathToFileURL(join(web, "public/fonts/inter-tight-latin-600-normal.woff2"))}") format("woff2")}
@font-face{font-family:"IBM Plex Mono";font-weight:400;src:url("${pathToFileURL(join(web, "public/fonts/ibm-plex-mono-latin-400-normal.woff2"))}") format("woff2")}
*{box-sizing:border-box}body{margin:0;width:1200px;height:630px;position:relative;overflow:hidden;font-family:"Inter Tight",sans-serif;color:${c.ink};background:linear-gradient(180deg,${c.ice} 0%,${c.sky} 100%)}
.brand{position:absolute;left:72px;top:60px;display:flex;align-items:center;gap:18px;font-size:44px;font-weight:600;letter-spacing:-0.03em}
.brand img{width:56px;height:56px}
.tag{position:absolute;right:72px;top:72px;font-family:"IBM Plex Mono",monospace;font-size:20px;letter-spacing:.08em;text-transform:uppercase}
.idea{position:absolute;left:72px;right:72px;top:168px;font-size:46px;line-height:1.15;font-weight:600;letter-spacing:-0.025em}
svg{position:absolute;left:0;bottom:0;width:1200px;height:170px}
</style></head><body>
<div class="brand"><img src="${pathToFileURL(join(web, "public/brand/mark.svg"))}" alt=""> Sluice</div>
<div class="tag">Payments for MCP tools on QIE</div>
<div class="idea">${sentence}</div>
<svg viewBox="0 0 1200 170"><path d="M0 44H400V170H0z" fill="${c.waterA}"/><path d="M400 84H800V170H400z" fill="${c.waterB}"/><path d="M800 124H1200V170H800z" fill="${c.waterC}"/>
<g fill="${c.ink}" opacity=".85"><rect x="396" y="26" width="8" height="144" rx="2"/><rect x="388" y="18" width="24" height="10" rx="3"/><rect x="796" y="66" width="8" height="104" rx="2"/><rect x="788" y="58" width="24" height="10" rx="3"/></g>
<circle cx="560" cy="76" r="7" fill="${c.accent}"/></svg></body></html>`;

const dir = mkdtempSync(join(tmpdir(), "sluice-og-"));
const file = join(dir, "og.html");
writeFileSync(file, html);
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.goto(pathToFileURL(file).href);
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: join(web, "public", "og.png"), clip: { x: 0, y: 0, width: 1200, height: 630 } });
await browser.close();
console.log("og: public/og.png written");

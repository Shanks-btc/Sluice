// Copies the Latin-subset font files the app uses from the @fontsource packages into public/fonts, so the app serves its own
// fonts (the Content Security Policy allows fonts from this origin only). src/design/fonts.css declares them. Run by the build.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "..", "package.json"));
const out = join(here, "..", "public", "fonts");
mkdirSync(out, { recursive: true });

const FILES = [
  ["inter-tight", 400],
  ["inter-tight", 500],
  ["inter-tight", 600],
  ["ibm-plex-mono", 400],
  ["ibm-plex-mono", 500],
  ["instrument-serif", 400],
];

for (const [pkg, weight] of FILES) {
  const name = `${pkg}-latin-${weight}-normal.woff2`;
  const from = join(dirname(require.resolve(`@fontsource/${pkg}/package.json`)), "files", name);
  if (!existsSync(from)) throw new Error(`font file not found: ${from}`);
  copyFileSync(from, join(out, name));
}
console.log(`fonts: ${FILES.length} files copied to public/fonts`);

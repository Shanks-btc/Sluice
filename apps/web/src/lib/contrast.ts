// WCAG 2.x contrast, computed from the colours in src/design/tokens.css. Used by the contrast test; nothing in the running app needs it.
export type Rgba = { r: number; g: number; b: number; a: number };

/** "#rgb", "#rrggbb" or "rgba(r, g, b, a)" / "rgb(r, g, b)". Anything else is an error, not a guess. */
export function parseColor(value: string): Rgba {
  const v = value.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) {
    const [r, g, b] = (m[1] as string).split("").map((c) => Number.parseInt(c + c, 16)) as [number, number, number];
    return { r, g, b, a: 1 };
  }
  m = /^#([0-9a-f]{6})$/.exec(v);
  if (m) {
    const n = Number.parseInt(m[1] as string, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v);
  if (m) {
    const a = m[4] === undefined ? 1 : Number(m[4]);
    if (a < 0 || a > 1) throw new Error(`alpha out of range: ${value}`);
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a };
  }
  throw new Error(`cannot read the colour ${JSON.stringify(value)}`);
}

/** `top` laid over `under` (which must be opaque). */
export function composite(top: Rgba, under: Rgba): Rgba {
  const a = top.a;
  return { r: top.r * a + under.r * (1 - a), g: top.g * a + under.g * (1 - a), b: top.b * a + under.b * (1 - a), a: 1 };
}

const channel = (c: number): number => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

export const luminance = ({ r, g, b }: Rgba): number => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export const MINIMUM = { text: 4.5, large: 3, ui: 3 } as const;

// ---------------------------------------------------------------------------------------------- token file

export type Theme = Record<string, string>;
export type ThemeSet = { light: Theme; dark: Theme; darkMedia: Theme };

function declarations(block: string): Theme {
  const out: Theme = {};
  for (const m of block.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1] as string] = (m[2] as string).trim();
  return out;
}

/** The three blocks of tokens.css: the light root, the dark attribute block, and the dark block inside the media query. */
export function parseTokens(css: string): ThemeSet {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const body = (selector: RegExp): string => {
    const m = selector.exec(stripped);
    if (!m) throw new Error(`tokens.css has no block for ${selector}`);
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < stripped.length && depth > 0) {
      if (stripped[i] === "{") depth += 1;
      if (stripped[i] === "}") depth -= 1;
      i += 1;
    }
    return stripped.slice(start, i - 1);
  };
  return {
    light: declarations(body(/(^|\n):root\s*\{/)),
    dark: declarations(body(/:root\[data-theme="dark"\]\s*\{/)),
    darkMedia: declarations(body(/:root:not\(\[data-theme="light"\]\)\s*\{/)),
  };
}

/** Looks a token up in a theme, following `var(--other)` references. A dark theme falls back to the light theme for names it does not set. */
export function resolveToken(name: string, theme: Theme, base: Theme, seen: string[] = []): string {
  if (seen.includes(name)) throw new Error(`token cycle: ${[...seen, name].join(" -> ")}`);
  const raw = theme[name] ?? base[name];
  if (raw === undefined) throw new Error(`token --${name} is not defined`);
  const ref = /^var\(--([a-z0-9-]+)\)$/.exec(raw);
  return ref ? resolveToken(ref[1] as string, theme, base, [...seen, name]) : raw;
}

// Which text colour sits on which background, for every combination the stylesheets use. A test computes the WCAG contrast of each pair
// in the light theme, the dark theme and the system-dark media query, and fails below 4.5:1 for text, 3:1 for large text and for the
// edges of controls. A text token the stylesheets use that is not named here also fails a test, so a new colour cannot slip in unchecked.
export type PairKind = "text" | "large" | "ui";
export type Pair = { fg: string; bg: string; kind: PairKind; where: string };

const text = (fg: string, bg: string, where: string): Pair => ({ fg, bg, kind: "text", where });
const ui = (fg: string, bg: string, where: string): Pair => ({ fg, bg, kind: "ui", where });

// The page, the hero's gradient (its start, two mid stops and end), cards and the see-through card laid over each of them.
const PAGE = ["bg", "hero-mid-1", "hero-mid-2", "bg-sky", "surface", "surface-soft", "surface-frost"] as const;

export const PAIRS: readonly Pair[] = [
  ...PAGE.map((bg) => text("fg", bg, "body text and headings")),
  ...PAGE.map((bg) => text("fg-secondary", bg, "secondary text")),
  ...PAGE.map((bg) => text("fg-muted", bg, "muted text and labels")),
  ...PAGE.map((bg) => text("accent-text", bg, "links and accent text")),
  text("action-fg", "action", "dark button"),
  text("action-fg", "action-hover", "dark button, hovered"),
  text("soft-btn-fg", "soft-btn", "pale button"),
  text("soft-btn-fg", "soft-btn-hover", "pale button, hovered"),
  text("info-fg", "info-bg", "info tag"),
  text("success-fg", "success-bg", "success tag"),
  text("warn-fg", "warn-bg", "warning tag, banner and risks box"),
  text("error-fg", "error-bg", "error tag and banner"),
  text("neutral-fg", "neutral-bg", "neutral tag"),
  text("error-fg", "surface", "field error"),
  text("success-fg", "surface", "success text on a card"),
  text("warn-fg", "surface", "warning text on a card"),
  text("on-accent", "accent", "selected text"),
  text("footer-fg", "footer-bg", "footer links and text"),
  text("footer-heading", "footer-bg", "footer headings"),
  text("footer-dim", "footer-bg", "footer small print"),
  text("footer-bg", "footer-heading", "the button in the footer"),
  // The edges of controls and focus rings, which must stand out from what is behind them.
  ui("field-border", "bg", "input edge on the page"),
  ui("field-border", "surface", "input edge on a card"),
  ui("field-border", "surface-frost", "input edge on a frosted card"),
  ui("focus", "bg", "focus ring on the page"),
  ui("focus", "hero-mid-1", "focus ring on mid stop 1 of the gradient"),
  ui("focus", "hero-mid-2", "focus ring on mid stop 2 of the gradient"),
  ui("focus", "bg-sky", "focus ring on the sky end of the gradient"),
  ui("focus", "surface", "focus ring on a card"),
  ui("focus", "surface-frost", "focus ring on a frosted card"),
  ui("gate", "bg", "the gate in the drawings"),
  ui("gate", "bg-sky", "the gate in the drawings, on the sky gradient"),
  ui("field-border", "surface-soft", "input edge on a soft surface"),
];

/** The text-colour tokens the stylesheets may use (`color: var(--x)`). Each must appear as a foreground above. */
export const FOREGROUND_TOKENS: readonly string[] = [...new Set(PAIRS.map((p) => p.fg))];

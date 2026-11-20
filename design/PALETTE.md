# Palette

The light palette is sampled from the reference screenshot, `design/reference/palette-promptiq.png` (841 by 508 pixels), with a script. Only colour was taken from it: no layout, headline, copy, avatar row, rating row, client logo or image is used. `python design/sample-palette.py` prints every sampled value below, and `python design/derive-palette.py` prints every adjustment with its contrast ratios; both need Pillow, read the image and write nothing. A region is a pixel box (x0, y0) to (x1, y1) of the image, and a value is the median colour of the pixels in it, unless the table says otherwise.

An earlier version of this file said the image was not found and that the brief's fallback palette was in use. That is no longer true; DECISIONS.md items 117 to 122 record the change.

## What was sampled

| Role | Value | Where it comes from |
| --- | --- | --- |
| Gradient start | `#E3EDF4` | the frosted light band at the centre right, (690, 180) to (740, 230), 2,500 pixels |
| Gradient mid stop 1 | `#D3E8F8` | the lower right of the hero, (780, 430) to (810, 460), 900 pixels |
| Gradient mid stop 2 | `#AEDCF9` | the lower left of the hero, (30, 330) to (60, 360), 900 pixels |
| Gradient end, and the strongest blue | `#92D5F8` | the upper left of the hero, (30, 40) to (60, 70), 900 pixels. It is also the strongest saturated blue: of 336,535 light blue pixels in the hero panel, the most saturated 1% have this median (hue 201 degrees, HSL saturation 0.88, lightness 0.77). |
| Lightest streak | `#EAEFF3` | the lightest 2% of 6,134 samples of the hero background; the streak at (740, 100) to (780, 140) gives the same value |
| Card, the frame around the hero | `#F3F4F5` | the frame's inner column, x = 7, y 230 to 290. The frame's top edge, (200, 0) to (600, 3), is `#F2F3F3`. |
| Ink, the headline | `#21201E` | the darkest 4% of the headline box, (200, 145) to (640, 262), 2,059 pixels |
| Ink, the primary button | `#232323` | "Get Free Consultation", (690, 14) to (700, 32), and the right edge of "Get Started", (390, 330) to (399, 357); the left edge of "Get Started" is `#242422` |
| Secondary button, pale blue | `#DBEBF7` | "How We Work", right edge, (506, 332) to (520, 355), 322 pixels; the left edge is `#DBECF6` |
| Thin border | `#B7CDDA` | the border line of the frame, column x = 5, y 230 to 290 |
| Strong border | `#A7C3D6` | the gutter outside the frame, (0, 200) to (3, 300), 300 pixels |
| Text on the gradient, navigation links | `#46535C` | the darkest 8% of the navigation text, (313, 16) to (492, 30), 200 pixels |
| Text on the gradient, sub-headline | `#6F808A` | the darkest 8% of the sub-headline, (257, 271) to (583, 305), 886 pixels |

The hero's median colour across the whole panel is `#C6E3F8`; it is not used as a token.

## Final tokens, light

All are in `apps/web/src/design/tokens.css`, the one file that defines a colour.

| Token | Value | Source |
| --- | --- | --- |
| `--c-ice`, `--bg` | `#E3EDF4` | sampled: gradient start. The page background. |
| `--c-mid-1`, `--hero-mid-1` | `#D3E8F8` | sampled: gradient mid stop 1 |
| `--c-mid-2`, `--hero-mid-2` | `#AEDCF9` | sampled: gradient mid stop 2 |
| `--c-sky`, `--bg-sky` | `#92D5F8` | sampled: gradient end |
| `--c-soft`, `--surface-soft` | `#EAEFF3` | sampled: lightest streak |
| `--c-card`, `--surface` | `#F3F4F5` | sampled: the frame. `--surface-frost` is this colour at 72% opacity. |
| `--c-ink`, `--fg`, `--footer-bg` | `#21201E` | sampled: headline ink |
| `--c-button`, `--action` | `#232323` | sampled: primary button |
| `--c-pale`, `--soft-btn`, `--info-bg` | `#DBEBF7` | sampled: secondary button |
| `--c-border`, `--border` | `#B7CDDA` | sampled: thin border |
| `--c-border-strong`, `--border-strong`, `--footer-fg` | `#A7C3D6` | sampled: the gutter |
| `--c-ink-2`, `--fg-secondary`, `--action-hover` | `#46535C` | sampled: navigation text |
| `--c-muted`, `--fg-muted` | `#4C575E` | adjusted from the sub-headline sample (below) |
| `--c-accent`, `--accent`, `--focus` | `#0B75AC` | adjusted from the strongest blue (below) |
| `--c-accent-ink`, `--accent-text` | `#095B85` | adjusted from the strongest blue (below) |
| `--c-accent-deep`, `--info-fg` | `#063E5B` | the same blue, darkened to 7:1 on the page, for hover and the info tag's text |
| `--field-border` | `#578AA8` | adjusted from the thin border (below) |
| `--c-pale-hover` | `#CBE6F8` | derived: the pale blue, 35% of the way to gradient mid stop 2 |
| `--footer-dim` | `#7A8B94` | adjusted from the sub-headline sample (below) |
| `--neutral-bg` | `#DEE6EC` | derived: the thin border, 35%, with the card, 65% |
| `--water-a`, `--water-b`, `--water-c` | `#70BEE6`, `#4FA7D5`, `#3492C3` | derived: the sampled sky mixed with the accent, 25%, 50% and 70%, for the drawing |

The success, warning and error tints (green, amber, red) are meanings, not part of the image, and are unchanged.

**Gradients.** The hero's background is the sampled start, two mid stops and end, then back to the page colour: `--hero-gradient` runs `--bg` 0%, `--hero-mid-1` 26%, `--hero-mid-2` 50%, `--bg-sky` 68%, `--bg` 100%. The page heads fade from `--bg` to `--hero-mid-1` (`--page-gradient`). Both are defined in the tokens file, so the dark theme gets its own stops. In the screenshots the largest step between neighbouring pixels in the hero's text area is one colour level, with no run of identical colour longer than 12 pixels, so there is no visible banding. The tinted sections use 30% of the sky over the page.

## Adjusted for contrast

A sampled value that failed was changed in HSL (hue and saturation kept) one step at a time, and measured after rounding to the hex the stylesheet holds, until it met its target on the worst background it sits on. The backgrounds are the page, the gradient's four stops, a card, the soft surface, and a frosted card laid over each stop.

| Value | Sample | Ratio before | Final | Ratio after | Target | Why |
| --- | --- | --- | --- | --- | --- | --- |
| Muted text | `#6F808A` | 2.55 | `#4C575E` | 4.62 | 4.5 | The sub-headline's grey is too light on the sky end of the gradient. The image's own small text is anti-aliased, so the sample also reads lighter than the colour the text was drawn in. |
| Accent for focus rings and edges | `#92D5F8` | 1.00 | `#0B75AC` | 3.15 | 3 | The strongest blue is the sky itself, so it has no contrast against the sky. Darkened until a focus ring is visible on every stop. |
| Accent for link text | `#92D5F8` | 1.00 | `#095B85` | 4.60 | 4.5 | The same blue, darkened further for small text. |
| Input edge | `#B7CDDA` | 1.39 | `#578AA8` | 3.15 | 3 | The thin border is a decorative line. An input's edge has to be visible against the page, a card and a frosted card. |
| Footer small print | `#6F808A` | 3.98 | `#7A8B94` | 4.61 | 4.5 | Lightened for the sampled ink footer. |
| Dark input edge | `#365463` | 1.84 | `#4E7A8F` | 3.18 | 3 | Lightened for the dark surfaces. |

Sampled values that already passed are used as they are: the ink (13.71 on the page, 10.15 on the sky), the navigation text as secondary text (4.94 on the sky), and the strong border as the footer's text (8.85 on the ink).

## Dark theme

The same hue family, re-derived from the sampled blues: the sky's hue (201 degrees) on deep navy-ink, with the sampled values themselves as text.

| Token | Value | Source |
| --- | --- | --- |
| `--bg` | `#081319` | hue 201, saturation 50%, lightness 6.5% |
| `--hero-mid-1`, `--hero-mid-2`, `--bg-sky` | `#0B1920`, `#0E1D25`, `#10222B` | the gradient's stops, lightness 8.5%, 10% and 11.5% |
| `--surface`, `--surface-soft` | `#0F1D24`, `#162A34` | lightness 10% and 14.5%; `--surface-frost` is `#0F1D24` at 72% |
| `--border`, `--border-strong` | `#223844`, `#365463` | lightness 20% and 30% |
| `--field-border` | `#4E7A8F` | adjusted (above) |
| `--fg` | `#E3EDF4` | sampled: gradient start (8.97 on the darkest dark surface) |
| `--fg-secondary` | `#D3E8F8` | sampled: gradient mid stop 1 (8.45) |
| `--fg-muted`, `--footer-fg`, `--neutral-fg` | `#A7C3D6` | sampled: the gutter (5.79) |
| `--accent`, `--accent-text`, `--focus`, `--info-fg` | `#92D5F8` | sampled: the strongest blue (6.64) |
| `--action`, `--footer-heading` | `#F3F4F5`, `#E3EDF4` | sampled: the frame, and the gradient start |
| `--action-fg`, `--on-accent` | `#21201E` | sampled: ink |
| `--soft-btn`, `--soft-btn-hover` | `#1C3440`, `#234252` | lightness 18% and 23% |
| `--footer-bg`, `--footer-dim` | `#050D12`, `#6F808A` | lightness 4.5%; the sub-headline sample (4.78 on it) |
| `--water-a`, `--water-b`, `--water-c` | `#173C4F`, `#1E4E67`, `#276686` | the same hue, lightness 20%, 26% and 34% |
| `--gate` | `#E3EDF4` | sampled |

## Contrast results

`test/unit/web/design.test.ts` computes the WCAG contrast of the 57 pairs in `apps/web/src/design/pairs.ts` (45 for text, 12 for the edges of controls and focus rings) in the light theme, the dark theme and the dark block that applies when the system asks for it, and it holds the two copies of the dark theme identical. The minimums are 4.5:1 for text and 3:1 for large text and for the edges of controls, and the test also checks those constants. Pairs include the gradient's mid stops and a frosted card over each stop. All pass.

The tightest results are, in the light theme, an input's edge on a frosted card (3.06, needs 3), the muted text on the sky end (4.62) and the link text on the sky end (4.60), and in the dark theme an input's edge on the soft surface (3.18) and the footer's small print (4.78).

## What was not changed

The fonts, the type scale, the spacing, the radii, the layout, the footer's structure and every word of copy are as they were. The CSS changed in three places, all colour: the hero and the page heads read `--hero-gradient` and `--page-gradient`, and the tinted sections use 30% of the sky.

## What was taken from the family

The fonts (Inter Tight, IBM Plex Mono, Instrument Serif), the type scale, the 4px spacing scale, the radii (pill, 14, 20, 28, 36), the pill buttons, the floating pill navigation and the footer's structure were read from the founder's Veylo project (read-only) and written again here from scratch. No Veylo colour is used.

The brand marks in `apps/web/public/brand/` and `apps/web/src/app/icon.svg` carry the ink, the gradient start, the sky and the accent as literals, because an image file cannot read a stylesheet. `apps/web/scripts/og.mjs` reads the colours for the link-preview image from the tokens file.

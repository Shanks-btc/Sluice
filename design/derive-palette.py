# Derives the values that had to be adjusted from the sampled colours (design/sample-palette.py), and prints each one's contrast
# ratio before and after. A value is darkened or lightened in HSL (hue and saturation kept) one step at a time, and measured after
# rounding to the hex the stylesheet holds, until it meets its target on the worst background it sits on. It needs no image and
# writes nothing.
#
#   python design/derive-palette.py
#
# apps/web/src/design/tokens.css holds the results, and test/unit/web/design.test.ts is the check that decides whether they pass.
import colorsys


def rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def hx(c):
    return "#%02X%02X%02X" % tuple(max(0, min(255, int(round(v)))) for v in c)


def lum(c):
    def ch(v):
        s = v / 255
        return s / 12.92 if s <= 0.03928 else ((s + 0.055) / 1.055) ** 2.4

    return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2])


def ratio(a, b):
    la, lb = lum(a), lum(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)


def over(top, a, under):
    return tuple(top[i] * a + under[i] * (1 - a) for i in range(3))


def hsl(c):
    h, l, s = colorsys.rgb_to_hls(*(v / 255 for v in c))
    return h, s, l


def from_hsl(h, s, l):
    return tuple(v * 255 for v in colorsys.hls_to_rgb(h, l, s))


def adjust(sample, bgs, need, direction):
    h, s, l = hsl(sample)
    c = rgb(hx(sample))
    step = -0.002 if direction == "darker" else 0.002
    while min(ratio(c, b) for b in bgs) < need and 0 < l < 1:
        l += step
        c = rgb(hx(from_hsl(h, s, l)))
    return c


S = {k: rgb(v) for k, v in {
    "ice": "#E3EDF4", "sky": "#92D5F8", "mid1": "#D3E8F8", "mid2": "#AEDCF9", "soft": "#EAEFF3", "card": "#F3F4F5",
    "ink": "#21201E", "pale": "#DBEBF7", "border": "#B7CDDA", "border_strong": "#A7C3D6", "nav": "#46535C", "sub": "#6F808A",
}.items()}
frost = [over(S["card"], 0.72, S[k]) for k in ("ice", "sky", "mid1", "mid2")]
PAGE = [S["ice"], S["card"], S["soft"], S["sky"], S["mid1"], S["mid2"]] + frost
UI = [S["ice"], S["card"], S["soft"], S["sky"], S["mid1"], S["mid2"], frost[0]]


def show(name, before, after, bgs, need):
    b = min(ratio(before, x) for x in bgs)
    a = min(ratio(after, x) for x in bgs)
    print(f"{name:34s} {hx(before)} {b:5.2f}  ->  {hx(after)} {a:5.2f}   (needs {need})")


print("light: worst-case ratios on the page, the gradient's stops, cards and frosted cards")
show("muted text (sub-headline sample)", S["sub"], adjust(S["sub"], PAGE, 4.6, "darker"), PAGE, 4.5)
print(f"  navigation link text kept as sampled {hx(S['nav'])}: {min(ratio(S['nav'], x) for x in PAGE):.2f}")
show("accent for focus rings and edges", S["sky"], adjust(S["sky"], UI, 3.15, "darker"), UI, 3.0)
show("accent for link text", S["sky"], adjust(S["sky"], PAGE, 4.6, "darker"), PAGE, 4.5)
print(f"  accent deep (hover, info text) {hx(adjust(S['sky'], PAGE, 7.0, 'darker'))}")
edge_bgs = [S["ice"], S["card"], S["soft"], frost[0]]
show("input edge (border sample)", S["border"], adjust(S["border"], edge_bgs, 3.15, "darker"), edge_bgs, 3.0)
fb = S["ink"]
show("footer small print", S["sub"], adjust(S["sub"], [fb], 4.6, "lighter"), [fb], 4.5)

print("\ndark: the sampled sky's hue, 201 degrees, on deep navy-ink")
h0 = hsl(S["sky"])[0]
D = {"bg": (0.50, 0.065), "mid1": (0.48, 0.085), "mid2": (0.46, 0.10), "sky": (0.46, 0.115), "surface": (0.42, 0.10),
     "soft": (0.40, 0.145), "border": (0.34, 0.20), "border_strong": (0.30, 0.30), "button": (0.40, 0.18),
     "button_hover": (0.40, 0.23), "footer": (0.55, 0.045)}
dk = {k: rgb(hx(from_hsl(h0, s, l))) for k, (s, l) in D.items()}
for k, v in dk.items():
    print(f"  {k:14s} {hx(v)}")
bgs = [dk[k] for k in ("bg", "mid1", "mid2", "sky", "surface", "soft", "button", "button_hover")]
for name, c in (("text", S["ice"]), ("secondary text", S["mid1"]), ("muted text", S["border_strong"]), ("accent", S["sky"])):
    print(f"  {name:15s} sampled {hx(c)} on the dark surfaces: worst {min(ratio(c, b) for b in bgs):.2f}")
edge = [dk["bg"], dk["surface"], dk["soft"]]
show("dark input edge", dk["border_strong"], adjust(dk["border_strong"], edge, 3.15, "lighter"), edge, 3.0)

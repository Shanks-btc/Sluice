# Samples colours from design/reference/palette-promptiq.png. Needs Pillow (python -m pip install Pillow). It reads the image and
# prints numbers; it writes nothing. Only colour is read from the image. Every region is a pixel box (x0, y0, x1, y1) of the
# 841 x 508 image, and every value is the median of the pixels in the box unless the line says otherwise.
#
#   python design/sample-palette.py
#
# design/PALETTE.md lists the values this prints and says which ones were adjusted afterwards for contrast.
import colorsys
import statistics
from pathlib import Path

from PIL import Image

PATH = Path(__file__).resolve().parent / "reference" / "palette-promptiq.png"
im = Image.open(PATH).convert("RGB")
px = im.load()


def hexof(c):
    return "#%02X%02X%02X" % tuple(int(round(v)) for v in c)


def box(x0, y0, x1, y1):
    return [px[x, y] for y in range(y0, y1) for x in range(x0, x1)]


def median(colors):
    return tuple(statistics.median(c[i] for c in colors) for i in range(3))


def lum(c):
    def ch(v):
        s = v / 255
        return s / 12.92 if s <= 0.03928 else ((s + 0.055) / 1.055) ** 2.4

    return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2])


def darkest(colors, frac):
    ordered = sorted(colors, key=lum)
    return ordered[: max(1, int(len(ordered) * frac))]


def report(name, region, colors, note="median"):
    print(f"{name:46s} {hexof(median(colors))}   box={region}  n={len(colors)}  ({note})")


print(f"image {im.size[0]}x{im.size[1]}\n")
print("hero gradient")
report("start (frosted light band)", (690, 180, 740, 230), box(690, 180, 740, 230))
report("mid stop 1 (bottom right)", (780, 430, 810, 460), box(780, 430, 810, 460))
report("mid stop 2 (lower left)", (30, 330, 60, 360), box(30, 330, 60, 360))
report("end (top left, the deepest sky)", (30, 40, 60, 70), box(30, 40, 60, 70))
grid = [px[x, y] for y in range(45, 480, 6) for x in range(20, 820, 6) if not (190 < x < 650 and 130 < y < 420)]
ordered = sorted(grid, key=lum)
print(f"  across {len(grid)} samples of the hero background: darkest 2% {hexof(median(ordered[: len(ordered) // 50]))}, "
      f"median {hexof(median(ordered))}, lightest 2% {hexof(median(ordered[-len(ordered) // 50:]))}")

print("\nink")
report("headline", (200, 145, 640, 262), darkest(box(200, 145, 640, 262), 0.04), "median of the darkest 4%")
report("primary button 'Get Started', left", (318, 330, 328, 357), box(318, 330, 328, 357))
report("primary button 'Get Started', right", (390, 330, 399, 357), box(390, 330, 399, 357))
report("primary button 'Get Free Consultation'", (690, 14, 700, 32), box(690, 14, 700, 32))

print("\nsecondary button")
report("'How We Work', left", (418, 332, 428, 355), box(418, 332, 428, 355))
report("'How We Work', right", (506, 332, 520, 355), box(506, 332, 520, 355))

print("\nsurface and border")
report("frame, top edge", (200, 0, 600, 3), box(200, 0, 600, 3))
report("frame, inner column x=7", (7, 230, 8, 290), box(7, 230, 8, 290))
report("border line, column x=5", (5, 230, 6, 290), box(5, 230, 6, 290))
report("gutter outside the frame", (0, 200, 3, 300), box(0, 200, 3, 300))
report("lightest 3% of the hero background", (20, 45, 820, 480), ordered[-len(ordered) // 30:], "median of the lightest 3%")

print("\ntext on the gradient")
report("navigation link text", (313, 16, 492, 30), darkest(box(313, 16, 492, 30), 0.08), "median of the darkest 8%")
report("sub-headline text", (257, 271, 583, 305), darkest(box(257, 271, 583, 305), 0.08), "median of the darkest 8%")

print("\nthe strongest saturated blue in the hero panel")
rows = []
for y in range(30, 470):
    for x in range(14, 828):
        r, g, b = px[x, y]
        h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        if 0.52 <= h <= 0.62 and v > 0.85:
            rows.append((s, (r, g, b)))
rows.sort(key=lambda t: -t[0])
top = [t[1] for t in rows[: max(10, len(rows) // 100)]]
c = median(top)
h, s, v = colorsys.rgb_to_hsv(*(k / 255 for k in c))
_, l, sl = colorsys.rgb_to_hls(*(k / 255 for k in c))
print(f"  {len(rows)} light blue pixels; median of the most saturated 1%: {hexof(c)} "
      f"(hue {h * 360:.0f} degrees, HSL saturation {sl:.2f}, lightness {l:.2f})")

#!/usr/bin/env python3
"""Render the raster icons and the social preview for the app.

The outputs are committed (public/icon-*.png, apple-touch-icon.png,
og-image.png) so a build needs nothing beyond Node. Re-run this script only
when the visual identity changes:

    python3 scripts/make-icons.py

Requires Pillow and DejaVu fonts (both present in the dev container).
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

PUBLIC = Path(__file__).resolve().parent.parent / "public"

ACCENT = (21, 101, 192)      # #1565c0 — the app's line-blue
ACCENT_DEEP = (11, 47, 92)   # #0b2f5c — og background
ACCENT_LIGHT = (30, 136, 229)
S_BAHN = (46, 125, 50)       # #2e7d32
U_BAHN = (21, 101, 192)
TRAM = (198, 40, 40)         # #c62828
WHITE = (255, 255, 255)

FONT_DIR = Path("/usr/share/fonts/truetype/dejavu")


def font(size: int, bold: bool = False):
    name = "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"
    path = FONT_DIR / name
    if not path.exists():
        raise SystemExit(f"Missing font {path}")
    return ImageFont.truetype(str(path), size)


def transit_mark(draw: ImageDraw.ImageDraw, scale: float):
    """The favicon motif: two dots joined by a bar, centred at 16,16."""
    left, right = 9 * scale, 23 * scale
    cy = 16 * scale
    r = 3.2 * scale
    bar_x = 11.5 * scale
    bar_w = 9 * scale
    bar_h = 2.8 * scale
    draw.ellipse([left - r, cy - r, left + r, cy + r], fill=WHITE)
    draw.ellipse([right - r, cy - r, right + r, cy + r], fill=S_BAHN)
    draw.rounded_rectangle(
        [bar_x, cy - bar_h / 2, bar_x + bar_w, cy + bar_h / 2],
        radius=bar_h / 2,
        fill=WHITE,
    )


def icon(path: Path, size: int):
    ss = 4  # supersample, then downscale for clean edges
    img = Image.new("RGBA", (size * ss, size * ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, size * ss - 1, size * ss - 1], radius=72 * ss,
                        fill=ACCENT)
    # a quiet vertical sheen, so the flat blue reads as an app icon
    top = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(top).ellipse([-size * ss, -size * ss * 0.7,
                                 size * ss * 2.1, size * ss * 0.7],
                                fill=(255, 255, 255, 26))
    img = Image.alpha_composite(img, top)
    d = ImageDraw.Draw(img)
    scale = size / 32
    transit_mark(d, scale)
    img = img.resize((size, size), Image.LANCZOS)
    img.save(path, "PNG")


def rounded_badge(d: ImageDraw.ImageDraw, box, label: str, bg, text_color, fnt):
    x0, y0, x1, y1 = box
    d.rounded_rectangle(box, radius=(y1 - y0) // 2, fill=bg)
    bb = d.textbbox((0, 0), label, font=fnt)
    tx = x0 + (x1 - x0 - (bb[2] - bb[0])) / 2
    ty = y0 + (y1 - y0 - (bb[3] - bb[1])) / 2 - bb[1]
    d.text((tx, ty), label, font=fnt, fill=text_color)


def social_preview(path: Path):
    w, h = 1200, 630
    ss = 2
    img = Image.new("RGBA", (w * ss, h * ss), ACCENT_DEEP)
    d = ImageDraw.Draw(img)
    # diagonal wash toward the app blue
    for i in range(h * ss):
        t = i / (h * ss)
        colour = tuple(round(a + (b - a) * t) for a, b in zip(ACCENT_DEEP, ACCENT))
        d.line([(0, i), (w * ss, i)], fill=colour)
    # a faint route line across the lower right, echoing the map
    pts = [(0.62 * w, 0.86 * h), (0.70 * w, 0.70 * h), (0.80 * w, 0.66 * h),
           (0.92 * w, 0.55 * h), (0.97 * w, 0.42 * h)]
    pts = [(x * ss, y * ss) for x, y in pts]
    d.line(pts, fill=(255, 255, 255, 70), width=round(10 * ss), joint="curve")
    for x, y in (pts[0], pts[-1]):
        r = round(13 * ss)
        d.ellipse([x - r, y - r, x + r, y + r], outline=WHITE, width=round(6 * ss))

    title = font(round(96 * ss), bold=True)
    tag = font(round(40 * ss))
    small = font(round(27 * ss))
    badge = font(round(34 * ss), bold=True)
    d.text((72 * ss, 138 * ss), "wo ist die bahn", font=title, fill=WHITE)
    d.text((74 * ss, 278 * ss), "Live Berlin transit map", font=tag,
           fill=(210, 225, 244, 255))
    d.text((74 * ss, 470 * ss), "S-Bahn  ·  U-Bahn  ·  Tram  ·  Bus",
           font=small, fill=(180, 200, 228, 255))
    # the three mode badges beside the text
    rows = [("S5", S_BAHN, 0.18), ("U2", U_BAHN, 0.43), ("M10", TRAM, 0.68)]
    for label, bg, yy in rows:
        y = (yy * h + 0.07 * h) * ss
        rounded_badge(d, (0.72 * w * ss, y, 0.90 * w * ss, y + 54 * ss),
                      label, bg, WHITE, badge)
    img = img.resize((w, h), Image.LANCZOS)
    img.convert("RGB").save(path, "PNG")


def main():
    icon(PUBLIC / "icon-192.png", 192)
    icon(PUBLIC / "icon-512.png", 512)
    icon(PUBLIC / "apple-touch-icon.png", 180)
    social_preview(PUBLIC / "og-image.png")
    for name in ("icon-192.png", "icon-512.png", "apple-touch-icon.png", "og-image.png"):
        p = PUBLIC / name
        im = Image.open(p)
        print(f"{name}: {im.size[0]}x{im.size[1]} {p.stat().st_size} bytes")


if __name__ == "__main__":
    main()

"""Generate the desktop tray icons from the app launcher art.

Build-time asset tool, not shipped code. Run from the repo root when icon.png
changes, then commit the four regenerated PNGs:

    python3 desktop/build/gen-tray-icons.py     # needs Pillow

Base art: desktop/build/icon.png (512x512 pixel-art "P").
Outputs (desktop/assets/):
  tray.png            32x32  plain
  tray@2x.png         64x64  plain
  tray-unread.png     32x32  with unread badge
  tray-unread@2x.png  64x64  with unread badge

Badge colours match the in-app .mx-badge.hl rule in client/src/matrix/matrixSkin.ts
(fill #c51a1b, top highlight #e2585a, bottom shade #5c0f10) on a #0a0908 outline.
"""

from PIL import Image, ImageDraw
from pathlib import Path

SRC = Path("desktop/build/icon.png")
OUT = Path("desktop/assets")

FILL = (0xC5, 0x1A, 0x1B, 0xFF)
HI = (0xE2, 0x58, 0x5A, 0xFF)
LO = (0x5C, 0x0F, 0x10, 0xFF)
EDGE = (0x0A, 0x09, 0x08, 0xFF)

# Badge geometry on the 32x32 grid: an 11x11 pixel-art rounded square with its
# corners cut 2px, so it reads as a disc once the panel scales it down. It sits
# bottom-right because that is the one corner the "P" leaves empty (the glyph
# occupies cols 6-23, rows 4-27, and below the bowl only the left stem remains)
# — a top-right badge covers the bowl and the icon stops being recognisable.
# Doubling for @2x is a nearest upscale of this exact grid, so both sizes are
# the same drawing rather than two independently-rounded shapes.
SIZE = 32
BADGE = 11
CUT = 2


def badge_layer() -> Image.Image:
    layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    x0 = SIZE - BADGE
    y0 = SIZE - BADGE
    for row in range(BADGE):
        # Corner cut: how many pixels to shave off each end of this row.
        dist_top = row
        dist_bottom = BADGE - 1 - row
        edge = min(dist_top, dist_bottom)
        inset = max(0, CUT - edge)
        left = x0 + inset
        right = x0 + BADGE - 1 - inset
        y = y0 + row
        if row == 0 or row == 1:
            colour = HI
        elif row >= BADGE - 2:
            colour = LO
        else:
            colour = FILL
        d.line([(left, y), (right, y)], fill=colour)
    # 1px dark outline so the badge stays separate from the art underneath it.
    outline = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    od = ImageDraw.Draw(outline)
    alpha = layer.split()[3]
    for y in range(SIZE):
        for x in range(SIZE):
            if alpha.getpixel((x, y)):
                continue
            if any(
                0 <= x + dx < SIZE and 0 <= y + dy < SIZE and alpha.getpixel((x + dx, y + dy))
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))
            ):
                od.point((x, y), fill=EDGE)
    return Image.alpha_composite(outline, layer)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    base = Image.open(SRC).convert("RGBA")
    # 512 -> 32 is an exact /16, so NEAREST keeps every pixel-art edge crisp.
    small = base.resize((SIZE, SIZE), Image.NEAREST)
    badge = badge_layer()
    unread = Image.alpha_composite(small, badge)

    small.save(OUT / "tray.png")
    small.resize((SIZE * 2, SIZE * 2), Image.NEAREST).save(OUT / "tray@2x.png")
    unread.save(OUT / "tray-unread.png")
    unread.resize((SIZE * 2, SIZE * 2), Image.NEAREST).save(OUT / "tray-unread@2x.png")
    print("wrote", *(p.name for p in sorted(OUT.iterdir())))


main()

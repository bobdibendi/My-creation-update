#!/usr/bin/env python3
"""
Generates every icon and installer image the Windows build needs.

Outputs (all committed, so `npm run dist` never depends on Python):
  build/icon.png                1024x1024 master
  build/icon.ico                multi-size Windows icon
  build/icon.icns               macOS icon
  build/icons/<size>.png        Linux icon set
  build/installerHeader.bmp     NSIS header, 150x57
  build/installerSidebar.bmp    NSIS welcome/finish sidebar, 164x314
  build/uninstallerSidebar.bmp  NSIS uninstall sidebar, 164x314

Requires Pillow. Run with: npm run icons
"""
from __future__ import annotations

import os
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "build")
ICONS = os.path.join(BUILD, "icons")

# Brand palette, mirrored from src/theme/themes.ts (Claude family).
BG_TOP = (24, 23, 28)
BG_BOTTOM = (10, 10, 12)
ACCENT = (212, 180, 131)
ACCENT_DEEP = (166, 133, 86)
TEXT = (255, 255, 255)

MASTER = 1024
# Supersampling factor: everything is drawn large, then downscaled with LANCZOS
# so the diagonals of the cursor glyph stay clean at 16x16.
SS = 4


def vertical_gradient(size: int, top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    gradient = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / max(1, size - 1)
        gradient.putpixel((0, y), (
            round(top[0] + (bottom[0] - top[0]) * t),
            round(top[1] + (bottom[1] - top[1]) * t),
            round(top[2] + (bottom[2] - top[2]) * t),
        ))
    return gradient.resize((size, size), Image.NEAREST)


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def cursor_polygon(size: int) -> list[tuple[float, float]]:
    """
    Classic arrow pointer, expressed in fractions of the canvas.

    The raw outline is fitted into a centred box covering `SCALE` of the canvas,
    so the glyph stays optically centred instead of drifting toward the corner
    its bounding box happens to favour.
    """
    points = [
        (0.335, 0.180),
        (0.335, 0.792),
        (0.470, 0.664),
        (0.560, 0.868),
        (0.664, 0.820),
        (0.575, 0.620),
        (0.756, 0.598),
    ]

    scale = 0.60
    min_x = min(x for x, _ in points)
    max_x = max(x for x, _ in points)
    min_y = min(y for _, y in points)
    max_y = max(y for _, y in points)
    span = max(max_x - min_x, max_y - min_y)
    factor = scale / span

    width = (max_x - min_x) * factor
    height = (max_y - min_y) * factor
    offset_x = (1 - width) / 2
    offset_y = (1 - height) / 2

    return [
        ((offset_x + (x - min_x) * factor) * size, (offset_y + (y - min_y) * factor) * size)
        for x, y in points
    ]


def draw_master() -> Image.Image:
    size = MASTER * SS
    radius = round(size * 0.215)

    base = vertical_gradient(size, BG_TOP, BG_BOTTOM).convert("RGBA")
    base.putalpha(rounded_mask(size, radius))

    draw = ImageDraw.Draw(base)

    # Hairline border so the icon keeps an edge on light and dark taskbars.
    draw.rounded_rectangle(
        (0, 0, size - 1, size - 1),
        radius=radius,
        outline=(255, 255, 255, 28),
        width=max(1, round(size * 0.006)),
    )

    # Accent glow behind the glyph, blurred to read as depth rather than a shape.
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse(
        (size * 0.14, size * 0.14, size * 0.86, size * 0.86),
        fill=ACCENT + (58,),
    )
    glow = glow.filter(ImageFilter.GaussianBlur(size * 0.085))
    base = Image.alpha_composite(base, glow)
    draw = ImageDraw.Draw(base)

    polygon = cursor_polygon(size)

    # Drop shadow under the pointer.
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    offset = size * 0.018
    ImageDraw.Draw(shadow).polygon([(x + offset, y + offset) for x, y in polygon], fill=(0, 0, 0, 150))
    shadow = shadow.filter(ImageFilter.GaussianBlur(size * 0.022))
    base = Image.alpha_composite(base, shadow)
    draw = ImageDraw.Draw(base)

    # The pointer itself: a light fill, then an accent gradient masked over it so
    # the glyph shades from sand to deep amber top-left to bottom-right.
    pointer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(pointer).polygon(polygon, fill=TEXT + (255,))

    shade = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shade_draw = ImageDraw.Draw(shade)
    steps = 96
    for index in range(steps):
        t = index / (steps - 1)
        colour = (
            round(ACCENT[0] + (ACCENT_DEEP[0] - ACCENT[0]) * t),
            round(ACCENT[1] + (ACCENT_DEEP[1] - ACCENT[1]) * t),
            round(ACCENT[2] + (ACCENT_DEEP[2] - ACCENT[2]) * t),
            255,
        )
        y0 = round(size * t)
        y1 = round(size * (t + 1 / steps)) + 1
        shade_draw.rectangle((0, y0, size, y1), fill=colour)

    glyph_mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(glyph_mask).polygon(polygon, fill=255)
    pointer = Image.composite(shade, pointer, glyph_mask.point(lambda v: 255 if v > 0 else 0))
    pointer.putalpha(glyph_mask)
    base = Image.alpha_composite(base, pointer)
    draw = ImageDraw.Draw(base)

    # Outline keeps the pointer legible against the dark backdrop at small sizes.
    draw.line(polygon + [polygon[0]], fill=(255, 255, 255, 120), width=max(1, round(size * 0.008)), joint="curve")

    return base.resize((MASTER, MASTER), Image.LANCZOS)


def save_ico(master: Image.Image) -> None:
    sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
    # Pillow's own downscaling inside save() is lower quality than an explicit
    # LANCZOS pass, and the 16px icon is where that difference is visible.
    frames = [master.resize((s, s), Image.LANCZOS) for s in sizes]
    frames[-1].save(
        os.path.join(BUILD, "icon.ico"),
        format="ICO",
        sizes=[(s, s) for s in sizes],
        append_images=frames[:-1],
    )


def save_icns(master: Image.Image) -> None:
    # ICNS requires a square power-of-two master; 1024 already is one.
    master.save(os.path.join(BUILD, "icon.icns"), format="ICNS")


def save_linux_icons(master: Image.Image) -> None:
    os.makedirs(ICONS, exist_ok=True)
    for size in (16, 32, 48, 64, 128, 256, 512, 1024):
        master.resize((size, size), Image.LANCZOS).save(os.path.join(ICONS, f"{size}x{size}.png"))


def installer_image(width: int, height: int, logo_ratio: float, master: Image.Image) -> Image.Image:
    canvas = vertical_gradient(max(width, height), BG_TOP, BG_BOTTOM).resize((width, height), Image.LANCZOS)

    glow = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse(
        (-width * 0.3, height * 0.35, width * 1.3, height * 1.25),
        fill=ACCENT + (46,),
    )
    glow = glow.filter(ImageFilter.GaussianBlur(min(width, height) * 0.22))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), glow)

    logo_size = max(16, round(min(width, height) * logo_ratio))
    logo = master.resize((logo_size, logo_size), Image.LANCZOS)
    canvas.alpha_composite(logo, ((width - logo_size) // 2, round(height * 0.13)))

    # BMP has no alpha channel; flatten onto the gradient.
    return canvas.convert("RGB")


def save_installer_images(master: Image.Image) -> None:
    installer_image(150, 57, 0.82, master).save(os.path.join(BUILD, "installerHeader.bmp"), format="BMP")
    sidebar = installer_image(164, 314, 0.66, master)
    sidebar.save(os.path.join(BUILD, "installerSidebar.bmp"), format="BMP")
    sidebar.save(os.path.join(BUILD, "uninstallerSidebar.bmp"), format="BMP")


def main() -> None:
    os.makedirs(BUILD, exist_ok=True)
    master = draw_master()
    master.save(os.path.join(BUILD, "icon.png"))
    save_ico(master)
    save_icns(master)
    save_linux_icons(master)
    save_installer_images(master)
    print(f"icons written to {BUILD}")


if __name__ == "__main__":
    main()

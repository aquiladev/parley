#!/usr/bin/env python3
"""
Parley logo pack generator.

Generates the full set of SVG files plus rasterized PNGs and a multi-resolution ICO.
Direction C4 — asymmetric arcs.
"""

import os
import subprocess
from pathlib import Path

import cairosvg
from PIL import Image

ROOT = Path(__file__).parent
SVG_DIR = ROOT / "svg"
PNG_DIR = ROOT / "png"
FAVICON_DIR = ROOT / "favicon"
SOCIAL_DIR = ROOT / "social"

for d in (SVG_DIR, PNG_DIR, FAVICON_DIR, SOCIAL_DIR):
    d.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# Mark geometry
# ---------------------------------------------------------------------------
# The mark is two arcs of a circle of radius R, offset symmetrically from the
# vertical center line by `gap/2`. Stroke widths differ: thicker (User Agent)
# on the left, thinner (MM Agent) on the right.
#
# Tuning curve: at hero sizes use a sharper weight ratio (~1.7:1); at favicon
# sizes use a softer ratio (~1.3:1) so the thin arc stays legible.

def arc_mark(
    size: int,
    *,
    weight_ratio: float | None = None,
    gap_pct: float = 0.14,
    stroke_pct: float = 0.10,
    color: str = "currentColor",
) -> str:
    """
    Render the arc mark in a square viewBox of the given size.

    `size` is the side length of the square in user units.
    `gap_pct` is the gap between arcs as a fraction of size.
    `stroke_pct` is the stroke width of the THICKER arc as a fraction of size.
    `weight_ratio` is thick:thin. Defaults vary by size:
        - hero (>=128): 1.7
        - mid (32..127): 1.5
        - small (<32):   1.3
    """
    if weight_ratio is None:
        if size >= 128:
            weight_ratio = 1.7
        elif size >= 32:
            weight_ratio = 1.5
        else:
            weight_ratio = 1.3

    cx = size / 2
    cy = size / 2
    radius = size * 0.34
    gap = size * gap_pct
    half_gap = gap / 2

    thick = size * stroke_pct
    thin = thick / weight_ratio

    # Left arc (thick): an arc of radius R centered at (cx, cy), opening to the
    # right. Sweep from top to bottom going through the LEFT side of the
    # circle.
    # Use SVG arc syntax: M x1 y1 A rx ry x-axis-rotation large-arc-flag sweep-flag x2 y2
    left_top_x = cx - half_gap
    left_top_y = cy - radius
    left_bot_x = cx - half_gap
    left_bot_y = cy + radius
    left_path = (
        f"M {left_top_x:.3f} {left_top_y:.3f} "
        f"A {radius:.3f} {radius:.3f} 0 0 0 {left_bot_x:.3f} {left_bot_y:.3f}"
    )

    right_top_x = cx + half_gap
    right_top_y = cy - radius
    right_bot_x = cx + half_gap
    right_bot_y = cy + radius
    right_path = (
        f"M {right_top_x:.3f} {right_top_y:.3f} "
        f"A {radius:.3f} {radius:.3f} 0 0 1 {right_bot_x:.3f} {right_bot_y:.3f}"
    )

    return (
        f'<g fill="none" stroke="{color}" stroke-linecap="round">\n'
        f'  <path d="{left_path}" stroke-width="{thick:.3f}"/>\n'
        f'  <path d="{right_path}" stroke-width="{thin:.3f}"/>\n'
        f'</g>'
    )


# ---------------------------------------------------------------------------
# SVG file builders
# ---------------------------------------------------------------------------

def build_mark_svg(size: int, *, color: str = "currentColor", bg: str | None = None) -> str:
    """Square mark-only SVG."""
    bg_layer = ""
    if bg is not None:
        bg_layer = f'  <rect width="{size}" height="{size}" fill="{bg}"/>\n'

    body = arc_mark(size, color=color)
    # Indent the body
    body = "  " + body.replace("\n", "\n  ")

    return f'''<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}" role="img" aria-label="Parley">
{bg_layer}{body}
</svg>
'''


def build_mark_circular_svg(size: int, *, fg: str, bg: str) -> str:
    """Circular avatar — solid background circle, mark inside."""
    cx = size / 2
    body = arc_mark(size, color=fg)
    body = "  " + body.replace("\n", "\n  ")

    return f'''<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}" role="img" aria-label="Parley">
  <circle cx="{cx}" cy="{cx}" r="{cx}" fill="{bg}"/>
{body}
</svg>
'''


def build_mark_rounded_svg(size: int, *, fg: str, bg: str, radius_pct: float = 0.22) -> str:
    """Rounded-square app icon — solid rounded background, mark inside."""
    radius = size * radius_pct
    body = arc_mark(size, color=fg)
    body = "  " + body.replace("\n", "\n  ")

    return f'''<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}" role="img" aria-label="Parley">
  <rect width="{size}" height="{size}" rx="{radius:.3f}" fill="{bg}"/>
{body}
</svg>
'''


# ---------------------------------------------------------------------------
# Wordmark + lockup builders
# ---------------------------------------------------------------------------

WORDMARK_FONT = (
    'system-ui, -apple-system, "Segoe UI", Inter, "Helvetica Neue", Arial, sans-serif'
)


def build_wordmark_only_svg(*, color: str = "currentColor") -> str:
    """Standalone wordmark, no mark."""
    width = 320
    height = 80
    text_size = 48
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-label="Parley">
  <text x="{width/2}" y="{height/2}" text-anchor="middle" dominant-baseline="central"
        font-family='{WORDMARK_FONT}' font-size="{text_size}" font-weight="500"
        letter-spacing="3" fill="{color}">parley</text>
</svg>
'''


def build_horizontal_lockup_svg(*, color: str = "currentColor") -> str:
    """Mark + wordmark side by side."""
    mark_size = 56
    text_size = 36
    gap = 18
    text_width = 165  # approximate visual width of "parley" at 36px with letter-spacing 3
    width = mark_size + gap + text_width + 20  # 20 px breathing on right
    height = mark_size + 20  # 10 px top/bottom

    mark_x = 10
    mark_y = (height - mark_size) / 2
    text_x = mark_x + mark_size + gap
    text_y = height / 2

    body_mark = arc_mark(mark_size, color=color)
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-label="Parley">
  <g transform="translate({mark_x} {mark_y})">
    {body_mark}
  </g>
  <text x="{text_x}" y="{text_y}" text-anchor="start" dominant-baseline="central"
        font-family='{WORDMARK_FONT}' font-size="{text_size}" font-weight="500"
        letter-spacing="2" fill="{color}">parley</text>
</svg>
'''


def build_stacked_lockup_svg(*, color: str = "currentColor") -> str:
    """Mark above wordmark."""
    mark_size = 96
    text_size = 28
    gap = 18
    text_width = 130
    width = max(mark_size, text_width) + 40
    height = mark_size + gap + text_size + 24  # 12 top, 12 bottom

    mark_x = (width - mark_size) / 2
    mark_y = 12
    text_x = width / 2
    text_y = mark_y + mark_size + gap + text_size / 2 + 4

    body_mark = arc_mark(mark_size, color=color)
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-label="Parley">
  <g transform="translate({mark_x} {mark_y})">
    {body_mark}
  </g>
  <text x="{text_x}" y="{text_y}" text-anchor="middle" dominant-baseline="central"
        font-family='{WORDMARK_FONT}' font-size="{text_size}" font-weight="500"
        letter-spacing="2.5" fill="{color}">parley</text>
</svg>
'''


# ---------------------------------------------------------------------------
# Social card (Open Graph / Twitter)
# ---------------------------------------------------------------------------

def build_social_card_svg(*, fg: str, bg: str) -> str:
    """1200×630 social card with mark, wordmark, and tagline."""
    width = 1200
    height = 630
    mark_size = 200

    mark_x = (width - mark_size) / 2
    mark_y = 160

    body_mark = arc_mark(mark_size, color=fg)

    return f'''<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-label="Parley — the agent layer for peer DeFi">
  <rect width="{width}" height="{height}" fill="{bg}"/>
  <g transform="translate({mark_x} {mark_y})">
    {body_mark}
  </g>
  <text x="{width/2}" y="430" text-anchor="middle" dominant-baseline="central"
        font-family='{WORDMARK_FONT}' font-size="78" font-weight="500"
        letter-spacing="6" fill="{fg}">parley</text>
  <text x="{width/2}" y="500" text-anchor="middle" dominant-baseline="central"
        font-family='{WORDMARK_FONT}' font-size="26" font-weight="400"
        letter-spacing="1" fill="{fg}" opacity="0.7">the agent layer for peer DeFi</text>
</svg>
'''


# ---------------------------------------------------------------------------
# Generate all SVGs
# ---------------------------------------------------------------------------

def write(path: Path, content: str) -> None:
    path.write_text(content)
    print(f"  wrote {path.relative_to(ROOT)}")


print("Generating SVGs...")

# Mark only — multiple sizes for direct use
for size in (16, 24, 32, 48, 64, 128, 256, 512):
    write(SVG_DIR / f"mark-{size}.svg", build_mark_svg(size))

# Mark only — currentColor (size-agnostic, scales to any context)
write(SVG_DIR / "mark.svg", build_mark_svg(512))

# Mark on dark — white-on-near-black
write(SVG_DIR / "mark-on-dark.svg", build_mark_svg(512, color="#FFFFFF", bg="#0F0F12"))

# Wordmark only
write(SVG_DIR / "wordmark.svg", build_wordmark_only_svg())

# Horizontal lockup
write(SVG_DIR / "lockup-horizontal.svg", build_horizontal_lockup_svg())

# Stacked lockup
write(SVG_DIR / "lockup-stacked.svg", build_stacked_lockup_svg())

# Avatar variants — circular, dark and light
write(
    SVG_DIR / "avatar-dark.svg",
    build_mark_circular_svg(512, fg="#FFFFFF", bg="#0F0F12"),
)
write(
    SVG_DIR / "avatar-light.svg",
    build_mark_circular_svg(512, fg="#0F0F12", bg="#FFFFFF"),
)

# App icon variants — rounded square, iOS/Android style
write(
    SVG_DIR / "app-icon-dark.svg",
    build_mark_rounded_svg(1024, fg="#FFFFFF", bg="#0F0F12"),
)
write(
    SVG_DIR / "app-icon-light.svg",
    build_mark_rounded_svg(1024, fg="#0F0F12", bg="#FFFFFF"),
)

# Favicon source — small mark on rounded background, both modes
write(
    SVG_DIR / "favicon.svg",
    build_mark_svg(64, color="currentColor"),
)

# Social card
write(SOCIAL_DIR / "og-card-light.svg", build_social_card_svg(fg="#0F0F12", bg="#FFFFFF"))
write(SOCIAL_DIR / "og-card-dark.svg", build_social_card_svg(fg="#FFFFFF", bg="#0F0F12"))


# ---------------------------------------------------------------------------
# Rasterize to PNG
# ---------------------------------------------------------------------------

print("\nRasterizing PNGs...")


def render_png(svg_path: Path, png_path: Path, output_size: int) -> None:
    cairosvg.svg2png(
        url=str(svg_path),
        write_to=str(png_path),
        output_width=output_size,
        output_height=output_size,
    )
    print(f"  wrote {png_path.relative_to(ROOT)} ({output_size}x{output_size})")


# Plain mark PNGs at common sizes — using the size-tuned SVG so weight ratios
# match the rendered size (e.g. mark-16.svg has soft 1.3:1 ratio for legibility)
for size in (16, 24, 32, 48, 64, 128, 256, 512, 1024):
    src = SVG_DIR / f"mark-{size if size <= 512 else 512}.svg"
    render_png(src, PNG_DIR / f"mark-{size}.png", size)

# Avatar PNGs — for Telegram bot, GitHub org, etc.
render_png(SVG_DIR / "avatar-dark.svg", PNG_DIR / "avatar-dark-512.png", 512)
render_png(SVG_DIR / "avatar-light.svg", PNG_DIR / "avatar-light-512.png", 512)

# App icon PNGs — iOS/Android home screen sizes
for size in (180, 192, 256, 512, 1024):
    render_png(SVG_DIR / "app-icon-dark.svg", PNG_DIR / f"app-icon-dark-{size}.png", size)
    render_png(SVG_DIR / "app-icon-light.svg", PNG_DIR / f"app-icon-light-{size}.png", size)

# Lockup PNGs at retina 2x for high-quality embeds
def render_svg_native_2x(svg_path: Path, png_path: Path) -> None:
    """Render an SVG at 2x its native size for retina PNG."""
    cairosvg.svg2png(
        url=str(svg_path),
        write_to=str(png_path),
        scale=2.0,
    )
    print(f"  wrote {png_path.relative_to(ROOT)} (2x native)")


render_svg_native_2x(SVG_DIR / "lockup-horizontal.svg", PNG_DIR / "lockup-horizontal-2x.png")
render_svg_native_2x(SVG_DIR / "lockup-stacked.svg", PNG_DIR / "lockup-stacked-2x.png")
render_svg_native_2x(SVG_DIR / "wordmark.svg", PNG_DIR / "wordmark-2x.png")

# Social card PNGs at native 1200x630
cairosvg.svg2png(
    url=str(SOCIAL_DIR / "og-card-light.svg"),
    write_to=str(SOCIAL_DIR / "og-card-light.png"),
    output_width=1200,
    output_height=630,
)
cairosvg.svg2png(
    url=str(SOCIAL_DIR / "og-card-dark.svg"),
    write_to=str(SOCIAL_DIR / "og-card-dark.png"),
    output_width=1200,
    output_height=630,
)
print(f"  wrote {(SOCIAL_DIR / 'og-card-light.png').relative_to(ROOT)} (1200x630)")
print(f"  wrote {(SOCIAL_DIR / 'og-card-dark.png').relative_to(ROOT)} (1200x630)")


# ---------------------------------------------------------------------------
# Favicons (mark on transparent rounded square, multi-resolution ICO)
# ---------------------------------------------------------------------------

print("\nBuilding favicons...")

# Build size-specific favicon SVGs (uses tuned weight ratios per size) on a
# rounded background so they look right against any browser chrome.
def build_favicon_svg(size: int, *, fg: str, bg: str) -> str:
    return build_mark_rounded_svg(size, fg=fg, bg=bg, radius_pct=0.18)


# We ship two themes: light (dark mark on white) and dark (white mark on near-black)
favicon_pngs_light: list[Path] = []
favicon_pngs_dark: list[Path] = []

for size in (16, 32, 48, 64, 96, 128, 180, 192, 256, 512):
    light_svg = FAVICON_DIR / f"favicon-light-{size}.svg"
    dark_svg = FAVICON_DIR / f"favicon-dark-{size}.svg"
    light_svg.write_text(build_favicon_svg(size, fg="#0F0F12", bg="#FFFFFF"))
    dark_svg.write_text(build_favicon_svg(size, fg="#FFFFFF", bg="#0F0F12"))

    light_png = FAVICON_DIR / f"favicon-light-{size}.png"
    dark_png = FAVICON_DIR / f"favicon-dark-{size}.png"
    cairosvg.svg2png(url=str(light_svg), write_to=str(light_png), output_width=size, output_height=size)
    cairosvg.svg2png(url=str(dark_svg), write_to=str(dark_png), output_width=size, output_height=size)

    if size in (16, 32, 48):
        favicon_pngs_light.append(light_png)
        favicon_pngs_dark.append(dark_png)
    print(f"  wrote favicon-light-{size}.{{svg,png}} and favicon-dark-{size}.{{svg,png}}")

# Build multi-resolution .ico files
def build_ico(pngs: list[Path], output: Path) -> None:
    images = [Image.open(p) for p in pngs]
    images[0].save(output, format="ICO", sizes=[(im.width, im.height) for im in images])
    print(f"  wrote {output.relative_to(ROOT)} (sizes: {[(im.width, im.height) for im in images]})")


build_ico(favicon_pngs_light, FAVICON_DIR / "favicon-light.ico")
build_ico(favicon_pngs_dark, FAVICON_DIR / "favicon-dark.ico")

# Apple touch icon: 180×180, no rounded background (iOS adds the corners itself)
def build_apple_touch_icon_svg(size: int = 180, fg: str = "#0F0F12", bg: str = "#FFFFFF") -> str:
    body = arc_mark(size, color=fg)
    body = "  " + body.replace("\n", "\n  ")
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}" role="img" aria-label="Parley">
  <rect width="{size}" height="{size}" fill="{bg}"/>
{body}
</svg>
'''

apple_svg = FAVICON_DIR / "apple-touch-icon.svg"
apple_svg.write_text(build_apple_touch_icon_svg())
cairosvg.svg2png(url=str(apple_svg), write_to=str(FAVICON_DIR / "apple-touch-icon.png"), output_width=180, output_height=180)
print(f"  wrote favicon/apple-touch-icon.{{svg,png}}")


# ---------------------------------------------------------------------------
# Web manifest + HTML snippet
# ---------------------------------------------------------------------------

print("\nGenerating web integration files...")

manifest = '''{
  "name": "Parley",
  "short_name": "Parley",
  "description": "The agent layer for peer DeFi.",
  "icons": [
    {
      "src": "/favicon/favicon-light-192.png",
      "sizes": "192x192",
      "type": "image/png"
    },
    {
      "src": "/favicon/favicon-light-512.png",
      "sizes": "512x512",
      "type": "image/png"
    }
  ],
  "theme_color": "#0F0F12",
  "background_color": "#FFFFFF",
  "display": "standalone"
}
'''
write(FAVICON_DIR / "manifest.webmanifest", manifest)

html_snippet = '''<!--
  Parley favicon + meta tag set.
  Copy into the <head> of your HTML (or your Next.js _document.tsx / app/layout.tsx).
-->

<!-- Modern browsers — single SVG, scales perfectly -->
<link rel="icon" type="image/svg+xml" href="/favicon/favicon-light-64.svg" media="(prefers-color-scheme: light)">
<link rel="icon" type="image/svg+xml" href="/favicon/favicon-dark-64.svg" media="(prefers-color-scheme: dark)">

<!-- Fallback PNGs for older browsers -->
<link rel="icon" type="image/png" sizes="32x32" href="/favicon/favicon-light-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/favicon/favicon-light-16.png">

<!-- Multi-resolution ICO (legacy IE / Edge fallback) -->
<link rel="shortcut icon" href="/favicon/favicon-light.ico">

<!-- iOS home screen -->
<link rel="apple-touch-icon" sizes="180x180" href="/favicon/apple-touch-icon.png">

<!-- Android / PWA -->
<link rel="manifest" href="/favicon/manifest.webmanifest">
<meta name="theme-color" content="#0F0F12">

<!-- Open Graph / Twitter card -->
<meta property="og:image" content="/social/og-card-light.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="/social/og-card-light.png">
'''
write(ROOT / "html-snippet.html", html_snippet)


print("\nDone.")

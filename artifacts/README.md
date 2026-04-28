# Parley logo pack

Production-ready logo assets for Parley. Direction C4 — asymmetric arcs.

The mark consists of two arcs facing each other across a small gap. The thicker arc on the left represents the **User Agent** (the initiating side); the thinner arc on the right represents the **Market Maker Agent** (the responsive side). The asymmetry encodes the protocol's intentional structural asymmetry: peers, but with different roles.

## What's in this pack

```
parley-logo-pack/
├── svg/                 — vector originals, edit these to make changes
│   ├── mark.svg                  primary mark, currentColor (size-agnostic)
│   ├── mark-{size}.svg           mark at specific sizes (16, 24, 32, 48, 64, 128, 256, 512)
│   ├── mark-on-dark.svg          white mark on near-black background
│   ├── wordmark.svg              "parley" text-only
│   ├── lockup-horizontal.svg     mark + wordmark side by side
│   ├── lockup-stacked.svg        mark above wordmark
│   ├── avatar-light.svg          circular, dark mark on white
│   ├── avatar-dark.svg           circular, white mark on near-black (Telegram default)
│   ├── app-icon-light.svg        rounded square, dark mark on white (1024px)
│   ├── app-icon-dark.svg         rounded square, white mark on near-black (1024px)
│   └── favicon.svg               favicon source, currentColor
│
├── png/                 — rasterized at common sizes for embedding/sharing
│   ├── mark-{16,24,32,48,64,128,256,512,1024}.png
│   ├── avatar-{light,dark}-512.png
│   ├── app-icon-{light,dark}-{180,192,256,512,1024}.png
│   ├── lockup-{horizontal,stacked}-2x.png
│   └── wordmark-2x.png
│
├── favicon/             — drop this directory into your web app's public/ root
│   ├── favicon-{light,dark}-{16,32,48,64,96,128,180,192,256,512}.{svg,png}
│   ├── favicon-{light,dark}.ico  multi-resolution (16/32/48)
│   ├── apple-touch-icon.{svg,png}    iOS home screen, 180×180
│   └── manifest.webmanifest          PWA manifest
│
├── social/              — Open Graph / Twitter share cards
│   ├── og-card-light.{svg,png}   1200×630
│   └── og-card-dark.{svg,png}    1200×630
│
├── html-snippet.html    — copy-paste <head> tags for favicons and OG tags
├── build.py             — regenerate everything from source
└── README.md            — this file
```

## Where to use what

| Context | Asset |
|---|---|
| Telegram bot avatar | `svg/avatar-dark.svg` (uploaded as 512×512 PNG: `png/avatar-dark-512.png`) |
| Telegram offer card / inline | The 🤝 emoji from chat *or* `png/mark-32.png` |
| GitHub repo icon | `png/app-icon-light-256.png` (or `-dark-256.png` for dark theme repos) |
| Mini App favicon | `favicon/` directory, served from web app `public/` |
| Mini App header | `svg/lockup-horizontal.svg` |
| Documentation / README hero | `svg/lockup-stacked.svg` |
| Twitter / X profile picture | `png/avatar-dark-512.png` |
| Twitter share image / OG | `social/og-card-light.png` |
| iOS home screen (PWA) | `favicon/apple-touch-icon.png` |
| Android home screen (PWA) | `favicon/favicon-light-192.png` (referenced via manifest) |
| Pitch deck title slide | `svg/lockup-stacked.svg` or `social/og-card-dark.svg` |

## Web integration

To wire up the favicons in a web app, copy `favicon/` into your `public/` (or equivalent static assets directory), then paste the contents of `html-snippet.html` into your HTML `<head>`. The snippet handles light/dark mode auto-switching, legacy browser fallbacks, iOS home screen, Android PWA, and Open Graph cards.

For Next.js (App Router): place files in `public/favicon/` and put the link tags in `app/layout.tsx`'s `<head>`. The same paths work without modification.

## Color

The pack ships in monochrome — pure black-on-white and white-on-near-black (`#0F0F12`). This is deliberate: a v1.0 protocol benefits from chromatic restraint, the asymmetric arcs carry the brand signal on their own, and monochrome scales better across the contexts a young protocol gets dropped into (other people's docs, headers, sponsor lists).

If you later want a signature color, the natural place to introduce it is the **thinner arc** — keep the thicker User Agent arc black (or the primary text color of the host context) and tint just the MM arc. This preserves the asymmetry-as-meaning relationship while adding chromatic identity. Don't tint both; that'd be a typical "blockchain logo" gradient and sacrifices the specificity.

## Geometry, for anyone editing the SVGs

The mark is parametric. In `build.py`, three values control everything:

- `radius = size * 0.34` — arc radius as fraction of canvas. Smaller = more padding around the mark.
- `gap_pct = 0.14` — gap between arcs as fraction of canvas. Smaller = arcs feel more "facing" / closed.
- `stroke_pct = 0.10` — thicker arc's stroke width as fraction of canvas. Sets overall weight.
- `weight_ratio` — thick:thin ratio. Tuned per size: 1.7 at hero scale, 1.5 at mid scale, 1.3 at favicon scale, so the thin arc stays visible at every size.

To regenerate after edits: `python3 build.py`. Cairo (libcairo2) and Python's `cairosvg` + `Pillow` are required.

## What's deliberately not in this pack

- **Animated variants.** The roadmap mentions a "deal happening" animation pattern (the gap closing or a notch appearing at the midpoint). Not built yet — out of scope for v1.0.
- **Color variants beyond monochrome.** See note above.
- **Vector EPS / AI files.** The SVGs are the source of truth; they convert losslessly to any vector format if needed.
- **Brand guidelines document.** This README captures the essentials. A formal brand guide can come later when the brand has more surface area to govern.

## License

The Parley logo and wordmark are project marks — use them to refer to and link to Parley, but don't use them to imply endorsement or affiliation that isn't there.

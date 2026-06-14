# Brandbook preview assets

These two SVGs illustrate the [brandbook](../README.md). They **mirror**
[`apps/docs/app/tokens.css`](../../../apps/docs/app/tokens.css) — when a token
changes, update them here too.

| File                                     | Shows                                                                |
| ---------------------------------------- | -------------------------------------------------------------------- |
| [`logo-preview.svg`](./logo-preview.svg) | The recolored lockup on the light and dark `--bg`                    |
| [`palette.svg`](./palette.svg)           | The Signal swatch set (brand / accent / surface / text), both themes |

## How the brand rasters are produced

The shipped PNGs — [`icon.png`](../../../apps/docs/app/icon.png),
[`apple-icon.png`](../../../apps/docs/app/apple-icon.png), and the banners
[`baner_light.png`](../../media/baner_light.png) /
[`baner_dark.png`](../../media/baner_dark.png) — are composed from the existing
vector parts and the Signal tokens, then rasterized. The recipe (so a future
token or mark change can be re-applied by hand):

**Colour mapping** (per theme, from `tokens.css`):

-   cloud arcs + the wordmark's "i"-dot → `--brand`
-   `</>` brackets + wordmark letters → `--text` (ink)
-   dashed "stitch" seam → `--accent` (amber) — **except** the favicon/app-icon,
    where the seam is `--text` (ink) for legibility at ≤32 px

**Sources:**

-   Lockup paths come from [`logo.svg`](../../../apps/docs/public/logo.svg); the
    icon mark is the cloud + brackets + seam subset of the same artwork on a
    rounded light tile (`--surface` → a touch darker).
-   The banner backdrop is the **ripple motif**, generated with the exact
    algorithm in
    [`brand-backdrop.tsx`](<../../../apps/docs/app/(home)/components/brand-backdrop.tsx>)
    (same `RINGS` radii / dash / opacity, `ringPath()` harmonics), stroked in
    `--brand`, centred and scaled to fill the 1692×564 frame, on a `--bg` gradient
    with rounded corners.

**Dimensions** (match the originals): `icon.png` 256², `apple-icon.png` 180²,
banners 1692×564 — all with a transparent area outside the rounded corners.

**Rasterize:** render each composed SVG with a headless Chromium at
`--force-device-scale-factor=1`, `--default-background-color=00000000`, and
`--window-size=<w>,<h>` to get pixel-exact, alpha-correct PNGs. (No npm
rasterizer is a repo dependency, so this is a local/manual step.)

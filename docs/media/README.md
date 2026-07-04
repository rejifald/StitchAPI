# docs/media

Brand and marketing assets. The `demo*` files are **generated,
not hand-recorded** — the scene is a real page of the docs app
([apps/docs/app/demo](../../apps/docs/app/demo)), built
on the site's own components/tokens. One loop cycles a chapter per core
feature (streaming, drift, shaping, resilience, caching, auth,
observability, request styles, composition, agent-native — see the scene's
`CHAPTERS`). Each asset renders in light and dark:

| asset                    | use                                             | tracked?   |
| ------------------------ | ----------------------------------------------- | ---------- |
| `demo[-dark].webp`       | embeds, 1x screens — marquee cut, 1280 lossless | ✅ in git  |
| `demo[-dark]@2x.webp`    | embeds, retina — marquee cut, 2560×1440         | ✅ in git  |
| `demo[-dark].mp4`        | full 10-chapter tour, 1280×720 — HN / PH / X    | regenerate |
| `demo[-dark]@2x.mp4`     | full tour, 2560×1440 retina                     | regenerate |
| `demo[-dark].gif`        | marquee cut — channels that only accept .gif    | regenerate |
| `demo-square[-dark].mp4` | 1:1 crop for social                             | regenerate |

**Only the embed webp pairs are committed** — everything else is
`.gitignore`d and one `pnpm gen:media` away, so git history doesn't grow
by ~8 MB per regeneration. Squash-merge branches that regenerate the
tracked pairs. A pre-push gate (`scripts/check-media-freshness.mjs`) fails
when the scene or generator changes without the committed pairs being
regenerated (`STITCH_MEDIA_STALE_OK=1` defers intentionally).

Regenerate after editing the scene:

```sh
pnpm gen:media
```

README embedding that follows the viewer's theme AND pixel density —
`srcset` density descriptors let the browser pick 1x or @2x, so
non-retina screens never download the 4×-pixel file:

```html
<picture>
    <source
        media="(prefers-color-scheme: dark)"
        srcset="docs/media/demo-dark.webp 1x, docs/media/demo-dark@2x.webp 2x"
    />
    <img
        src="docs/media/demo.webp"
        srcset="docs/media/demo.webp 1x, docs/media/demo@2x.webp 2x"
        width="1280"
        alt="StitchAPI demo — a stitch streaming, validating, retrying, and answering an agent"
    />
</picture>
```

On the docs site, use the
[`<DemoMedia />`](../../apps/docs/components/demo-media.tsx)
component instead — it follows the site's `.dark` class (a manual theme
toggle switches the asset, which `prefers-color-scheme` would miss) and
uses the same density `srcset`. The build copies the committed pairs into
`public/media` (`apps/docs/scripts/copy-demo-media.mjs`).

See [scripts/gen-demo.mjs](../../scripts/gen-demo.mjs)
for requirements (ffmpeg with libwebp + Playwright Chromium) and
mechanics. Outputs are visually reproducible from source; exact bytes vary
with the Chromium/ffmpeg doing the rendering, so regenerate on one
canonical machine per release. To preview the loop while editing, run the
docs dev server and open `/demo`.

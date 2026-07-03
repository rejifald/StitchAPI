# docs/media

Brand and marketing assets. The `streaming-demo*` files are **generated,
not hand-recorded** — the scene is a real page of the docs app
([apps/docs/app/demo/streaming](../../apps/docs/app/demo/streaming)), built
on the site's own components/tokens. One loop cycles a chapter per core
feature (streaming, drift, shaping, resilience, caching, auth,
observability, request styles, composition, agent-native — see the scene's
`CHAPTERS`). Each asset renders in light and dark:

| asset                              | use                                            | tracked?   |
| ---------------------------------- | ---------------------------------------------- | ---------- |
| `streaming-demo[-dark]@2x.webp`    | README embed — marquee cut, 2560×1440 lossless | ✅ in git  |
| `streaming-demo[-dark].mp4`        | full 10-chapter tour, 1280×720 — HN / PH / X   | regenerate |
| `streaming-demo[-dark]@2x.mp4`     | full tour, 2560×1440 retina                    | regenerate |
| `streaming-demo[-dark].gif`        | marquee cut — channels that only accept .gif   | regenerate |
| `streaming-demo-square[-dark].mp4` | 1:1 crop for social                            | regenerate |

**Only the README webp pair is committed** — everything else is
`.gitignore`d and one `pnpm gen:media` away, so git history doesn't grow
by ~8 MB per regeneration. Squash-merge branches that regenerate the
tracked pair. A pre-push gate (`scripts/check-media-freshness.mjs`) fails
when the scene or generator changes without the committed pair being
regenerated (`STITCH_MEDIA_STALE_OK=1` defers intentionally).

Regenerate after editing the scene:

```sh
pnpm gen:media
```

README embedding that follows the viewer's theme — the files are 2× so a
`width` of half their pixel size renders retina-crisp:

```html
<picture>
    <source
        media="(prefers-color-scheme: dark)"
        srcset="docs/media/streaming-demo-dark@2x.webp"
    />
    <img
        src="docs/media/streaming-demo@2x.webp"
        width="1280"
        alt="StitchAPI demo — a stitch streaming, validating, retrying, and answering an agent"
    />
</picture>
```

See [scripts/gen-streaming-demo.mjs](../../scripts/gen-streaming-demo.mjs)
for requirements (ffmpeg with libwebp + Playwright Chromium) and
mechanics. Outputs are visually reproducible from source; exact bytes vary
with the Chromium/ffmpeg doing the rendering, so regenerate on one
canonical machine per release. To preview the loop while editing, run the
docs dev server and open `/demo/streaming`.

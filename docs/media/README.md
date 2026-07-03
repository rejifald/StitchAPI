# docs/media

Brand and marketing assets. The `streaming-demo*` files are **generated,
not hand-recorded** — the scene is a real page of the docs app
([apps/docs/app/demo/streaming](../../apps/docs/app/demo/streaming)), built
on the site's own components/tokens. One loop cycles four chapters, one per
key feature: streaming-first, validation + drift, resilience, agent-native.
Each asset ships in light and dark:

| asset                              | use                                     |
| ---------------------------------- | --------------------------------------- |
| `streaming-demo[-dark].mp4`        | 1280×720 hero — HN / PH / X             |
| `streaming-demo[-dark].webp`       | README embed (24-bit color, small)      |
| `streaming-demo[-dark].gif`        | channels that require actual .gif files |
| `streaming-demo-square[-dark].mp4` | 1:1 crop for social                     |

Regenerate after editing the scene:

```sh
pnpm gen:media
```

README embedding that follows the viewer's theme (GitHub supports both
`<picture>` media queries and animated WebP):

```html
<picture>
    <source
        media="(prefers-color-scheme: dark)"
        srcset="docs/media/streaming-demo-dark.webp"
    />
    <img src="docs/media/streaming-demo.webp" alt="StitchAPI streaming demo" />
</picture>
```

See [scripts/gen-streaming-demo.mjs](../../scripts/gen-streaming-demo.mjs)
for requirements (ffmpeg + Playwright Chromium) and mechanics. To preview
the loop while editing, run the docs dev server and open `/demo/streaming`.

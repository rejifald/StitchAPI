# docs/media

Brand and marketing assets. The `streaming-demo.*` files (hero mp4 + GIF +
1:1 square mp4) are **generated, not hand-recorded** — the scene is a real
page of the docs app ([apps/docs/app/demo/streaming](../../apps/docs/app/demo/streaming)),
built on the site's own components/tokens and rendered deterministically.
Regenerate after editing the scene:

```sh
pnpm gen:media
```

See [scripts/gen-streaming-demo.mjs](../../scripts/gen-streaming-demo.mjs)
for requirements (ffmpeg + Playwright Chromium) and mechanics. To preview
the loop while editing, run the docs dev server and open `/demo/streaming`.

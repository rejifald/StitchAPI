# Hero demo — generated from source

`docs/media/streaming-demo.{mp4,gif}` and `streaming-demo-square.mp4` are not
hand-recorded: they are rendered from [streaming-demo.html](streaming-demo.html),
a deterministic scene where every frame is a pure function of time
(`window.__seek(t)` — no timers, no randomness). To regenerate after editing the
scene:

```sh
pnpm gen:media
```

The script ([scripts/gen-streaming-demo.mjs](../../../scripts/gen-streaming-demo.mjs))
frame-steps the scene in headless Chromium at 30 fps / 2x DPR and assembles the
frames with ffmpeg (mp4 via libx264, GIF via two-pass palette, auto-stepped down
until it fits the < 2.5 MB budget). Requirements: `ffmpeg` on PATH and the
Playwright Chromium binary (`pnpm --filter @stitchapi/docs exec playwright
install chromium`).

To preview the scene while editing, open the HTML file in a browser and drive it
from the console, e.g. `__seek(3.2)`. The on-screen snippet is real StitchAPI
usage — it mirrors the `useStitchStream` JSDoc example in
`packages/react/src/index.ts`; if that API changes, update the snippet and
regenerate.

import { StreamingScene } from './scene';

import type { Metadata } from 'next';

/**
 * Capture fixture for the hero streaming-demo assets
 * (`docs/media/streaming-demo.{mp4,gif}`), built on the site's own
 * components and tokens so the recording always matches the live brand.
 * `scripts/gen-streaming-demo.mjs` boots this app, frame-steps the scene
 * through `window.__seek(t)`, and assembles the video/GIF with ffmpeg —
 * see the scene component for the mechanics. Not linked from anywhere
 * and noindexed; it renders fine in a browser if you want to preview the
 * loop while editing.
 */
export const metadata: Metadata = {
    title: 'Streaming demo',
    robots: { index: false, follow: false },
};

export default function Page() {
    return <StreamingScene />;
}

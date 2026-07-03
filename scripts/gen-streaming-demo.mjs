#!/usr/bin/env node

/**
 * Regenerates the hero demo assets from source (`pnpm gen:media`):
 *
 *   docs/media/streaming-demo.mp4         1280x720 hero (README/HN/PH/X)
 *   docs/media/streaming-demo.gif         1280-wide fallback, kept < 2.5 MB
 *   docs/media/streaming-demo-square.mp4  1080x1080 crop for social
 *
 * How: docs/media/demo/streaming-demo.html is a deterministic scene —
 * every frame is a pure function of time via window.__seek(t). This
 * script frame-steps it in headless Chromium at 30 fps (2x DPR for crisp
 * text), then assembles the frames with ffmpeg. Same source → same
 * bytes-on-screen, so the assets are fully reproducible.
 *
 * Needs: ffmpeg on PATH; Playwright browsers installed (the workspace
 * already depends on @playwright/test via apps/docs — run
 * `pnpm --filter @stitchapi/docs exec playwright install chromium` once
 * if the browser binary is missing).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sceneUrl = pathToFileURL(
    join(root, 'docs/media/demo/streaming-demo.html'),
);
const outDir = join(root, 'docs/media');

// Playwright is a workspace dep of apps/docs — resolve it from there so
// the root package.json stays clean.
const require = createRequire(join(root, 'apps/docs/package.json'));
const { chromium } = require('@playwright/test');

const FPS = 30;
const GIF_MAX_BYTES = 2.5 * 1024 * 1024;

const ffmpeg = (args) =>
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], {
        stdio: ['ignore', 'inherit', 'inherit'],
    });

async function captureFrames(page, url, dir) {
    await page.goto(url.href);
    await page.waitForFunction(() => typeof window.__seek === 'function');
    const total = await page.evaluate(() => window.__TOTAL);
    const frames = Math.round(total * FPS);
    for (let i = 0; i < frames; i++) {
        await page.evaluate((t) => window.__seek(t), i / FPS);
        await page.screenshot({
            path: join(dir, `f${String(i).padStart(4, '0')}.png`),
        });
        if (i % FPS === 0) console.log(`  frame ${i}/${frames}`);
    }
    return frames;
}

function encodeMp4(framesDir, out, size) {
    ffmpeg([
        '-y',
        '-framerate',
        String(FPS),
        '-i',
        join(framesDir, 'f%04d.png'),
        '-vf',
        `scale=${size}:flags=lanczos`,
        '-c:v',
        'libx264',
        '-preset',
        'slow',
        '-crf',
        '18',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        out,
    ]);
    console.log(`  ${out} (${(statSync(out).size / 1024).toFixed(0)} KB)`);
}

// Try progressively cheaper settings until the GIF fits the size budget.
function encodeGif(framesDir, out, work) {
    const ladder = [
        { width: 1280, fps: 15, colors: 160 },
        { width: 1280, fps: 12, colors: 128 },
        { width: 1120, fps: 12, colors: 128 },
        { width: 960, fps: 12, colors: 128 },
    ];
    for (const { width, fps, colors } of ladder) {
        const palette = join(work, 'palette.png');
        const filters = `fps=${fps},scale=${width}:-2:flags=lanczos`;
        ffmpeg([
            '-y',
            '-framerate',
            String(FPS),
            '-i',
            join(framesDir, 'f%04d.png'),
            '-vf',
            `${filters},palettegen=max_colors=${colors}:stats_mode=diff`,
            palette,
        ]);
        ffmpeg([
            '-y',
            '-framerate',
            String(FPS),
            '-i',
            join(framesDir, 'f%04d.png'),
            '-i',
            palette,
            '-lavfi',
            `${filters} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
            '-loop',
            '0',
            out,
        ]);
        const kb = statSync(out).size / 1024;
        console.log(
            `  gif @ ${width}px/${fps}fps/${colors}c → ${kb.toFixed(0)} KB`,
        );
        if (statSync(out).size <= GIF_MAX_BYTES) return;
    }
    throw new Error(`GIF exceeds ${GIF_MAX_BYTES} bytes at every ladder step`);
}

const work = mkdtempSync(join(tmpdir(), 'stitch-demo-'));
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
try {
    // ── 1280x720 hero (mp4 + gif) ──────────────────────────────────
    console.log('capturing 1280x720 scene…');
    const wideDir = join(work, 'wide');
    mkdirSync(wideDir);
    const wide = await browser.newPage({
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 2,
    });
    await captureFrames(wide, sceneUrl, wideDir);
    encodeMp4(wideDir, join(outDir, 'streaming-demo.mp4'), '1280:720');
    encodeGif(wideDir, join(outDir, 'streaming-demo.gif'), work);

    // ── 1080x1080 square crop for social (mp4) ─────────────────────
    console.log('capturing 1080x1080 scene…');
    const squareDir = join(work, 'square');
    mkdirSync(squareDir);
    const square = await browser.newPage({
        viewport: { width: 1080, height: 1080 },
        deviceScaleFactor: 2,
    });
    const squareUrl = new URL(sceneUrl);
    squareUrl.searchParams.set('layout', 'square');
    await captureFrames(square, squareUrl, squareDir);
    encodeMp4(
        squareDir,
        join(outDir, 'streaming-demo-square.mp4'),
        '1080:1080',
    );
} finally {
    await browser.close();
    rmSync(work, { recursive: true, force: true });
}
console.log('done.');

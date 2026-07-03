#!/usr/bin/env node

/**
 * Regenerates the hero demo assets from source (`pnpm gen:media`), in
 * light AND dark (README `<picture>` can serve the matching one):
 *
 *   docs/media/streaming-demo[-dark].mp4         1280x720 hero
 *   docs/media/streaming-demo[-dark].gif         1280-wide, < 2.5 MB each
 *   docs/media/streaming-demo-square[-dark].mp4  1080x1080 for social
 *
 * How: the scene is a real page of the docs app —
 * apps/docs/app/demo/streaming — built on the site's own components and
 * tokens, and deterministic: every frame is a pure function of time via
 * window.__seek(t). This script boots the docs dev server, frame-steps
 * the page in headless Chromium at 30 fps (2x DPR for crisp text), then
 * assembles the frames with ffmpeg. Same source → same bytes-on-screen,
 * so the assets are fully reproducible.
 *
 * Needs: ffmpeg on PATH; Playwright browsers installed (the workspace
 * already depends on @playwright/test via apps/docs — run
 * `pnpm --filter @stitchapi/docs exec playwright install chromium` once
 * if the browser binary is missing).
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'docs/media');

// Playwright is a workspace dep of apps/docs — resolve it from there so
// the root package.json stays clean.
const require = createRequire(join(root, 'apps/docs/package.json'));
const { chromium } = require('@playwright/test');

const FPS = 30;
const GIF_MAX_BYTES = 2.5 * 1024 * 1024;
// Dedicated port so we never capture some other checkout's dev server.
const PORT = 3947;
const PAGE = `http://localhost:${PORT}/demo/streaming?capture=1`;

const ffmpeg = (args) =>
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], {
        stdio: ['ignore', 'inherit', 'inherit'],
    });

const reachable = (url) =>
    fetch(url, { signal: AbortSignal.timeout(2_000) }).then(
        () => true,
        () => false,
    );

async function startDocsServer() {
    if (await reachable(`http://localhost:${PORT}/`)) {
        throw new Error(
            `Port ${PORT} is already serving something. Stop it first — ` +
                `reusing an unknown server risks capturing another checkout's code.`,
        );
    }
    const server = spawn(
        'pnpm',
        ['--filter', '@stitchapi/docs', 'dev', '-p', String(PORT)],
        { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    server.stdout.on('data', (d) => (output += d));
    server.stderr.on('data', (d) => (output += d));

    // Covers build:typed-deps + build:sandbox + next startup + the first
    // on-demand compile of the route (polling the page itself triggers it).
    const deadline = Date.now() + 300_000;
    process.stdout.write('starting docs dev server');
    while (Date.now() < deadline) {
        if (server.exitCode !== null) {
            throw new Error(`docs dev server exited early:\n${output}`);
        }
        if (
            await fetch(PAGE, { signal: AbortSignal.timeout(30_000) }).then(
                (r) => r.ok,
                () => false,
            )
        ) {
            console.log(' — ready');
            return server;
        }
        process.stdout.write('.');
        await new Promise((r) => setTimeout(r, 2_000));
    }
    throw new Error(`docs dev server not ready after 300s:\n${output}`);
}

const stopServer = (server) => {
    // pnpm → next is a process tree; detached spawn gave it its own group.
    try {
        process.kill(-server.pid, 'SIGTERM');
    } catch {
        /* already gone */
    }
};

async function captureFrames(browser, { width, height, url, dir, theme }) {
    const page = await browser.newPage({
        viewport: { width, height },
        deviceScaleFactor: 2,
        colorScheme: theme,
    });
    await page.goto(url);
    await page.waitForFunction(() => typeof window.__seek === 'function');
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const total = await page.evaluate(() => window.__TOTAL);
    const frames = Math.round(total * FPS);
    for (let i = 0; i < frames; i++) {
        await page.evaluate((t) => window.__seek(t), i / FPS);
        await page.screenshot({
            path: join(dir, `f${String(i).padStart(4, '0')}.png`),
        });
        if (i % FPS === 0) console.log(`  frame ${i}/${frames}`);
    }
    await page.close();
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

// theme × layout matrix: wide gets mp4 + gif, square gets mp4 only.
const VARIANTS = [
    { name: 'streaming-demo', theme: 'light', square: false, gif: true },
    { name: 'streaming-demo-dark', theme: 'dark', square: false, gif: true },
    { name: 'streaming-demo-square', theme: 'light', square: true, gif: false },
    {
        name: 'streaming-demo-square-dark',
        theme: 'dark',
        square: true,
        gif: false,
    },
];

const work = mkdtempSync(join(tmpdir(), 'stitch-demo-'));
mkdirSync(outDir, { recursive: true });
const server = await startDocsServer();
const browser = await chromium.launch();
try {
    for (const { name, theme, square, gif } of VARIANTS) {
        const size = square ? '1080:1080' : '1280:720';
        console.log(`capturing ${name} (${size.replace(':', 'x')} ${theme})…`);
        const dir = join(work, name);
        mkdirSync(dir);
        await captureFrames(browser, {
            width: square ? 1080 : 1280,
            height: square ? 1080 : 720,
            url: square ? `${PAGE}&layout=square` : PAGE,
            dir,
            theme,
        });
        encodeMp4(dir, join(outDir, `${name}.mp4`), size);
        if (gif) encodeGif(dir, join(outDir, `${name}.gif`), work);
        rmSync(dir, { recursive: true, force: true }); // free frame disk early
    }
} finally {
    await browser.close();
    stopServer(server);
    rmSync(work, { recursive: true, force: true });
}
console.log('done.');

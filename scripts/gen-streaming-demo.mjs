#!/usr/bin/env node

/**
 * Regenerates the hero demo assets from source (`pnpm gen:media`), in
 * light AND dark. Only the README-embedded webp pair is committed —
 * everything else is a launch asset, regenerated on demand (gitignored;
 * see docs/media/README.md):
 *
 *   docs/media/streaming-demo[-dark]@2x.webp   README embed — marquee
 *       cut, 2560x1440 lossless (COMMITTED; render at width=1280 for
 *       retina crispness)
 *   docs/media/streaming-demo[-dark][@2x].mp4  full tour, 1x + 2x
 *   docs/media/streaming-demo[-dark].gif       marquee cut, < 2.5 MB —
 *       channels that only accept .gif uploads
 *   docs/media/streaming-demo-square[-dark].mp4  1080x1080 for social
 *
 * How: the scene is a real page of the docs app —
 * apps/docs/app/demo/streaming — built on the site's own components and
 * tokens, and deterministic: every frame is a pure function of time via
 * window.__seek(t). This script boots the docs dev server, frame-steps
 * the page in headless Chromium at 30 fps (2x DPR for crisp text), then
 * assembles the frames with ffmpeg. Outputs are visually reproducible
 * from source (exact bytes vary with the Chromium/ffmpeg versions doing
 * the rendering — regenerate on one canonical machine per release).
 *
 * All encodes land in a temp dir and only replace docs/media when every
 * variant succeeded, so a failed run never leaves a mixed asset set.
 *
 * Needs: ffmpeg (with libwebp) on PATH; Playwright browsers installed
 * (the workspace already depends on @playwright/test via apps/docs — run
 * `pnpm --filter @stitchapi/docs exec playwright install chromium` once
 * if the browser binary is missing).
 */
import { execFileSync, spawn } from 'node:child_process';
import {
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    rmSync,
    statSync,
} from 'node:fs';
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

// Fail fast on missing tooling — before the multi-minute server boot
// and capture. The webp encoder is probed too, so an ffmpeg built
// without libwebp doesn't surface mid-run.
function preflight() {
    try {
        execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    } catch {
        throw new Error(
            'ffmpeg is required on PATH — brew install ffmpeg (with libwebp).',
        );
    }
    const encoders = execFileSync('ffmpeg', ['-hide_banner', '-encoders'], {
        encoding: 'utf8',
    });
    if (!encoders.includes('libwebp_anim')) {
        throw new Error(
            'This ffmpeg lacks libwebp_anim — reinstall ffmpeg with libwebp.',
        );
    }
}

const ffmpeg = (args) =>
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], {
        stdio: ['ignore', 'inherit', 'inherit'],
    });

const reachable = (url) =>
    fetch(url, { signal: AbortSignal.timeout(2_000) }).then(
        () => true,
        () => false,
    );

const stopServer = (server) => {
    // pnpm → next is a process tree; detached spawn gave it its own group.
    try {
        process.kill(-server.pid, 'SIGTERM');
    } catch {
        /* already gone */
    }
};

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
    stopServer(server); // don't orphan the process group on timeout
    throw new Error(`docs dev server not ready after 300s:\n${output}`);
}

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

// size = 'W:H' to downscale, or null to keep the native 2x capture size
// (the @2x retina exports). crf 14 is visually lossless for this content.
function encodeMp4(framesDir, out, size) {
    ffmpeg([
        '-y',
        '-framerate',
        String(FPS),
        '-i',
        join(framesDir, 'f%04d.png'),
        ...(size ? ['-vf', `scale=${size}:flags=lanczos`] : []),
        '-c:v',
        'libx264',
        '-preset',
        'slow',
        '-crf',
        '14',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        out,
    ]);
    console.log(`  ${out} (${(statSync(out).size / 1024).toFixed(0)} KB)`);
}

// Animated WebP, LOSSLESS — the README-preferred embed. Counter-
// intuitively, lossless beats high-quality lossy here (flat UI, sharp
// edges: prediction wins, DCT loses) — measured 5.9 MB lossless vs
// 7.9 MB q95 at 2x. width = px to downscale to, or null for native 2x.
function encodeWebp(framesDir, out, width) {
    ffmpeg([
        '-y',
        '-framerate',
        String(FPS),
        '-i',
        join(framesDir, 'f%04d.png'),
        '-vf',
        `fps=15${width ? `,scale=${width}:-2:flags=lanczos` : ''}`,
        '-c:v',
        'libwebp_anim',
        '-lossless',
        '1',
        '-compression_level',
        '6',
        '-loop',
        '0',
        out,
    ]);
    console.log(`  ${out} (${(statSync(out).size / 1024).toFixed(0)} KB)`);
}

// Try progressively cheaper settings until the GIF fits the size budget.
// dither=none + full-frame updates: measured both SMALLER and cleaner
// than bayer + diff_mode=rectangle (dither noise fights LZW and left
// ghosting-like patchiness on the crossfades).
function encodeGif(framesDir, out, work) {
    const ladder = [
        { width: 1280, fps: 15, colors: 256 },
        { width: 1280, fps: 12, colors: 192 },
        { width: 1120, fps: 12, colors: 160 },
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
            `${filters} [x]; [x][1:v] paletteuse=dither=none`,
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

// The full tour ships as mp4 (1x + @2x retina); the README embed is the
// shorter MARQUEE cut (?chapters=) as lossless @2x webp, and the GIF is
// the same cut so it stays under its 2.5 MB budget as chapters grow.
const MARQUEE = 'stream,drift,resilience,agent';

// theme × layout × cut matrix. formats: mp4 | mp4@2x | webp@2x | gif.
const VARIANTS = [
    { name: 'streaming-demo', theme: 'light', formats: ['mp4', 'mp4@2x'] },
    { name: 'streaming-demo-dark', theme: 'dark', formats: ['mp4', 'mp4@2x'] },
    {
        name: 'streaming-demo',
        theme: 'light',
        formats: ['webp@2x', 'gif'],
        chapters: MARQUEE,
    },
    {
        name: 'streaming-demo-dark',
        theme: 'dark',
        formats: ['webp@2x', 'gif'],
        chapters: MARQUEE,
    },
    {
        name: 'streaming-demo-square',
        theme: 'light',
        square: true,
        formats: ['mp4'],
    },
    {
        name: 'streaming-demo-square-dark',
        theme: 'dark',
        square: true,
        formats: ['mp4'],
    },
];

preflight();
const work = mkdtempSync(join(tmpdir(), 'stitch-demo-'));
// Everything encodes here first; docs/media is only touched at the end,
// after every variant succeeded.
const staging = join(work, 'out');
mkdirSync(staging);
mkdirSync(outDir, { recursive: true });

const server = await startDocsServer();
let browser;
const shutdown = () => {
    stopServer(server);
    process.exit(130);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
try {
    browser = await chromium.launch();
    for (const [i, variant] of VARIANTS.entries()) {
        const { name, theme, square, formats, chapters } = variant;
        const size = square ? '1080:1080' : '1280:720';
        const cut = chapters ? ` cut=${chapters}` : '';
        console.log(
            `capturing ${name} → ${formats.join('+')} (${size.replace(':', 'x')} ${theme}${cut})…`,
        );
        const dir = join(work, `v${i}`);
        mkdirSync(dir);
        let url = square ? `${PAGE}&layout=square` : PAGE;
        if (chapters) url += `&chapters=${chapters}`;
        await captureFrames(browser, {
            width: square ? 1080 : 1280,
            height: square ? 1080 : 720,
            url,
            dir,
            theme,
        });
        if (formats.includes('mp4'))
            encodeMp4(dir, join(staging, `${name}.mp4`), size);
        if (formats.includes('mp4@2x'))
            encodeMp4(dir, join(staging, `${name}@2x.mp4`), null);
        if (formats.includes('webp@2x'))
            encodeWebp(dir, join(staging, `${name}@2x.webp`), null);
        if (formats.includes('gif'))
            encodeGif(dir, join(staging, `${name}.gif`), work);
        rmSync(dir, { recursive: true, force: true }); // free frame disk early
    }
    // publish: every variant succeeded — replace the tracked set atomically-ish
    for (const file of readdirSync(staging)) {
        copyFileSync(join(staging, file), join(outDir, file));
    }
    console.log(`published ${readdirSync(staging).length} files to docs/media`);
} finally {
    if (browser) await browser.close();
    stopServer(server);
    rmSync(work, { recursive: true, force: true });
}
console.log('done.');

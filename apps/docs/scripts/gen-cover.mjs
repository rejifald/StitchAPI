// StitchAPI article-cover generator — a local (macOS) authoring helper.
//
// Renders a 1200×630 cover PNG for a blog / dou.ua article, on-brand: the real
// vector logo (public/logo.svg) recolored to the theme, the brand "ripple" motif
// (imperfect concentric contours — mirrors app/(home)/components/brand-backdrop.tsx),
// a colour-split title, and the footer. Text is set in a Cyrillic-capable system
// font, so this is a macOS-first authoring tool, not a CI/build step.
//
// Usage (from apps/docs):
//   pnpm gen:cover -- --out <file.png> [--theme dark|light]
//                     [--kicker "<blue hook line>"] [--headline "<main message>"]
// Fonts default to the macOS system Arial; override the folder with COVER_FONT_DIR
// (it must contain "Arial.ttf" + "Arial Bold.ttf", or any Cyrillic-capable pair
// renamed to those — Satori needs .ttf/.otf, not .ttc).
import { ImageResponse } from 'next/og';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---- args ---------------------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (name, def) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const out = arg('out', null);
const theme = arg('theme', 'dark') === 'light' ? 'light' : 'dark';
const kicker = arg('kicker', 'На пенсію api.ts');
const headline = arg('headline', 'Викликай будь-який API як локальну функцію');
if (!out) {
    console.error(
        'usage: pnpm gen:cover -- --out <file.png> [--theme dark|light] [--kicker "…"] [--headline "…"]',
    );
    process.exit(1);
}

// ---- Signal palette per theme (mirrors apps/docs/app/tokens.css) --------------
const P =
    theme === 'light'
        ? {
              bg: '#fbfbfd',
              text: '#0c1019',
              brand: '#1d4fd0', // brand-strong — darker text for contrast on near-white
              faint: '#58616f', // text-muted (not text-faint) — readable footer grey
              ripple: '#2563eb',
              glow: 'radial-gradient(1200px 680px at 72% 35%, #eef2fb 0%, #fbfbfd 58%)',
              // logo keeps its native light palette
              logo: {
                  st0: '#0C1019',
                  st1: '#2563EB',
                  st2: '#2563EB',
                  st3: '#B4690A',
              },
          }
        : {
              bg: '#0a0d13',
              text: '#e9edf4',
              brand: '#4c8dff',
              faint: '#98a2b3', // text-muted — brighter footer grey for contrast on dark
              ripple: '#4c8dff',
              glow: 'radial-gradient(1200px 680px at 72% 35%, #111b2e 0%, #0a0d13 58%)',
              // logo recolored to the dark palette
              logo: {
                  st0: '#e9edf4',
                  st1: '#4c8dff',
                  st2: '#4c8dff',
                  st3: '#f6a823',
              },
          };

// ---- real logo (public/logo.svg) → theme palette, tight viewBox ---------------
// The source <style> block is deliberately left alone: every `class="stN"` is
// rewritten to an explicit fill below, so its rules bind to nothing and Satori
// ignores them. Both covers render byte-identical with or without it — don't
// re-add a regex strip, it only trips CodeQL's tag-sanitization rule.
const logoSvg = readFileSync(resolve(HERE, '..', 'public', 'logo.svg'), 'utf8')
    .replace('viewBox="0 0 1600 1200"', 'viewBox="560 548 484 112"')
    .replaceAll('class="st0"', `fill="${P.logo.st0}"`)
    .replaceAll('class="st1"', `fill="${P.logo.st1}"`)
    .replaceAll('class="st2"', `fill="${P.logo.st2}"`)
    .replaceAll('class="st3"', `fill="${P.logo.st3}"`);
const logo = `data:image/svg+xml;base64,${Buffer.from(logoSvg).toString('base64')}`;

// ---- brand "ripple" motif — imperfect concentric contours ---------------------
const CENTER = 500;
const SAMPLES = 80;
const RIPPLE_ALPHA = 1.5; // ripple visibility multiplier (× each ring's base opacity)
const RINGS = [
    { r: 58, o: 0.4, dash: '1 8' },
    { r: 108, o: 0.36, dash: '2 9' },
    { r: 160, o: 0.32, dash: '1 7' },
    { r: 214, o: 0.28, dash: '3 11' },
    { r: 270, o: 0.24, dash: '1 9' },
    { r: 328, o: 0.2, dash: '2 12' },
    { r: 388, o: 0.16, dash: '1 8' },
    { r: 450, o: 0.13, dash: '4 14' },
    { r: 514, o: 0.1, dash: '1 11' },
    { r: 580, o: 0.07, dash: '2 13' },
];
const f2 = (v) => Math.round(v * 100) / 100;
const smoothClosedPath = (points) => {
    const n = points.length;
    let d = `M ${f2(points[0][0])} ${f2(points[0][1])}`;
    for (let i = 0; i < n; i++) {
        const p0 = points[(i - 1 + n) % n];
        const p1 = points[i];
        const p2 = points[(i + 1) % n];
        const p3 = points[(i + 2) % n];
        const c1x = p1[0] + (p2[0] - p0[0]) / 6;
        const c1y = p1[1] + (p2[1] - p0[1]) / 6;
        const c2x = p2[0] - (p3[0] - p1[0]) / 6;
        const c2y = p2[1] - (p3[1] - p1[1]) / 6;
        d += ` C ${f2(c1x)} ${f2(c1y)} ${f2(c2x)} ${f2(c2y)} ${f2(p2[0])} ${f2(p2[1])}`;
    }
    return `${d} Z`;
};
const ringPath = (baseR, i) => {
    const amp = 0.02 + i * 0.006;
    const pts = [];
    for (let k = 0; k < SAMPLES; k++) {
        const a = (k / SAMPLES) * Math.PI * 2;
        const wobble =
            Math.sin(a + i * 0.9 + 0.6) * amp +
            Math.sin(a * 2 + i * 1.7 + 1.2) * amp * 0.7 +
            Math.sin(a * 3 + i * 0.5 + 0.3) * amp * 0.45 +
            Math.sin(a * 5 + i * 2.3) * amp * 0.2;
        const r = baseR * (1 + wobble);
        pts.push([CENTER + r * Math.cos(a), CENTER + r * 0.88 * Math.sin(a)]);
    }
    return smoothClosedPath(pts);
};
const ripplePaths = RINGS.map(
    (ring, i) =>
        `<path d="${ringPath(ring.r, i)}" fill="none" stroke="${P.ripple}" stroke-width="1.6" stroke-opacity="${f2(ring.o * RIPPLE_ALPHA)}" stroke-dasharray="${ring.dash}" stroke-linecap="round"/>`,
).join('');
const rippleSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">${ripplePaths}</svg>`;
const ripple = `data:image/svg+xml;base64,${Buffer.from(rippleSvg).toString('base64')}`;

// ---- fonts (system, Cyrillic-capable) -----------------------------------------
const FDIR = process.env.COVER_FONT_DIR || '/System/Library/Fonts/Supplemental';
for (const file of ['Arial.ttf', 'Arial Bold.ttf']) {
    if (!existsSync(resolve(FDIR, file))) {
        console.error(
            `missing font: ${resolve(FDIR, file)}\nset COVER_FONT_DIR to a folder with "Arial.ttf" + "Arial Bold.ttf" (Cyrillic-capable, .ttf/.otf).`,
        );
        process.exit(1);
    }
}
const arial = readFileSync(resolve(FDIR, 'Arial.ttf'));
const arialBold = readFileSync(resolve(FDIR, 'Arial Bold.ttf'));

// ---- compose (plain element tree — no JSX) ------------------------------------
const div = (style, children) => ({
    type: 'div',
    props: { style: { display: 'flex', ...style }, children },
});

const el = div(
    {
        position: 'relative',
        width: '100%',
        height: '100%',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '76px',
        backgroundColor: P.bg,
        backgroundImage: P.glow,
        fontFamily: 'Arial',
        color: P.text,
    },
    [
        {
            type: 'img',
            props: {
                src: ripple,
                width: 1040,
                height: 1040,
                style: { position: 'absolute', top: -205, left: 360 },
            },
        },
        { type: 'img', props: { src: logo, width: 286, height: 66 } },
        // colour-split title (echoes the full article title)
        div({ flexDirection: 'column' }, [
            div(
                {
                    fontSize: 56,
                    fontWeight: 700,
                    lineHeight: 1.1,
                    color: P.brand,
                },
                kicker,
            ),
            div(
                {
                    fontSize: 56,
                    fontWeight: 700,
                    lineHeight: 1.1,
                    marginTop: 10,
                    maxWidth: 1010,
                },
                headline,
            ),
        ]),
        // footer — per-token elements with a uniform gap so the "·" separators
        // have equal space on both sides
        div({ alignItems: 'center', fontSize: 24 }, [
            div({ color: P.brand, fontWeight: 700 }, 'stitchapi.dev'),
            div({ color: P.faint, marginLeft: 12 }, '·'),
            div({ color: P.faint, marginLeft: 12 }, 'Apache-2.0'),
            div({ color: P.faint, marginLeft: 12 }, '·'),
            div({ color: P.faint, marginLeft: 12 }, 'нуль залежностей'),
        ]),
    ],
);

const res = new ImageResponse(el, {
    width: 1200,
    height: 630,
    fonts: [
        { name: 'Arial', data: arial, weight: 400, style: 'normal' },
        { name: 'Arial', data: arialBold, weight: 700, style: 'normal' },
    ],
});

writeFileSync(out, Buffer.from(await res.arrayBuffer()));
console.log(`WROTE ${theme} cover → ${out}`);

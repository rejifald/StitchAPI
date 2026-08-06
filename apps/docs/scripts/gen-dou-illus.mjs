// Generator for the DOU illustration of the missing-layer article: the
// before → after mapping (hand-rolled artifact → the declaration field it
// collapses into). Run from apps/docs:  node --import tsx/esm scripts/gen-dou-illus.mjs
// Light theme (DOU pages are white), Ukrainian labels, no product logo (DOU rule).
import { ImageResponse } from 'next/og';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '..', 'content', 'drafts');

const FDIR = process.env.COVER_FONT_DIR || '/System/Library/Fonts/Supplemental';
for (const file of ['Arial.ttf', 'Arial Bold.ttf', 'Courier New.ttf']) {
    if (!existsSync(resolve(FDIR, file))) {
        console.error(`missing font: ${resolve(FDIR, file)}`);
        process.exit(1);
    }
}
const arial = readFileSync(resolve(FDIR, 'Arial.ttf'));
const arialBold = readFileSync(resolve(FDIR, 'Arial Bold.ttf'));
const courier = readFileSync(resolve(FDIR, 'Courier New.ttf'));
const FONTS = [
    { name: 'Arial', data: arial, weight: 400, style: 'normal' },
    { name: 'Arial', data: arialBold, weight: 700, style: 'normal' },
    { name: 'Mono', data: courier, weight: 400, style: 'normal' },
];

// Signal palette, light theme (mirrors apps/docs/app/tokens.css)
const P = {
    bg: '#fbfbfd',
    text: '#0c1019',
    muted: '#58616f',
    brand: '#1d4fd0',
    brandBg: '#eef2fb',
    warn: '#b4690a',
    line: '#e3e7ef',
};

const div = (style, children) => ({
    type: 'div',
    props: { style: { display: 'flex', ...style }, children },
});
const txt = (style, s) => div({ ...style }, s);

// Each hand-rolled artifact and the declaration field it collapses into.
// The last row is the punchline: the TODO maps to nothing.
const PAIRS = [
    ['utils/retry.ts', 'retry: 3'],
    ['sleep(200)', "throttle: '10/s'"],
    ['new AbortController()', "timeout: '10s'"],
    ['as User[]', 'output: drift(User)'],
    ['auth/refreshToken.ts', 'auth: bearer(env(…))'],
    ['// TODO: причесати', null],
];

const leftChip = (s) =>
    txt(
        {
            fontSize: 26,
            fontFamily: 'Mono',
            color: P.text,
            backgroundColor: '#ffffff',
            border: `2px solid ${P.line}`,
            borderRadius: 12,
            padding: '12px 20px',
        },
        s,
    );

const rightChip = (s) =>
    txt(
        {
            fontSize: 26,
            fontFamily: 'Mono',
            color: P.brand,
            backgroundColor: P.brandBg,
            borderRadius: 12,
            padding: '12px 20px',
        },
        s,
    );

const row = ([from, to]) =>
    div({ alignItems: 'center', marginTop: 14 }, [
        div({ flex: 1, justifyContent: 'flex-end' }, [leftChip(from)]),
        txt(
            {
                fontSize: 34,
                color: P.muted,
                width: 110,
                justifyContent: 'center',
            },
            '→',
        ),
        div({ flex: 1 }, [
            to === null
                ? txt(
                      { fontSize: 26, color: P.muted, padding: '12px 0' },
                      'вже не потрібен',
                  )
                : rightChip(to),
        ]),
    ]);

const colHead = (s, right) =>
    div({ flex: 1, justifyContent: right ? 'flex-start' : 'flex-end' }, [
        txt({ fontSize: 26, color: P.muted }, s),
    ]);

const el = div(
    {
        width: '100%',
        height: '100%',
        flexDirection: 'column',
        backgroundColor: P.bg,
        padding: '56px 72px',
        fontFamily: 'Arial',
    },
    [
        txt(
            { fontSize: 42, fontWeight: 700, color: P.text, marginBottom: 28 },
            'Той самий шар: писаний руками → оголошений',
        ),
        div({ alignItems: 'center' }, [
            colHead('у кожному проєкті, руками', false),
            div({ width: 110 }, []),
            colHead('один раз, декларацією', true),
        ]),
        ...PAIRS.map(row),
        div({ marginTop: 30, justifyContent: 'center' }, [
            txt(
                { fontSize: 27, color: P.brand },
                'Імплементація переїжджає в бібліотеку. Вам лишається конфігурація.',
            ),
        ]),
    ],
);

const res = new ImageResponse(el, { width: 1400, height: 780, fonts: FONTS });
const out = resolve(
    OUT_DIR,
    'the-web-ecosystem-is-missing-a-layer.uk.illus-declaration.png',
);
writeFileSync(out, Buffer.from(await res.arrayBuffer()));
console.log(`WROTE ${out}`);

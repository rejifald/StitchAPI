// One-off generator for the two DOU illustrations of the missing-layer article.
// Run from apps/docs:  node --import tsx/esm scripts/gen-dou-illus.mjs
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
    warnBg: '#fdf4e3',
    line: '#e3e7ef',
};

const div = (style, children) => ({
    type: 'div',
    props: { style: { display: 'flex', ...style }, children },
});
const txt = (style, s) => div({ ...style }, s);

// ---- Illustration 1: the layer map with one empty cell ------------------------
const ROWS = [
    ['Застосунок ↔ екран', 'React · Vue · Svelte'],
    ['Застосунок ↔ вхідні запити', 'Fastify · Hono · Nest'],
    ['Застосунок ↔ база даних', 'Prisma · Drizzle · Kysely'],
    ['Застосунок ↔ недовірені дані', 'Zod · Valibot · ArkType'],
    ['Застосунок ↔ серверний стан в UI', 'TanStack Query · SWR'],
];

const rowEl = (label, owner) =>
    div(
        {
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '18px 28px',
            borderBottom: `2px solid ${P.line}`,
        },
        [
            txt({ fontSize: 30, color: P.text }, label),
            txt(
                {
                    fontSize: 28,
                    fontWeight: 700,
                    color: P.brand,
                    backgroundColor: P.brandBg,
                    padding: '10px 22px',
                    borderRadius: 999,
                },
                owner,
            ),
        ],
    );

const mapEl = div(
    {
        width: '100%',
        height: '100%',
        flexDirection: 'column',
        backgroundColor: P.bg,
        padding: '56px 64px',
        fontFamily: 'Arial',
    },
    [
        txt(
            { fontSize: 42, fontWeight: 700, color: P.text, marginBottom: 8 },
            'Кожна межа вебзастосунку має свій шар',
        ),
        txt(
            { fontSize: 30, color: P.muted, marginBottom: 30 },
            'шар = те, що ви оголошуєте, замість того, що імплементуєте',
        ),
        div(
            {
                flexDirection: 'column',
                border: `2px solid ${P.line}`,
                borderRadius: 18,
                backgroundColor: '#ffffff',
                overflow: 'hidden',
            },
            [
                ...ROWS.map(([l, o]) => rowEl(l, o)),
                div(
                    {
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '18px 28px',
                        backgroundColor: P.warnBg,
                    },
                    [
                        txt(
                            { fontSize: 30, fontWeight: 700, color: P.text },
                            'Застосунок ↔ чужий API',
                        ),
                        div({ alignItems: 'center', gap: 18 }, [
                            txt(
                                {
                                    fontSize: 28,
                                    fontWeight: 700,
                                    color: P.warn,
                                    border: `3px dashed ${P.warn}`,
                                    padding: '8px 22px',
                                    borderRadius: 999,
                                    fontFamily: 'Mono',
                                },
                                'fetch',
                            ),
                            txt(
                                { fontSize: 26, color: P.warn },
                                'транспорт, а не шар',
                            ),
                        ]),
                    ],
                ),
            ],
        ),
        txt(
            { fontSize: 26, color: P.muted, marginTop: 26 },
            'Усе, що над транспортом, — типи, повтори, ліміти, авторизація, валідація — досі пишеться руками.',
        ),
    ],
);

// ---- Illustration 2: hand-written helpers collapse into one declaration -------
const CHIPS = [
    'utils/retry.ts',
    'as User[]',
    'sleep(200)',
    'auth/refreshToken.ts',
    'new AbortController()',
    'try { … } finally { … }',
    '// TODO: причесати',
];

const chip = (s) =>
    txt(
        {
            fontSize: 25,
            fontFamily: 'Mono',
            color: P.text,
            backgroundColor: '#ffffff',
            border: `2px solid ${P.line}`,
            borderRadius: 12,
            padding: '10px 16px',
            margin: 7,
        },
        s,
    );

const codeLine = (s, indent = 0, color = P.text) =>
    txt(
        {
            fontSize: 26,
            fontFamily: 'Mono',
            color,
            marginLeft: indent * 26,
            marginTop: 4,
        },
        s,
    );

const panelHeader = (s) =>
    txt({ fontSize: 27, color: P.muted, marginBottom: 16 }, s);

const collapseEl = div(
    {
        width: '100%',
        height: '100%',
        flexDirection: 'column',
        backgroundColor: P.bg,
        padding: '56px 64px',
        fontFamily: 'Arial',
    },
    [
        txt(
            { fontSize: 42, fontWeight: 700, color: P.text, marginBottom: 30 },
            'Той самий шар: писаний руками → оголошений',
        ),
        div({ alignItems: 'stretch', gap: 26 }, [
            div(
                {
                    flexDirection: 'column',
                    flex: 1,
                    border: `2px solid ${P.line}`,
                    borderRadius: 18,
                    padding: 26,
                },
                [
                    panelHeader('у кожному проєкті, по інциденту за раз'),
                    div({ flexWrap: 'wrap' }, CHIPS.map(chip)),
                    txt(
                        { fontSize: 25, color: P.warn, marginTop: 18 },
                        'ніколи не завершений · не переноситься між проєктами',
                    ),
                ],
            ),
            div({ alignItems: 'center', justifyContent: 'center' }, [
                txt({ fontSize: 64, color: P.muted }, '→'),
            ]),
            div(
                {
                    flexDirection: 'column',
                    flex: 1,
                    border: `2px solid ${P.brand}`,
                    borderRadius: 18,
                    padding: 26,
                    backgroundColor: '#ffffff',
                },
                [
                    panelHeader('один раз, декларацією'),
                    div({ flexDirection: 'column' }, [
                        codeLine('const listUsers = stitch({', 0, P.brand),
                        codeLine("path: '/users',", 1),
                        codeLine('auth: bearer(env(…)),', 1),
                        codeLine('output: drift(User),', 1),
                        codeLine('retry: 3,', 1),
                        codeLine("throttle: '10/s',", 1),
                        codeLine("timeout: '10s',", 1),
                        codeLine('});', 0, P.brand),
                    ]),
                    txt(
                        { fontSize: 25, color: P.brand, marginTop: 18 },
                        'імплементація — в бібліотеці, конфігурація — ваша',
                    ),
                ],
            ),
        ]),
    ],
);

const render = async (el, w, h, name) => {
    const res = new ImageResponse(el, { width: w, height: h, fonts: FONTS });
    const out = resolve(OUT_DIR, name);
    writeFileSync(out, Buffer.from(await res.arrayBuffer()));
    console.log(`WROTE ${out}`);
};

await render(
    mapEl,
    1400,
    860,
    'the-web-ecosystem-is-missing-a-layer.uk.illus-layer-map.png',
);
await render(
    collapseEl,
    1400,
    840,
    'the-web-ecosystem-is-missing-a-layer.uk.illus-declaration.png',
);

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

// The article's own transformation, code to code: the full hand-rolled
// listUsers on the left, the stitch declaration on the right. 2-space indent
// so the longest line fits the panel.
const LEFT_CODE = [
    'export async function listUsers() {',
    '  const ctl = new AbortController();',
    '  const timer = setTimeout(() => ctl.abort(), 10_000);',
    '  try {',
    '    const res = await withRetry(() =>',
    "      fetch('https://api.example.com/users', {",
    '        headers: {',
    '          Authorization: `Bearer ${await getToken()}`,',
    '        },',
    '        signal: ctl.signal,',
    '      }),',
    '    );',
    '    if (!res.ok) throw new Error(`HTTP ${res.status}`);',
    '    return (await res.json()) as User[];',
    '  } finally {',
    '    clearTimeout(timer);',
    '  }',
    '}',
];
const RIGHT_CODE = [
    'const listUsers = stitch({',
    "  baseUrl: 'https://api.example.com',",
    "  path: '/users',",
    "  auth: bearer(env('API_TOKEN')),",
    '  output: drift(z.array(User)),',
    '  retry: 3,',
    "  throttle: '10/s',",
    "  timeout: '10s',",
    '});',
];

const codeLine = (s, color) =>
    txt(
        {
            fontSize: 19,
            fontFamily: 'Mono',
            color,
            marginTop: 3,
            whiteSpace: 'pre',
        },
        s || ' ',
    );

const panel = (headline, subnote, lines, color, borderColor, caption) =>
    div(
        {
            flexDirection: 'column',
            border: `2px solid ${borderColor}`,
            borderRadius: 18,
            padding: 24,
            backgroundColor: '#ffffff',
        },
        [
            txt({ fontSize: 26, color: P.muted }, headline),
            subnote
                ? txt({ fontSize: 21, color: P.warn, marginTop: 4 }, subnote)
                : div({ height: 0 }, []),
            div(
                { flexDirection: 'column', marginTop: 14 },
                lines.map((l) => codeLine(l, color)),
            ),
            caption
                ? txt({ fontSize: 21, color: P.brand, marginTop: 14 }, caption)
                : div({ height: 0 }, []),
        ],
    );

const el = div(
    {
        width: '100%',
        height: '100%',
        flexDirection: 'column',
        backgroundColor: P.bg,
        padding: '52px 56px',
        fontFamily: 'Arial',
    },
    [
        txt(
            { fontSize: 42, fontWeight: 700, color: P.text, marginBottom: 26 },
            'Той самий шар: писаний руками → оголошений',
        ),
        div({ alignItems: 'flex-start', gap: 20 }, [
            div({ flex: 1.28, flexDirection: 'column' }, [
                panel(
                    'у кожному проєкті, руками',
                    'плюс utils/retry.ts і auth/token.ts — теж ваші',
                    LEFT_CODE,
                    P.text,
                    P.line,
                    null,
                ),
            ]),
            div(
                {
                    alignItems: 'center',
                    justifyContent: 'center',
                    alignSelf: 'center',
                    width: 84,
                },
                [txt({ fontSize: 56, color: P.muted }, '→')],
            ),
            div({ flex: 1, flexDirection: 'column' }, [
                panel(
                    'один раз, декларацією',
                    null,
                    RIGHT_CODE,
                    P.brand,
                    P.brand,
                    'і це вже з бекофом, тротлінгом і валідацією форми — яких зліва нема',
                ),
            ]),
        ]),
        div({ marginTop: 26, justifyContent: 'center' }, [
            txt(
                { fontSize: 27, color: P.text },
                'Імплементація переїжджає в бібліотеку. Вам лишається конфігурація.',
            ),
        ]),
    ],
);

const res = new ImageResponse(el, { width: 1400, height: 800, fonts: FONTS });
const out = resolve(
    OUT_DIR,
    'the-web-ecosystem-is-missing-a-layer.uk.illus-declaration.png',
);
writeFileSync(out, Buffer.from(await res.arrayBuffer()));
console.log(`WROTE ${out}`);

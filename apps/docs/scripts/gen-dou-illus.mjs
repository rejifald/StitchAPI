// Generator for the DOU illustration of the missing-layer article: the
// before → after transformation, code to code, highlighted with the same
// Shiki theme the docs site uses (github-light — see source.config.ts,
// which spreads rehypeCodeDefaultOptions).
// Run from apps/docs:  node --import tsx/esm scripts/gen-dou-illus.mjs
// Light theme (DOU pages are white), Ukrainian labels, no product logo (DOU rule).
import { ImageResponse } from 'next/og';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeToTokens } from 'shiki';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '..', 'content', 'drafts');

const FDIR = process.env.COVER_FONT_DIR || '/System/Library/Fonts/Supplemental';
for (const file of ['Arial.ttf', 'Arial Bold.ttf', 'Courier New.ttf']) {
    if (!existsSync(resolve(FDIR, file))) {
        console.error(`missing font: ${resolve(FDIR, file)}`);
        process.exit(1);
    }
}
const FONTS = [
    {
        name: 'Arial',
        data: readFileSync(resolve(FDIR, 'Arial.ttf')),
        weight: 400,
        style: 'normal',
    },
    {
        name: 'Arial',
        data: readFileSync(resolve(FDIR, 'Arial Bold.ttf')),
        weight: 700,
        style: 'normal',
    },
    {
        name: 'Mono',
        data: readFileSync(resolve(FDIR, 'Courier New.ttf')),
        weight: 400,
        style: 'normal',
    },
];

// Signal palette, light theme (mirrors apps/docs/app/tokens.css)
const P = {
    bg: '#fbfbfd',
    text: '#0c1019',
    muted: '#58616f',
    brand: '#1d4fd0',
    warn: '#b4690a',
    line: '#e3e7ef',
};

const div = (style, children) => ({
    type: 'div',
    props: { style: { display: 'flex', ...style }, children },
});
const txt = (style, s) => div({ ...style }, s);

// The article's own snippets, verbatim (minus the narrative lead comment).
const LEFT_CODE = `import { getToken } from './auth/token';
import { withRetry } from './utils/retry';

export async function listUsers(): Promise<User[]> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10_000);
    try {
        const res = await withRetry(() =>
            fetch('https://api.example.com/users', {
                headers: { Authorization: \`Bearer \${await getToken()}\` },
                signal: ctl.signal,
            }),
        );
        if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
        return (await res.json()) as User[]; // заявка, а не перевірка
    } finally {
        clearTimeout(timer);
    }
}`;
const RIGHT_CODE = `const listUsers = stitch({
    baseUrl: 'https://api.example.com',
    path: '/users',
    auth: bearer(env('API_TOKEN')),
    output: drift(z.array(User)),
    retry: 3,
    throttle: '10/s',
    timeout: '10s',
});`;

const tokenize = async (code) =>
    (await codeToTokens(code, { lang: 'ts', theme: 'github-light' })).tokens;

const codeBlock = (tokenLines, fontSize) =>
    div(
        {
            flexDirection: 'column',
            backgroundColor: '#ffffff',
            border: `1px solid ${P.line}`,
            borderRadius: 14,
            padding: `${Math.round(fontSize * 0.9)}px ${Math.round(fontSize * 1.1)}px`,
        },
        tokenLines.map((line) =>
            div(
                { marginTop: Math.max(2, Math.round(fontSize * 0.16)) },
                line.length
                    ? line.map((t) =>
                          txt(
                              {
                                  fontSize,
                                  fontFamily: 'Mono',
                                  color: t.color || P.text,
                                  whiteSpace: 'pre',
                              },
                              t.content,
                          ),
                      )
                    : [
                          txt(
                              {
                                  fontSize,
                                  fontFamily: 'Mono',
                                  whiteSpace: 'pre',
                              },
                              ' ',
                          ),
                      ],
            ),
        ),
    );

const leftTokens = await tokenize(LEFT_CODE);
const rightTokens = await tokenize(RIGHT_CODE);
const leftCount = LEFT_CODE.split('\n').length;
const rightCount = RIGHT_CODE.split('\n').length;

const header = (label, counter) =>
    div({ alignItems: 'baseline', marginBottom: 10 }, [
        txt({ fontSize: 26, color: P.muted }, label),
        txt(
            { fontSize: 22, color: P.text, fontWeight: 700, marginLeft: 12 },
            counter,
        ),
    ]);

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
        div({ alignItems: 'flex-start', gap: 18 }, [
            div({ flexDirection: 'column', flexShrink: 0 }, [
                header('у кожному проєкті, руками', `${leftCount} рядків`),
                codeBlock(leftTokens, 14),
                txt(
                    { fontSize: 21, color: P.warn, marginTop: 10 },
                    'і utils/retry.ts з auth/token.ts теж підтримуєте ви',
                ),
            ]),
            div(
                {
                    alignItems: 'center',
                    justifyContent: 'center',
                    alignSelf: 'center',
                    width: 64,
                    flexShrink: 0,
                },
                [txt({ fontSize: 52, color: P.muted }, '→')],
            ),
            div({ flexDirection: 'column', flex: 1 }, [
                header('один раз, декларацією', `${rightCount} рядків`),
                codeBlock(rightTokens, 21),
                txt(
                    { fontSize: 21, color: P.brand, marginTop: 10 },
                    'і це вже з бекофом, тротлінгом і валідацією форми —',
                ),
                txt({ fontSize: 21, color: P.brand }, 'яких зліва нема'),
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

const res = new ImageResponse(el, { width: 1400, height: 700, fonts: FONTS });
const out = resolve(
    OUT_DIR,
    'the-web-ecosystem-is-missing-a-layer.uk.illus-declaration.png',
);
writeFileSync(out, Buffer.from(await res.arrayBuffer()));
console.log(`WROTE ${out}`);

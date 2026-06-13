/**
 * StitchAPI palette contrast audit.
 *
 * Prints a WCAG 2.1 + APCA (SA98G) table for the brand pairings that matter, and
 * regenerates ../assets/contrast-audit.svg from the same numbers (so the sheet can
 * never drift from the token values). Alpha tokens are composited over their real
 * Fumadocs surface before measuring.
 *
 *   node docs/brand/scripts/audit-contrast.mjs        # run from the repo root
 *
 * Token source of truth: apps/docs/app/global.css + the inherited Fumadocs neutral theme.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hex = (h) => {
    h = h.replace('#', '');
    if (h.length === 3)
        h = h
            .split('')
            .map((c) => c + c)
            .join('');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const hsl = (h, s, l) => {
    s /= 100;
    l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return [f(0), f(8), f(4)].map((x) => Math.round(x * 255));
};
const over = (fg, bg, a) =>
    fg.map((c, i) => Math.round(c * a + bg[i] * (1 - a)));
const toHex = (r) =>
    '#' +
    r
        .map((c) => c.toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase();

// WCAG 2.1 relative-luminance contrast
const lin = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const lum = (r) => 0.2126 * lin(r[0]) + 0.7152 * lin(r[1]) + 0.0722 * lin(r[2]);
const wcag = (a, b) => {
    const l1 = lum(a),
        l2 = lum(b),
        hi = Math.max(l1, l2),
        lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
};

// APCA 0.98G (SA98G) — perceptual lightness contrast
const TRC = 2.4,
    Rc = 0.2126729,
    Gc = 0.7151522,
    Bc = 0.072175,
    nBG = 0.56,
    nTX = 0.57,
    rTX = 0.62,
    rBG = 0.65,
    blk = 0.022,
    clmp = 1.414,
    sc = 1.14,
    off = 0.027,
    dMin = 0.0005;
const apcaY = (r) => {
    const L = r.map((c) => Math.pow(c / 255, TRC));
    return Rc * L[0] + Gc * L[1] + Bc * L[2];
};
function apca(t, b) {
    let Yt = apcaY(t),
        Yb = apcaY(b);
    Yt = Yt > blk ? Yt : Yt + Math.pow(blk - Yt, clmp);
    Yb = Yb > blk ? Yb : Yb + Math.pow(blk - Yb, clmp);
    if (Math.abs(Yb - Yt) < dMin) return 0;
    let C;
    if (Yb > Yt) {
        C = (Math.pow(Yb, nBG) - Math.pow(Yt, nTX)) * sc;
        C = C < off ? 0 : C - off;
    } else {
        C = (Math.pow(Yb, rBG) - Math.pow(Yt, rTX)) * sc;
        C = C > -off ? 0 : C + off;
    }
    return Math.abs(Math.round(C * 100 * 10) / 10);
}

// --- resolved palette (brand tokens + inherited Fumadocs neutral surfaces) ---
const LBG = hsl(0, 0, 96),
    DBG = hsl(0, 0, 7.04),
    LCARD = hsl(0, 0, 94.7),
    DCARD = hsl(0, 0, 9.8),
    Lfg = hsl(0, 0, 3.9),
    Dfg = hsl(0, 0, 92),
    Lmut = hsl(0, 0, 45.1);
const stitchL = hex('#3B82F6'),
    strongL = hex('#2563EB'),
    softL = hex('#EFF6FF'),
    borderL = hex('#BFDBFE'),
    stitchD = hex('#60A5FA'),
    strongD = hex('#93C5FD');
const softD = over(hex('#1E3A8A'), DBG, 0.32),
    strL = hex('#C2882A'),
    strD = hex('#E0B252'),
    fnD = hex('#7AA2F7');

const light = [
    { r: 'Body  fd-fg', fg: Lfg, bg: LBG, use: 'text' },
    { r: 'Muted  fd-muted-fg', fg: Lmut, bg: LBG, use: 'text' },
    { r: 'Link  --stitch #3B82F6', fg: stitchL, bg: LBG, use: 'text', star: 1 },
    { r: 'Strong  #2563EB', fg: strongL, bg: LBG, use: 'text' },
    { r: 'Banner  strong / soft', fg: strongL, bg: softL, use: 'text' },
    { r: 'Code string  #C2882A', fg: strL, bg: LCARD, use: 'text', star: 1 },
    { r: 'Code key  #3B82F6', fg: stitchL, bg: LCARD, use: 'text' },
    {
        r: 'Soft border  #BFDBFE',
        fg: borderL,
        bg: LBG,
        use: 'ui',
        note: 'Near-invisible',
    },
];
const dark = [
    { r: 'Body  fd-fg', fg: Dfg, bg: DBG, use: 'text' },
    { r: 'Link  --stitch #60A5FA', fg: stitchD, bg: DBG, use: 'text' },
    { r: 'Strong  #93C5FD', fg: strongD, bg: DBG, use: 'text' },
    { r: 'Text on soft fill', fg: Dfg, bg: softD, use: 'text' },
    { r: 'Code string  #E0B252', fg: strD, bg: DCARD, use: 'text' },
    { r: 'Code fn  #7AA2F7', fg: fnD, bg: DCARD, use: 'text' },
];
const GREEN = '#16a34a',
    RED = '#dc2626',
    AMBER = '#d97706';
function verdict(w, use, note) {
    if (note) return [RED, note];
    if (use === 'ui') return w >= 3 ? [GREEN, 'UI ✓'] : [RED, 'UI too low'];
    if (w >= 7) return [GREEN, 'AAA ✓'];
    if (w >= 4.5) return [GREEN, 'AA ✓'];
    if (w >= 3) return [AMBER, 'Fails text · ok large'];
    return [RED, 'Fails — too low'];
}

// --- console table ---
function printTable(title, rows) {
    console.log('\n' + title);
    for (const row of rows) {
        const w = wcag(row.fg, row.bg),
            a = apca(row.fg, row.bg),
            [, vt] = verdict(w, row.use, row.note);
        console.log(
            (row.star ? '★ ' : '  ') + row.r.padEnd(26),
            (w.toFixed(2) + ':1').padStart(8),
            ('Lc ' + a.toFixed(1)).padStart(9),
            '  ' + vt,
        );
    }
}
printTable('LIGHT — surface #F5F5F5', light);
printTable('DARK  — surface #121212', dark);

// --- SVG sheet ---
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const W = 920,
    rowH = 56,
    chipX = 28,
    chipW = 372;
function panel(top, rows, mode) {
    const isL = mode === 'light',
        surf = isL ? '#F5F5F5' : '#121212',
        cstroke = isL ? '#e5e7eb' : '#2b2b2b';
    const ink = isL ? '#0c0c0c' : '#f3f4f6',
        mut = isL ? '#6b7280' : '#9ca3af',
        chipStroke = isL ? '#0000001f' : '#ffffff1f';
    const h = 66 + rows.length * rowH + 14;
    let s = `<rect x="12" y="${top}" width="896" height="${h}" rx="16" fill="${surf}" stroke="${cstroke}"/>`;
    const pass = rows.filter(
        (r) => verdict(wcag(r.fg, r.bg), r.use, r.note)[0] === GREEN,
    ).length;
    s += `<text x="28" y="${top + 30}" font-size="15" font-weight="700" fill="${ink}">${mode.toUpperCase()} — surface ${surf}</text>`;
    s += `<text x="892" y="${top + 30}" font-size="13" font-weight="600" text-anchor="end" fill="${pass === rows.length ? GREEN : AMBER}">${pass}/${rows.length} pass</text>`;
    s += `<text x="28" y="${top + 52}" font-size="10.5" letter-spacing="0.06em" fill="${mut}">PAIRING — real fg on real surface</text>`;
    s += `<text x="420" y="${top + 52}" font-size="10.5" letter-spacing="0.06em" fill="${mut}">WCAG 2.1</text>`;
    s += `<text x="556" y="${top + 52}" font-size="10.5" letter-spacing="0.06em" fill="${mut}">APCA Lc</text>`;
    s += `<text x="692" y="${top + 52}" font-size="10.5" letter-spacing="0.06em" fill="${mut}">VERDICT</text>`;
    rows.forEach((row, i) => {
        const y = top + 66 + i * rowH,
            w = wcag(row.fg, row.bg),
            a = apca(row.fg, row.bg),
            [vc, vt] = verdict(w, row.use, row.note);
        s += `<rect x="${chipX}" y="${y + 8}" width="${chipW}" height="40" rx="9" fill="${toHex(row.bg)}" stroke="${chipStroke}"/>`;
        s += `<text x="${chipX + 18}" y="${y + 33}" font-size="15" fill="${toHex(row.fg)}"><tspan font-weight="700">Aa</tspan>  ${row.star ? '★ ' : ''}${esc(row.r)}</text>`;
        s += `<text x="420" y="${y + 27}" font-size="18" font-weight="700" fill="${vc}">${w.toFixed(2)}:1</text>`;
        s += `<text x="420" y="${y + 42}" font-size="10.5" fill="${mut}">${row.use === 'ui' ? 'UI needs 3.0' : 'needs 4.5'}</text>`;
        s += `<text x="556" y="${y + 27}" font-size="16" font-weight="600" fill="${ink}">${a.toFixed(1)}</text>`;
        s += `<text x="556" y="${y + 42}" font-size="10.5" fill="${mut}">${row.use === 'ui' ? '≥45' : 'body ≈75'}</text>`;
        s += `<rect x="692" y="${y + 13}" width="200" height="28" rx="14" fill="${vc}22"/>`;
        s += `<text x="792" y="${y + 31}" font-size="12.5" font-weight="600" text-anchor="middle" fill="${vc}">${vt}</text>`;
    });
    return { svg: s, bottom: top + h };
}
const p1 = panel(84, light, 'light');
const p2 = panel(p1.bottom + 22, dark, 'dark');
const H = p2.bottom + 18;
const out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Inter, -apple-system, system-ui, sans-serif">
<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>
<text x="28" y="40" font-size="23" font-weight="700" fill="#0c0c0c">StitchAPI · Palette audit</text>
<text x="28" y="63" font-size="12.5" fill="#6b7280">WCAG 2.1 ratio + APCA Lc (perceptual). Alpha tokens composited over their real surface. Text: WCAG ≥4.5 &amp; APCA ≈75 · UI/large: ≥3.0 &amp; ≅45.</text>
${p1.svg}${p2.svg}
</svg>
`;
const outPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../assets/contrast-audit.svg',
);
writeFileSync(outPath, out);
console.log('\nwrote ' + outPath + '  (height ' + H + ')');

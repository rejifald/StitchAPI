#!/usr/bin/env node
// Hardcoded-secret gate for the tracked tree.
//
// Motivated by a real slip: a temporary diagnostic route (PRs #391/#392 — closed,
// never merged) committed a hardcoded gate literal, `const DIAG_KEY = 'd1ag-…'`. It
// never reached main and read no real credentials, but a committed credential
// literal is exactly the class we don't want to normalize. This gate would have
// failed those PRs at CI time — that's the point: catch it before it merges.
//
// SCOPE — deliberately high-precision, NOT a comprehensive scanner:
//   A. credential-named literal assignment — a QUALIFIED identifier whose last word
//      is key/secret/token/password/… (e.g. DIAG_KEY, apiKey, CLIENT_SECRET, but not
//      a bare `key`) assigned a random-looking quoted literal (the DIAG_KEY class).
//   B. unambiguous provider token formats — AWS / GitHub / Slack / Google /
//      Stripe-live keys and PEM private-key headers, which never legitimately
//      appear as a source literal.
// Env done the right way is never flagged — `process.env.X` / `env('X')` read a
// variable, not a literal. Tests, docs, examples and markdown are out of scope:
// they are the designated home of fake fixtures/examples, so scanning them is pure
// false-positive noise. For exhaustive history + entropy coverage across those too,
// layer gitleaks/trufflehog on top; this is the cheap, zero-dep, locally-runnable
// first line that mirrors the repo's other `check:*` gates.
//
// Exempt a reviewed non-secret example with an inline `// secret-scan:allow` (or
// the conventional `pragma: allowlist secret`) on the same line.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Tracked files only — `git ls-files` respects .gitignore, so node_modules, lib/,
// dist/ and .next never enter scope. -z is NUL-separated (safe for odd names).
const tracked = execFileSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
})
    .split('\0')
    .filter(Boolean);

// Out of scope. NOTE: `^docs\/` is the top-level prose tree (ADRs, proposals) and
// `\.mdx?$` is any markdown — the Next *app* under apps/docs/** (where the incident
// actually lived) is deliberately NOT excluded, so its .ts/.mjs source is scanned.
const SKIP_PATH =
    /(?:^|\/)(?:tests?|__tests__|__mocks__|__fixtures__|fixtures|examples?)\/|\.(?:spec|test|e2e)\.[cm]?[jt]sx?$|^docs\//i;
// This scanner (it holds every pattern below), the lockfile, generated artifacts,
// and any markdown.
const SKIP_FILE =
    /(?:^|\/)(?:scripts\/check-secrets\.mjs|pnpm-lock\.yaml)$|\.generated\.[cm]?[jt]sx?$|\.mdx?$/;
const SKIP_EXT = new Set([
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.webp',
    '.ico',
    '.svg',
    '.avif',
    '.woff',
    '.woff2',
    '.ttf',
    '.otf',
    '.eot',
    '.pdf',
    '.map',
    '.lock',
    '.mp4',
    '.webm',
    '.wasm',
    '.snap',
]);

// A. An identifier whose LAST word is one of these, assigned a quoted literal.
const SECRET_WORDS = new Set([
    'KEY',
    'SECRET',
    'TOKEN',
    'PASSWORD',
    'PASSWD',
    'PASSPHRASE',
    'CREDENTIAL',
    'CREDENTIALS',
    'PWD',
    'APIKEY',
]);

// Split an identifier on snake_case + camelCase into its words. `DIAG_KEY`→
// [DIAG,KEY], `clientSecret`→[client,Secret], `key`→[key]. We require ≥2 words AND
// a secret last word, so a QUALIFIED credential name (DIAG_KEY, apiKey) fires while
// a bare map/cache key (`key`, `value`) and non-secret tails (`keyOf`→[key,Of])
// stay quiet — the qualifier + end-anchor are what keep false positives down.
function idWords(id) {
    return id
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_$]+/g, ' ')
        .trim()
        .split(/\s+/);
}

// `IDENT = 'literal'` / `IDENT: "literal"` / backtick — ident, quote, value.
const ASSIGN = /\b([A-Za-z_$][\w$]*)\s*[:=]\s*(['"`])([^'"`\r\n]{8,})\2/g;

// Values we never flag even under a secret-y name: obvious placeholders.
const PLACEHOLDER =
    /^(?:x{3,}|\.{3,}|-+$|<[^>]*>|\{[^}]*\}|(?:your|my|the|an?|some|example|sample|dummy|placeholder|changeme|change[-_ ]?me|redacted|fake|todo|tbd|none|null|undefined|test|foo|bar|baz|abc|xxx)[-_ ]?)/i;

// B. Provider tokens that never legitimately appear as a source literal.
const PROVIDER = [
    ['AWS access key', /\bA(?:KIA|SIA)[0-9A-Z]{16}\b/],
    ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
    ['GitHub fine-grained PAT', /\bgithub_pat_[A-Za-z0-9_]{60,}\b/],
    ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
    ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
    ['Stripe live secret', /\bsk_live_[0-9A-Za-z]{16,}\b/],
    [
        'private key',
        /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
    ],
];

const ALLOW = /secret-scan:allow|pragma:\s*allowlist secret/i;

// Shannon entropy (bits/char). A random credential token is high-entropy; a cache
// namespace like `circuit:` or a header name is not. The floor drops those while
// keeping the DIAG_KEY that motivated this gate (`d1ag-9k2m7q4x8z` ≈ 3.9 bits/char).
const ENTROPY_FLOOR = 3.0;
function entropy(s) {
    const freq = Object.create(null);
    for (const c of s) freq[c] = (freq[c] || 0) + 1;
    let h = 0;
    for (const c in freq) {
        const p = freq[c] / s.length;
        h -= p * Math.log2(p);
    }
    return h;
}

const findings = [];
for (const file of tracked) {
    if (SKIP_PATH.test(file) || SKIP_FILE.test(file)) continue;
    if (SKIP_EXT.has(extname(file).toLowerCase())) continue;
    let text;
    try {
        text = readFileSync(resolve(ROOT, file), 'utf8');
    } catch {
        continue;
    }
    if (text.includes('\0')) continue; // binary

    text.split(/\r?\n/).forEach((line, i) => {
        if (ALLOW.test(line)) return;

        // A. credential-named literal assignment
        for (const m of line.matchAll(ASSIGN)) {
            const [, ident, , value] = m;
            const words = idWords(ident);
            if (words.length < 2) continue; // bare key/secret/token → skip
            if (!SECRET_WORDS.has(words.at(-1).toUpperCase())) continue;
            if (/\s/.test(value) || value.includes('${')) continue; // prose / template
            if (PLACEHOLDER.test(value)) continue;
            if (entropy(value) < ENTROPY_FLOOR) continue; // low-randomness → not a key
            findings.push({
                file,
                line: i + 1,
                kind: `hardcoded ${ident}`,
                len: value.length,
            });
        }

        // B. provider token formats
        for (const [name, re] of PROVIDER) {
            if (re.test(line))
                findings.push({ file, line: i + 1, kind: name, len: 0 });
        }
    });
}

if (findings.length) {
    console.error(`\n✗ ${findings.length} possible hardcoded secret(s):\n`);
    for (const f of findings) {
        // Never echo the value into CI logs — location + kind is enough to fix.
        const detail = f.len
            ? `${f.kind} (<redacted>, ${f.len} chars)`
            : f.kind;
        console.error(`  ${f.file}:${f.line}  ${detail}`);
    }
    console.error(
        '\n  Move the value to an env var (read via process.env / env()) and ROTATE it —' +
            '\n  a committed secret is compromised even after it is removed. If this is a' +
            '\n  genuine non-secret example, annotate the line with `// secret-scan:allow`.\n',
    );
    process.exit(1);
}
console.log(
    `✓ secret-scan OK — no hardcoded secrets across ${tracked.length} tracked files.`,
);

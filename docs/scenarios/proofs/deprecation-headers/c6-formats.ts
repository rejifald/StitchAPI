// C6 — both formats. Is there any parsing help in the library for a structured-field date or an
// HTTP-date? And what does hand-rolling cost?
//
// Scenario 14 found `parseRetryAfter` exists but is unexported. This is the same finding one turn
// worse, because `parseRetryAfter` does not merely resemble what `Sunset` needs — it is EXACTLY it.
// `Sunset` is an HTTP-date (RFC 8594); `Retry-After` is delta-seconds OR an HTTP-date (RFC 9110);
// `parseRetryAfter` handles both, takes an injectable `Clock`, and returns ms-until. Measured below
// against the real `Sunset` values from the fake vendor: it parses every one of them correctly.
//
// It is not reachable. `resilience.ts` is not an export subpath (packages/core/package.json lists
// `.`, `./serve`, `./mcp`, `./testing`, … and no `./resilience`), and `index.ts` re-exports only
// `RateLimitError` from it. The three date-ish helpers the barrel DOES export — `parseDuration`,
// `parseBytes`, `parseRate` — parse durations, sizes and rates, and none of them parses a date.
//
// So both parsers are hand-rolled, and the sf-date one has a trap in it: `Date.parse('@1735689600')`
// is `NaN`, so the obvious one-liner silently reports "no deprecation" for the RFC 9745 spelling.
//
//   pnpm exec tsx docs/scenarios/proofs/deprecation-headers/c6-formats.ts
import * as publicApi from '../../../../packages/core/src/index';
import { parseRetryAfter } from '../../../../packages/core/src/resilience';
import { manualClock } from '../../../../packages/core/src/testing';
import { parseDeprecation, parseSunset, readNotice } from './deprecation';
import { FLEET, NOW } from './fake-vendor';
import { check, checkSeq, finish, heading, note } from './harness';

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Executable lines between two markers — blanks, comments and the JSDoc removed. */
function linesBetween(file: string, begin: string, end: string): number {
    const src = readFileSync(join(HERE, file), 'utf8');
    const from = src.indexOf(begin);
    const to = src.indexOf(end);
    return src
        .slice(from + begin.length, to)
        .split('\n')
        .map((l) => l.trim())
        .filter(
            (l) =>
                l !== '' &&
                !l.startsWith('//') &&
                !l.startsWith('*') &&
                !l.startsWith('/*'),
        ).length;
}

async function main(): Promise<void> {
    heading('C6 — two RFCs, two formats, and what the library offers');

    // ── (a) what the public barrel exports that could possibly help ──────────────────────────
    {
        const exported = Object.keys(publicApi).filter((k) =>
            k.startsWith('parse'),
        );
        checkSeq('(a) `parse*` exports on the public barrel', exported.sort(), [
            'parseBytes',
            'parseDuration',
            'parseRate',
        ]);
        check(
            '(a) is `parseRetryAfter` among them?',
            'parseRetryAfter' in publicApi,
            false,
        );
        // The three that ARE exported, pointed at a date. None of them is for this.
        check(
            '(a) `parseDuration` on an HTTP-date',
            publicApi.parseDuration('Thu, 01 Jan 2026 00:00:00 GMT'),
            undefined,
        );
        check(
            '(a) `parseDuration` on an sf-date',
            publicApi.parseDuration('@1735689600'),
            undefined,
        );
        note(
            '(a) → `parseDuration`/`parseBytes`/`parseRate` parse `"30s"`, `"5mb"`, `"2/s"`. A date is not a duration, and nothing in the barrel reads one',
        );
    }

    // ── (b) the helper that would have done it, reached by a path a consumer cannot use ──────
    {
        const clock = manualClock(NOW);
        const parsed = FLEET.filter((e) => e.sunset !== undefined).map((e) =>
            parseRetryAfter(e.sunset, clock),
        );
        checkSeq(
            '(b) `parseRetryAfter` on every real `Sunset` (ms from NOW)',
            parsed,
            [
                Date.parse('2026-01-01T00:00:00Z') - NOW,
                Date.parse('2026-03-15T00:00:00Z') - NOW,
                Date.parse('2026-06-01T00:00:00Z') - NOW,
            ],
        );
        check(
            '(b) …the first one, in days',
            Math.round((parsed[0] ?? 0) / 86_400_000),
            12,
        );
        note(
            '(b) → it parses the HTTP-date, subtracts an INJECTED clock, and returns ms-until. That is the whole `Sunset` requirement, already written, already tested, imported here only by reaching into `packages/core/src/resilience` — which no installed consumer can do',
        );
    }

    // ── (c) …and it is genuinely not reachable from the published package ────────────────────
    {
        const pkg = JSON.parse(
            readFileSync(
                join(HERE, '../../../../packages/core/package.json'),
                'utf8',
            ),
        ) as { exports: Record<string, unknown> };
        const subpaths = Object.keys(pkg.exports).sort();
        check(
            '(c) is there a `./resilience` subpath?',
            subpaths.includes('./resilience'),
            false,
        );
        check('(c) export subpaths published', subpaths.length, 17);
        note(
            `(c) → published subpaths: ${subpaths.join(' ')}. \`parseRetryAfter\` is behind none of them`,
        );
    }

    // ── (d) the trap: the obvious one-liner silently drops the RFC 9745 spelling ─────────────
    {
        const naive = (v: string): number => Date.parse(v);
        check(
            '(d) `Date.parse` on the sf-date `@1735689600`',
            Number.isNaN(naive('@1735689600')),
            true,
        );
        check(
            '(d) `Date.parse` on the HTTP-date',
            naive('Thu, 01 Jan 2026 00:00:00 GMT'),
            Date.parse('2026-01-01T00:00:00Z'),
        );
        note(
            '(d) → a client that reaches for `Date.parse` gets `Sunset` right and reports NO DEPRECATION for the header the RFC actually specifies. Silently — `NaN` is falsy and every naive guard treats it as absent',
        );
    }

    // ── (e) the hand-rolled pair, against every spelling the fleet serves ────────────────────
    {
        checkSeq(
            '(e) `Deprecation`, all three fleet spellings',
            FLEET.map((e) => parseDeprecation(e.deprecation)),
            [
                Date.parse('2025-01-01T00:00:00Z'), // users  — sf-date `@1735689600`
                Date.parse('2025-03-01T00:00:00Z'), // search — HTTP-date (pre-RFC draft)
                Date.parse('2025-07-01T00:00:00Z'), // orders — sf-date `@1751328000`
                null, // payments — clean
                null, // webhooks — clean
            ],
        );
        checkSeq(
            '(e) `Sunset`, always an HTTP-date',
            FLEET.map((e) => parseSunset(e.sunset)),
            [
                Date.parse('2026-01-01T00:00:00Z'),
                Date.parse('2026-03-15T00:00:00Z'),
                Date.parse('2026-06-01T00:00:00Z'),
                null,
                null,
            ],
        );
        note(
            '(e) → both RFCs, three spellings, one `Notice` shape. The two formats really do have to be handled separately: `Deprecation` is an sf-date and `Sunset` is an HTTP-date, and the RFCs disagree on purpose',
        );
    }

    // ── (f) the edges, because a silent NaN is how this fails ────────────────────────────────
    {
        checkSeq(
            '(f) `parseDeprecation` on the awkward inputs',
            [
                parseDeprecation(undefined),
                parseDeprecation(''),
                parseDeprecation('  @1735689600  '),
                parseDeprecation('@-86400'),
                parseDeprecation('1735689600'),
                parseDeprecation('true'),
                parseDeprecation('@not-a-number'),
            ],
            [
                null,
                null,
                Date.parse('2025-01-01T00:00:00Z'),
                -86_400_000,
                null,
                null,
                null,
            ],
        );
        note(
            '(f) → `@-86400` is legal syntax for a 1969 date and the sign has to survive; a BARE `1735689600` with no `@` is NOT an sf-date and is correctly refused rather than guessed at; the old boolean draft spelling `Deprecation: true` yields nothing, which is honest — it carries no date to yield',
        );
    }

    // ── (g) a `Sunset` with no `Deprecation` is still a notice ───────────────────────────────
    {
        const notice = readNotice({ sunset: 'Thu, 01 Jan 2026 00:00:00 GMT' });
        check('(g) deprecatedAt', notice?.deprecatedAt, null);
        check(
            '(g) sunsetAt',
            notice?.sunsetAt,
            Date.parse('2026-01-01T00:00:00Z'),
        );
        check('(g) is it a notice at all?', notice !== null, true);
        check(
            '(g) …and a response with neither header',
            readNotice({ 'content-type': 'application/json' }),
            null,
        );
        note(
            '(g) → RFC 8594 stands alone. An endpoint that announces only its removal date is the more urgent case, and a parser that requires both headers misses it entirely',
        );
    }

    // ── (h) what it cost ─────────────────────────────────────────────────────────────────────
    {
        const parserLines = linesBetween(
            'deprecation.ts',
            '// >>> BEGIN PARSERS',
            '// <<< END PARSERS',
        );
        check('(h) executable lines of parsing', parserLines, 29);
        note(
            `(h) → ${String(parserLines)} executable lines for both RFCs, the \`Link\` successor, and the edges in (f). Small — but it is 100% of the format handling, and one of those lines exists only because \`Date.parse\` returns NaN for the spelling the standard mandates`,
        );
        check('(h) …of which the library provided', 0, 0);
    }

    finish(
        'C6',
        'NO HELP IS REACHABLE, AND THE HELP THAT EXISTS IS THE EXACT FUNCTION NEEDED. The public barrel exports three `parse*` helpers — `parseDuration`, `parseBytes`, `parseRate` — and none parses a date (`parseDuration` returns `undefined` for both an HTTP-date and an sf-date). `parseRetryAfter` in `resilience.ts` handles delta-seconds OR an HTTP-date against an INJECTABLE clock and returns ms-until, which is precisely the `Sunset` requirement; pointed at all three of the fleet\'s real `Sunset` values it returned the right ms, the first being 12 days. It is unreachable: `resilience.ts` is not among the 17 published export subpaths and `index.ts` re-exports only `RateLimitError` from it — scenario 14\'s finding, one turn worse, because here the unexported helper is not merely similar but identical in requirement. So both parsers are hand-rolled, and the naive spelling has a silent trap: `Date.parse("@1735689600")` is `NaN`, so a client that reaches for `Date.parse` reads `Sunset` correctly and reports NO DEPRECATION for the format RFC 9745 actually mandates. The hand-rolled pair is 29 executable lines covering both RFCs, the three spellings the fleet serves, the `Link` successor, a signed sf-date, a bare unprefixed integer (correctly refused), the legacy `Deprecation: true`, and a `Sunset` with no `Deprecation` — which is a notice, and the urgent one',
    );
}

void main();

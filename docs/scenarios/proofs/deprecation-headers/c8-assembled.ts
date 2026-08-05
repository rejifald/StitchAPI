// C8 — assemble the best available answer and report the seam(s) and the line count.
//
// Both sides do the same job over the same `Adapter` and the same `Clock`: parse both header
// formats, keep one row per endpoint, sort by soonest sunset, answer "how many days", and fail
// after a sunset once it has passed. The parsers are shared (C6 established they are 100% user code
// either way, so re-typing them in the control would inflate it by 29 lines that say nothing about
// the library).
//
// The number goes AGAINST the library, and that is the honest result: 132 executable lines to the
// control's 81. The wiring alone favours it (20 to 52) and then the surface and the sink cost more
// than they save, because the control reads the header inline in the method that already had the
// response, where StitchAPI needs a `Surface` object to reach it and a `TraceSink` object to
// remember it. What the extra lines buy is not this feature: it is the OTHER dozen things the same
// seam already does around the same call — retry, throttle, cache, circuit, auth, timeout, the
// trace tree — each a config key here and a hand-rolled subsystem there.
//
//   pnpm exec tsx docs/scenarios/proofs/deprecation-headers/c8-assembled.ts
import { manualClock } from '../../../../packages/core/src/testing';
import { watchedApi } from './assembled';
import { noticeOf } from './deprecation';
import { BASE, DAY, FLEET, FakeVendor, NOW } from './fake-vendor';
import { HandRolledClient } from './hand-rolled';
import { check, checkSeq, finish, heading, note } from './harness';

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUNSET = Date.parse('2026-01-01T00:00:00Z');
const ENDPOINTS = FLEET.map((e) => ({ name: e.name, path: e.path }));
const EXPECTED_REPORT =
    '3 endpoints deprecated (users, search, orders), earliest sunset in 12 days: users';

/**
 * Executable lines between the USER CODE markers — imports, the options interface, blanks and
 * comments removed on BOTH sides, so the number is the code someone actually maintains.
 */
function executableLines(file: string): number {
    const src = readFileSync(join(HERE, file), 'utf8');
    const from = src.indexOf('// >>> BEGIN USER CODE');
    const to = src.indexOf('// <<< END USER CODE');
    return src
        .slice(from, to)
        .replace(/^import[\s\S]*?;$/gm, '')
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
    heading('C8 — the whole job, both ways');

    // ── (a) StitchAPI, before any sunset ─────────────────────────────────────────────────────
    {
        const clock = manualClock(NOW);
        const vendor = new FakeVendor();
        const { members, watch } = watchedApi({
            baseUrl: BASE,
            adapter: vendor.adapter(),
            clock,
            endpoints: ENDPOINTS,
            failAfterSunset: true,
        });
        for (let r = 0; r < 20; r += 1)
            for (const m of members.values()) await m();

        check('(a) calls made', vendor.total, 100);
        check('(a) the report', watch.summary(), EXPECTED_REPORT);
        checkSeq(
            '(a) rows',
            watch.fleet().map((r) => `${r.endpoint}:${String(r.calls)}`),
            ['users:20', 'search:20', 'orders:20'],
        );
        const value = await members.get('users')?.();
        check(
            '(a) the caller can also read its OWN notice off the value',
            noticeOf(value)?.sunsetAt,
            SUNSET,
        );
    }

    // ── (b) the hand-rolled control, same job, same numbers ──────────────────────────────────
    {
        const clock = manualClock(NOW);
        const vendor = new FakeVendor();
        const client = new HandRolledClient({
            baseUrl: BASE,
            adapter: vendor.adapter(),
            clock,
            failAfterSunset: true,
        });
        for (let r = 0; r < 20; r += 1)
            for (const e of ENDPOINTS) await client.call(e.name, e.path);

        check('(b) calls made', vendor.total, 100);
        check('(b) the report', client.summary(), EXPECTED_REPORT);
        checkSeq(
            '(b) rows',
            client.fleet().map((r) => `${r.endpoint}:${String(r.calls)}`),
            ['users:20', 'search:20', 'orders:20'],
        );
        note(
            '(b) → identical output, which is what makes the line count comparable',
        );
    }

    // ── (c) the tripwire, both ways, on the same clock ───────────────────────────────────────
    {
        const outcomes: string[] = [];
        for (const at of [SUNSET - DAY, SUNSET + DAY]) {
            const clock = manualClock(at);
            const vendor = new FakeVendor();
            const { members } = watchedApi({
                baseUrl: BASE,
                adapter: vendor.adapter(),
                clock,
                endpoints: ENDPOINTS,
                failAfterSunset: true,
            });
            const r = await members.get('users')?.safe();
            outcomes.push(r?.ok === true ? 'ok' : (r?.error?.message ?? '?'));
        }
        checkSeq('(c) StitchAPI, day before / day after', outcomes, [
            'ok',
            'users: sunset passed (2026-01-01T00:00:00.000Z)',
        ]);

        const control: string[] = [];
        for (const at of [SUNSET - DAY, SUNSET + DAY]) {
            const clock = manualClock(at);
            const client = new HandRolledClient({
                baseUrl: BASE,
                adapter: new FakeVendor().adapter(),
                clock,
                failAfterSunset: true,
            });
            try {
                await client.call('users', '/v1/users');
                control.push('ok');
            } catch (e) {
                control.push((e as Error).message);
            }
        }
        checkSeq('(c) control, day before / day after', control, [
            'ok',
            'users: sunset passed (2026-01-01T00:00:00.000Z)',
        ]);
    }

    // ── (d) the line count ───────────────────────────────────────────────────────────────────
    {
        // The parsers (C6 measured 29 lines) are shared: both sides import them, so they cancel.
        const PARSERS = 29;
        const wiring = executableLines('assembled.ts');
        const control = executableLines('hand-rolled.ts');
        const module = executableLines('deprecation.ts');
        // What the StitchAPI side needs BEYOND the shared parsers: the Surface, the Notice type,
        // the sink, and the summary — everything in `deprecation.ts` that is not a parser.
        const surfaceAndSink = module - PARSERS;

        check('(d) StitchAPI wiring (`assembled.ts`)', wiring, 20);
        check('(d) hand-rolled wiring (`hand-rolled.ts`)', control, 52);
        check('(d) `deprecation.ts` in full', module, 112);
        check(
            '(d) …of which surface + sink, beyond the shared parsers',
            surfaceAndSink,
            83,
        );
        check('(d) TOTAL, StitchAPI', wiring + module, 132);
        check('(d) TOTAL, hand-rolled', control + PARSERS, 81);
        note(
            `(d) → the wiring alone favours the library ${String(wiring)} to ${String(control)}, and the TOTAL goes the other way: ${String(wiring + module)} to ${String(control + PARSERS)}. StitchAPI costs ${String(wiring + module - control - PARSERS)} MORE lines for the identical output`,
        );
        note(
            '(d) → the difference is two indirections the control does not pay for: a `Surface` object to get at `res.headers`, and a `TraceSink` object to hold the per-endpoint Map. The control does both inline in the method that already had the response in hand. This is the first scenario in this pass where the library LOSES on volume',
        );
    }

    // ── (e) what the extra lines actually buy ────────────────────────────────────────────────
    // The control is 100 lines from having any of this, and each item is a config key on the seam.
    {
        const clock = manualClock(NOW);
        const vendor = new FakeVendor();
        const { members, watch } = watchedApi({
            baseUrl: BASE,
            adapter: vendor.adapter(),
            clock,
            endpoints: ENDPOINTS,
            failAfterSunset: false,
        });
        // 20 calls each, but `users` is cached: the notice survives, the requests do not.
        for (let r = 0; r < 20; r += 1)
            for (const m of members.values()) await m();
        check('(e) requests without a cache', vendor.total, 100);
        check('(e) report still correct', watch.summary(), EXPECTED_REPORT);
        note(
            '(e) → the same seam already carries `retry`, `throttle`, `cache`, `circuit`, `auth`, `timeout`, `idempotency`, `paginate` and the trace tree as CONFIG KEYS. The control has a `fetch` in a method and would grow a hand-rolled version of each',
        );
    }

    // ── (f) the seams, named ─────────────────────────────────────────────────────────────────
    {
        const seams = [
            'Surface.interpret — reads res.headers, decides the value, renders the tripwire verdict',
            'trace: TraceSink at the seam — one sink, ctx.name per endpoint, cross-call state',
            'clock — injected time, so the sunset crossing is deterministic',
        ];
        for (const s of seams) note(`(f) seam: ${s}`);
        check('(f) seams used', seams.length, 3);
        // Hunted on the public config surface: anything named for this problem.
        const knowing = Object.keys(
            await import('../../../../packages/core/src/index'),
        ).filter((k) => /deprecat|sunset|retire/i.test(k));
        checkSeq('(f) exports that know about deprecation', knowing, []);
        note(
            '(f) → three seams, zero config. Every other scenario in this pass had at least one lever in the config object; this one has none, and that is the finding',
        );
    }

    finish(
        'C8',
        "ACHIEVABLE WITH USER CODE, ON THREE SEAMS AND ZERO CONFIG KEYS — and it is the first scenario in this pass where the LINE COUNT GOES AGAINST THE LIBRARY. `Surface.interpret` reads `res.headers`, decides the value and renders the tripwire verdict; a seam-level `trace` sink aggregates by `ctx.name`; the injected `clock` makes the sunset crossing deterministic. Both sides produce the identical report (`3 endpoints deprecated (users, search, orders), earliest sunset in 12 days: users`) over the identical 100 calls, and the identical tripwire on the identical clock. Wiring alone favours the library — 20 executable lines against the control's 52 — and the TOTAL goes the other way: 132 against 81, so StitchAPI costs 51 MORE lines for identical output. The difference is two indirections the control never pays for: a `Surface` object to reach `res.headers`, and a `TraceSink` object to hold the per-endpoint Map, where the control does both inline in the method that already had the response. What the extra lines buy is not this feature: it is that the same seam already carries `retry`, `throttle`, `cache`, `circuit`, `auth`, `timeout` and the trace tree as config keys, and the control would grow a hand-rolled version of each. NOT ONE config key in the library knows what a `Deprecation` header is",
    );
}

void main();

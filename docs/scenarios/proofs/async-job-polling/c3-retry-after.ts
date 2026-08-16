// C3 — can the poll wait come from the response's `Retry-After` HEADER? `retry.respect` honours it
// for STATUS-driven retries (engine.ts:744-756) and defaults to `true`. This measures whether
// anything honours it on the BODY-driven (`SurfaceOutcome.retry`) path a poll loop runs on — and
// what the fallback looks like when the server sends no header.
//
//   pnpm exec tsx docs/scenarios/proofs/async-job-polling/c3-retry-after.ts
import * as barrel from '../../../../packages/core/src/index';
import { stitch } from '../../../../packages/core/src/index';
import type { Surface } from '../../../../packages/core/src/surface';
import { manualClock } from '../../../../packages/core/src/testing';
import type { Clock } from '../../../../packages/core/src/types';
import { FakeJobApi, stateOf } from './fake-jobs';
import { check, finish, heading, note } from './harness';

/** Submit a job through a plain stitch and hand back its id. */
async function submitJob(api: FakeJobApi, clock: Clock): Promise<string> {
    const submit = stitch({
        url: FakeJobApi.submitUrl,
        method: 'POST',
        adapter: api.adapter(),
        clock,
    });
    await submit.safe({ body: {} });
    return api.jobIds.at(-1)!;
}

/**
 * A poll surface parameterised by how it derives `after` from the response. `undefined` means it
 * sets no `after` at all — the case that asks whether the ENGINE picks the header up.
 */
const pollWith = (
    after: (h: Record<string, string>) => number | string | undefined,
): Surface => ({
    id: 'job-poll',
    interpret: (res) => {
        if (stateOf(res.body) !== 'InProgress')
            return { ok: true, data: res.body };
        const wait = after(res.headers);
        return wait === undefined
            ? { ok: false, retry: true, message: 'InProgress' }
            : { ok: false, retry: true, message: 'InProgress', after: wait };
    },
});

async function main(): Promise<void> {
    heading('C3 — can the poll wait come from the `Retry-After` header?');

    // ── (a) `retry.respect` does NOT reach the body-driven path ───────────────────────────────
    // The status path reads `res.headers['retry-after']` (engine.ts:749-751). The body path four
    // lines below reads only `parseDuration(outcome.after)` (engine.ts:797-801). With the server
    // asking for 30s and a deliberately odd 7ms computed backoff, the measured gap says which ran.
    {
        const clock = manualClock();
        const api = new FakeJobApi({
            clock,
            inProgressPolls: 3,
            retryAfter: 30,
        });
        const id = await submitJob(api, clock);
        const poll = stitch({
            url: FakeJobApi.statusUrl(id),
            kind: pollWith(() => undefined),
            adapter: api.adapter(),
            clock,
            retry: {
                attempts: 6,
                respect: true,
                backoff: { curve: 'fixed', base: 7 },
            },
        });
        const p = poll.safe();
        await clock.advance(3_600_000);
        const r = await p;

        check('(a) the server asked for (s)', 30, 30);
        check('(a) polls made', api.polls(id).length, 4);
        check('(a) gaps (ms)', api.gaps(id).join(','), '7,7,7');
        check('(a) the call succeeded', r.ok, true);
        note(
            '(a) → `respect: true` is inert here; 7ms is the computed backoff, not the server’s 30s',
            '',
        );
    }

    // ── (b) the SURFACE can read the header itself — with the unit spelled out ────────────────
    // `interpret` gets the whole response, so `res.headers['retry-after']` is in reach. `after`
    // takes the house duration form (CONTRACT.md P17), so delta-SECONDS must be written `'30s'`.
    {
        const clock = manualClock();
        const api = new FakeJobApi({
            clock,
            inProgressPolls: 3,
            retryAfter: 30,
        });
        const id = await submitJob(api, clock);
        const poll = stitch({
            url: FakeJobApi.statusUrl(id),
            kind: pollWith((h) => {
                const raw = h['retry-after'];
                return raw === undefined ? undefined : `${raw}s`;
            }),
            adapter: api.adapter(),
            clock,
            retry: { attempts: 6, backoff: { curve: 'fixed', base: 7 } },
        });
        const p = poll.safe();
        await clock.advance(3_600_000);
        await p;
        check('(b) gaps (ms)', api.gaps(id).join(','), '30000,30000,30000');
    }

    // ── (c) THE UNIT TRAP: the raw header value is read as MILLISECONDS ───────────────────────
    // `after?: number | string` accepts `'30'`, and `parseDuration('30')` is 30ms. `Retry-After`
    // is delta-SECONDS. So the obvious spelling — hand the header straight through — polls a
    // thousand times faster than the server asked, and nothing warns.
    {
        const clock = manualClock();
        const api = new FakeJobApi({
            clock,
            inProgressPolls: 3,
            retryAfter: 30,
        });
        const id = await submitJob(api, clock);
        const poll = stitch({
            url: FakeJobApi.statusUrl(id),
            kind: pollWith((h) => h['retry-after']),
            adapter: api.adapter(),
            clock,
            retry: { attempts: 6, backoff: { curve: 'fixed', base: 7 } },
        });
        const p = poll.safe();
        await clock.advance(3_600_000);
        await p;
        check('(c) gaps (ms)', api.gaps(id).join(','), '30,30,30');
        check(
            '(c) how much faster than the server asked',
            30_000 / api.gaps(id)[0]!,
            1000,
        );
    }

    // ── (d) the HTTP-date form of `Retry-After` silently falls back to the backoff ────────────
    // RFC 9110 allows either delta-seconds or an HTTP-date. `parseDuration` cannot read a date, and
    // an unparseable `after` falls through to the computed curve (engine.ts:797-801) — no warning,
    // no drift finding. The engine's own `parseRetryAfter` handles both forms but is NOT exported.
    {
        const clock = manualClock();
        const api = new FakeJobApi({
            clock,
            inProgressPolls: 3,
            retryAfter: 'Thu, 01 Jan 1970 00:01:00 GMT',
        });
        const id = await submitJob(api, clock);
        const poll = stitch({
            url: FakeJobApi.statusUrl(id),
            kind: pollWith((h) => h['retry-after']),
            adapter: api.adapter(),
            clock,
            retry: { attempts: 6, backoff: { curve: 'fixed', base: 7 } },
        });
        const p = poll.safe();
        await clock.advance(3_600_000);
        await p;
        check('(d) gaps (ms)', api.gaps(id).join(','), '7,7,7');
        check(
            '(d) is `parseRetryAfter` on the public barrel?',
            'parseRetryAfter' in barrel,
            false,
        );
        note(
            '(d) → a surface author must re-implement RFC 9110 date parsing, or lose the server’s pacing silently',
            '',
        );
    }

    // ── (e) the fallback: a capped exponential when there is no header ────────────────────────
    // With no `Retry-After` the surface omits `after` and `backoff` shapes the curve. `curve: 'expo'`
    // (not the `'expo-jitter'` default) makes the doubling exact and the cap visible.
    {
        const clock = manualClock();
        const api = new FakeJobApi({ clock, inProgressPolls: 5 });
        const id = await submitJob(api, clock);
        const poll = stitch({
            url: FakeJobApi.statusUrl(id),
            kind: pollWith((h) => {
                const raw = h['retry-after'];
                return raw === undefined ? undefined : `${raw}s`;
            }),
            adapter: api.adapter(),
            clock,
            retry: {
                attempts: 8,
                backoff: { curve: 'expo', base: 1000, max: 5000 },
            },
        });
        const p = poll.safe();
        await clock.advance(3_600_000);
        await p;
        check(
            '(e) gaps (ms) — doubling, then clamped at `max`',
            api.gaps(id).join(','),
            '1000,2000,4000,5000,5000',
        );
        check('(e) polls made', api.polls(id).length, 6);
    }

    finish(
        'C3',
        "NOTHING honours `Retry-After` on the body-driven path — with `respect: true` and the server asking for 30s, the measured gaps were 7ms (the computed backoff). The surface must read the header itself, and `after: '${raw}s'` is the ONLY correct spelling: the naive `after: raw` reads delta-seconds as MILLISECONDS and polls 1000× faster than asked, while an HTTP-date `Retry-After` falls back to the computed curve silently (`parseRetryAfter` is not exported). The absent-header fallback is a real capped exponential: 1000, 2000, 4000, 5000, 5000",
    );
}

void main();

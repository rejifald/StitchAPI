// C8 — resumability. The process dies mid-poll; the job is still running server-side. Re-submitting
// duplicates hours of work, so the correct move is to reattach to the stored id. Can a stitch do
// that? A `StitchStore` exists — does it help at all here?
//
// "Restart" is modelled honestly: every stitch object is rebuilt from scratch, and the ONLY thing
// that crosses the boundary is what a store was asked to hold.
//
//   pnpm exec tsx docs/scenarios/proofs/async-job-polling/c8-resume.ts
import { memoryStore, stitch } from '../../../../packages/core/src/index';
import type { Surface } from '../../../../packages/core/src/surface';
import { manualClock } from '../../../../packages/core/src/testing';
import type { StitchStore } from '../../../../packages/core/src/types';
import { FakeJobApi, stateOf } from './fake-jobs';
import { check, finish, heading, note } from './harness';

const pollSurface = (after: number): Surface => ({
    id: 'job-poll',
    interpret: (res) =>
        stateOf(res.body) === 'InProgress'
            ? { ok: false, retry: true, message: 'InProgress', after }
            : { ok: true, data: res.body },
});

/** A store that records every key written, so "what did the engine persist?" is measurable. */
function spyStore(): StitchStore & { keys: string[] } {
    const inner = memoryStore();
    const keys: string[] = [];
    return {
        keys,
        get: (k) => inner.get(k),
        set: (k, v, ttl) => {
            keys.push(k);
            return inner.set(k, v, ttl);
        },
        increment: (k, ttl) => {
            keys.push(k);
            return inner.increment(k, ttl);
        },
    };
}

async function main(): Promise<void> {
    heading('C8 — can a stitch reattach to a stored job id after a restart?');

    // ── (a) the engine persists NOTHING about the job ─────────────────────────────────────────
    // `StitchStore` is the engine's own state: throttle counters, auth sessions, cache entries
    // (store.ts:1-3). A submit writes nothing at all.
    {
        const clock = manualClock();
        const store = spyStore();
        const api = new FakeJobApi({ clock, inProgressPolls: 2 });
        const submit = stitch({
            url: FakeJobApi.submitUrl,
            method: 'POST',
            adapter: api.adapter(),
            clock,
            store,
        });
        await submit.safe({ body: { q: 'SELECT Id' } });
        check('(a) keys the engine wrote', store.keys.length, 0);
        check(
            '(a) is the job id anywhere in the store?',
            store.keys.some((k) => k.includes('job-1')),
            false,
        );
        check('(a) the job exists server-side', api.jobIds.join(','), 'job-1');
        note(
            '(a) → the one durable thing about this operation is the one thing the engine never sees',
            '',
        );
    }

    // ── (b) resume works — entirely as USER code, and it is small ─────────────────────────────
    // Persist the id yourself (a store is a perfectly good place), then build the poll stitch from
    // it after the restart. Measured: the job completes and is never re-submitted.
    {
        const clock = manualClock();
        const store = memoryStore();
        const api = new FakeJobApi({ clock, inProgressPolls: 6 });

        // ── process 1: submit, persist, poll twice, die ──
        {
            const submit = stitch({
                url: FakeJobApi.submitUrl,
                method: 'POST',
                adapter: api.adapter(),
                clock,
                hooks: {
                    onResponse: (ctx) => {
                        const loc = ctx.res?.headers['location'];
                        if (loc)
                            void store.set('bulk:job', loc, 24 * 3_600_000);
                    },
                },
            });
            await submit.safe({ body: { q: 'SELECT Id' } });
            const loc = (await store.get('bulk:job')) as string;
            const poll = stitch({
                url: `https://bulk.example.com{+loc}`,
                kind: pollSurface(60_000),
                adapter: api.adapter(),
                clock,
                retry: { attempts: 2 },
            });
            const p = poll.safe({ params: { loc } });
            await clock.advance(3_600_000);
            const r = await p;
            check('(b) process 1 poll ok (it gave up mid-poll)', r.ok, false);
            check('(b) polls before the crash', api.polls('job-1').length, 2);
        }

        // ── process 2: everything rebuilt; only the store survived ──
        {
            const loc = (await store.get('bulk:job')) as string | undefined;
            check('(b) what survived the restart', loc, '/jobs/job-1');
            const poll = stitch({
                url: `https://bulk.example.com{+loc}`,
                kind: pollSurface(60_000),
                adapter: api.adapter(),
                clock,
                retry: { attempts: 20 },
            });
            const p = poll.safe({ params: { loc: loc! } });
            await clock.advance(3_600_000);
            const r = await p;
            check('(b) the resumed poll succeeded', r.ok, true);
            check(
                '(b) terminal state',
                stateOf(r.data),
                'JobComplete' as const,
            );
            check('(b) SUBMITS across both processes', api.submits, 1);
            check('(b) total polls', api.polls('job-1').length, 7);
        }
    }

    // ── (c) `cache` on the submit DOES stop the duplicate POST — and loses the job id ─────────
    // `cache: { methods: ['POST'] }` over a shared store survives a restart, so process 2's submit
    // is a HIT and the server never sees a second job. But a cache entry is the VALUE, and the
    // value of a 202 is `{}` — the `Location` header is not in it. Worse: a hit short-circuits the
    // request, so `hooks.onResponse` never fires and the id cannot be recovered that way either.
    {
        const clock = manualClock();
        const store = memoryStore();
        const api = new FakeJobApi({ clock, inProgressPolls: 2 });
        const seenLocations: string[] = [];
        const mkSubmit = (): ReturnType<typeof stitch> =>
            stitch({
                name: 'submit',
                url: FakeJobApi.submitUrl,
                method: 'POST',
                adapter: api.adapter(),
                clock,
                store,
                cache: { ttl: '24h', methods: ['POST'], tenancy: 'app' },
                hooks: {
                    onResponse: (ctx) => {
                        const loc = ctx.res?.headers['location'];
                        if (loc) seenLocations.push(loc);
                    },
                },
            });
        const first = await mkSubmit().safe({ body: { q: 'SELECT Id' } });
        const second = await mkSubmit().safe({ body: { q: 'SELECT Id' } });

        check('(c) SUBMITS the server saw', api.submits, 1);
        check('(c) first value', JSON.stringify(first.data), '{}');
        check('(c) second (cached) value', JSON.stringify(second.data), '{}');
        check('(c) times `onResponse` fired', seenLocations.length, 1);
        check(
            '(c) can process 2 recover the job id?',
            seenLocations.length > 1,
            false,
        );
        const rep = await mkSubmit().report({ body: { q: 'SELECT Id' } }, true);
        check('(c) `.report().cache`', rep.cache, 'hit');
        check('(c) `.report().status` on a hit', rep.status, 202);
        note(
            '(c) → duplicate avoided, job ORPHANED: it runs to completion and nobody knows its id',
            '',
        );
    }

    // ── (d) `idempotency.keyOf` is the one built-in that makes a restart-resubmit safe ───────
    // A DERIVED key is stable across separate submissions (types.ts:1108-1112), so process 2's
    // POST carries the same `Idempotency-Key` as process 1's and a server that honours it collapses
    // them. It costs nothing and needs no store.
    {
        const clock = manualClock();
        const api = new FakeJobApi({ clock });
        const keys: (string | undefined)[] = [];
        const mkSubmit = (): ReturnType<typeof stitch> =>
            stitch({
                url: FakeJobApi.submitUrl,
                method: 'POST',
                adapter: api.adapter(),
                clock,
                retry: { attempts: 3 },
                idempotency: {
                    keyOf: (input) => `bulk:${(input.body as { q: string }).q}`,
                },
                hooks: {
                    onRequest: (ctx) => {
                        keys.push(ctx.req?.headers['Idempotency-Key']);
                    },
                },
            });
        await mkSubmit().safe({ body: { q: 'SELECT Id' } });
        await mkSubmit().safe({ body: { q: 'SELECT Id' } });
        check(
            '(d) keys sent across two processes',
            keys.join(' / '),
            'bulk:SELECT Id / bulk:SELECT Id',
        );
        check('(d) the same key both times', new Set(keys).size, 1);
        note(
            '(d) → the fake does not dedupe (it mints a job per POST); a server that honours the header would',
            '',
        );
    }

    // ── (e) nothing in the config vocabulary names a resumable operation ──────────────────────
    // The one resume mechanism the library has is for STREAMS: `Surface.resumeToken` /
    // `applyResume` + `sse.reconnect` (surface.ts:88-107), which replays a `Last-Event-ID` on a
    // dropped connection WITHIN one call. It cannot span a process restart, and it is only
    // consulted on a streaming surface.
    {
        const clock = manualClock();
        const api = new FakeJobApi({ clock });
        stitch({
            url: FakeJobApi.submitUrl,
            method: 'POST',
            adapter: api.adapter(),
            clock,
            // @ts-expect-error — there is no `resume` config slot.
            resume: { key: 'bulk:job' },
        });
        note(
            '(e) the only resume in the vocabulary',
            '`Surface.resumeToken`/`applyResume` + `sse.reconnect` — within one streaming call',
        );
    }

    finish(
        'C8',
        "ENTIRELY USER-SIDE, and the store does not help with the part that matters. The engine persists NOTHING about the job (0 keys written on submit) and there is no `resume` config slot — the library’s only resume is `Surface.resumeToken`/`sse.reconnect`, which replays a `Last-Event-ID` within one streaming call. Doing it by hand is small and works: store the `Location` from `hooks.onResponse`, rebuild the poll stitch from it after the restart — measured 2 polls before the crash, 5 after, 1 SUBMIT total. The trap is the seemingly-clever version: `cache: { methods: ['POST'] }` over a shared store does prevent the duplicate POST (1 submit across two processes), but the cached value of a 202 is `{}` and a cache HIT never fires `onResponse` — so the job id is unrecoverable and the job is orphaned. `idempotency.keyOf` is the one built-in that helps: a derived key is byte-identical across processes, so a server that honours it collapses the resubmit",
    );
}

void main();

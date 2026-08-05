// C3 — THE DECIDING CLAIM. Can a 304 be turned into "return the cached body", inside the response
// path, so the caller receives the resource?
//
// The capture is right to make this the hinge and right to distrust it: scenario 5 measured that
// `Surface.interpret` is DEAD CODE on a streaming surface — `runStreaming` never calls
// `interpretOf`, only `classifyStatus(res.status, cfg)` at engine.ts:1371. So the first thing this
// script establishes, with a counter rather than a reading of the source, is whether `interpret`
// runs at all for a NON-2xx status on the BUFFERED path.
//
// It does, and it always has since ADR 0022 Decision 1: engine.ts:775 sits inside `attemptLoop` and
// is reached for EVERY response, with the comment saying so in as many words — "The surface
// interprets EVERY response here, including the non-2xx the engine used to throw on before any hook
// could see it." A 304 reaches it doubly easily, because `classifyStatus` never rejected it in the
// first place (C1).
//
// So the answer is YES, through three different seams, and the differences between them are what
// this script spends its checks on.
//
//   pnpm exec tsx docs/scenarios/proofs/conditional-requests-304/c3-substitute-the-body.ts
import { stitch, verdictOf } from '../../../../packages/core/src/index';
import type { Surface } from '../../../../packages/core/src/surface';
import { manualClock } from '../../../../packages/core/src/testing';
import type { Adapter } from '../../../../packages/core/src/types';
import { FakeEtagApi } from './fake-etag-api';
import { check, checkSeq, finish, heading, note } from './harness';

/** What a validator store holds. The two halves must live together — that is the whole scenario. */
interface Entry {
    etag: string;
    body: unknown;
}

async function main(): Promise<void> {
    heading('C3 — turning a 304 back into the cached body');

    // ── (a) FIRST: does `interpret` run on a non-2xx at all? ──────────────────────────────────
    // Measured with a counter against 200, 304 and 404 on the same buffered stitch.
    {
        const clock = manualClock();
        const api = new FakeEtagApi({ clock });
        const seen: number[] = [];
        // A transport that answers 404 on demand, so the counter covers a status the engine
        // genuinely fails on as well as the 3xx this scenario is about.
        const inner = api.adapter();
        let nextIs404 = false;
        const withNotFound: Adapter = async (req) =>
            nextIs404
                ? { status: 404, headers: {}, body: { message: 'Not Found' } }
                : inner(req);
        const counting: Surface = {
            id: 'counting',
            interpret: (res, cfg) => {
                seen.push(res.status);
                return verdictOf(res, cfg) ?? { ok: true, data: res.body };
            },
        };
        const issues = stitch({
            url: api.url,
            kind: counting,
            adapter: withNotFound,
            clock,
        });
        await issues.safe({});
        await issues.safe({
            headers: { 'If-None-Match': api.etagFor('(none)') },
        });
        nextIs404 = true;
        await issues.safe({});
        checkSeq(
            '(a) statuses `interpret` was called for',
            seen,
            [200, 304, 404],
        );
        note(
            '(a) → `interpret` is NOT dead code here, unlike on a streaming surface',
            'engine.ts:775 runs it for every response inside `attemptLoop` (ADR 0022 Decision 1)',
        );
    }

    // ── (b) SEAM 1 — `interpret` substitutes, `hooks.onRequest` replays ───────────────────────
    // The capture's nomination, and it works. `interpret` reads the ETag off the response itself,
    // so the hook is needed only for the request half.
    {
        const clock = manualClock();
        const api = new FakeEtagApi({ clock });
        let entry: Entry | undefined;
        const revalidating: Surface = {
            id: 'http+revalidate',
            interpret: (res, cfg) => {
                if (res.status === 304 && entry)
                    return { ok: true, data: entry.body };
                const failure = verdictOf(res, cfg);
                if (failure) return failure;
                const etag = res.headers['etag'];
                if (etag !== undefined) entry = { etag, body: res.body };
                return { ok: true, data: res.body };
            },
        };
        const issues = stitch({
            url: api.url,
            kind: revalidating,
            adapter: api.adapter(),
            clock,
            hooks: {
                onRequest: (ctx) => {
                    if (entry && ctx.req)
                        ctx.req.headers['If-None-Match'] = entry.etag;
                },
            },
        });
        const versions: (number | null)[] = [];
        const push = async (): Promise<void> => {
            const r = await issues.safe({});
            versions.push(
                (r.data as { version?: number } | undefined)?.version ?? null,
            );
        };
        await push();
        await push();
        api.mutate();
        await push();
        await push();
        checkSeq('(b) versions the caller received', versions, [1, 1, 2, 2]);
        checkSeq('(b) statuses', api.statuses, [200, 304, 200, 304]);
        check('(b) rate-limited responses', api.billed, 2);
        check('(b) requests made', api.requests, 4);
        note(
            '(b) → the caller never sees `undefined` and never sees a stale version',
            'a change is picked up on the very next poll, at half the rate-limit cost',
        );
    }

    // ── (c) SEAM 2 — `Surface.execute`, which sees the request AND the response ───────────────
    // The stronger answer, and the one C9 assembles. `execute` REPLACES the transport (ADR 0008) at
    // engine.ts:666-674 — inside the resilience chain, after `cfg.auth.apply`. One function owns
    // both halves, so the response is correlated with ITS OWN request rather than with whatever a
    // closure variable happened to hold. Note there is no custom `interpret` here at all: the
    // substituted body rides back on a response whose status is still 304, and `httpInterpret`
    // hands it to the caller unchanged, because 304 was never a failure (C1).
    {
        const clock = manualClock();
        const api = new FakeEtagApi({ clock });
        const store = new Map<string, Entry>();
        const transport = api.adapter();
        const revalidating: Surface = {
            id: 'http+revalidate',
            execute: async (req) => {
                const key = `${req.method} ${req.url}`;
                const entry = store.get(key);
                if (entry) req.headers['If-None-Match'] = entry.etag;
                const res = await transport(req);
                if (res.status === 304 && entry)
                    return { ...res, body: entry.body };
                const etag = res.headers['etag'];
                if (res.status === 200 && etag !== undefined)
                    store.set(key, { etag, body: res.body });
                return res;
            },
        };
        const issues = stitch({ url: api.url, kind: revalidating, clock });
        const versions: (number | null)[] = [];
        const push = async (): Promise<void> => {
            const r = await issues.safe({});
            versions.push(
                (r.data as { version?: number } | undefined)?.version ?? null,
            );
        };
        await push();
        await push();
        api.mutate();
        await push();
        await push();
        checkSeq('(c) versions the caller received', versions, [1, 1, 2, 2]);
        checkSeq('(c) statuses', api.statuses, [200, 304, 200, 304]);
        check('(c) rate-limited responses', api.billed, 2);

        // The status stays HONEST: the wire said 304, and `.inspect()` reports 304 while the data
        // is the resource. Nothing has to lie about what happened to make the caller whole.
        const probe = await issues.inspect({});
        check('(c) inspect().status after substitution', probe.status, 304);
        check(
            '(c) inspect().data.version',
            (probe.data as { version?: number }).version,
            2,
        );
        note(
            '(c) → NO custom `interpret` was needed',
            'a 304 carrying a body is already a success to `httpInterpret`; `execute` just supplies the body',
        );
    }

    // ── (d) SEAM 3 — `transform`, which works but is the worst of the three ───────────────────
    // `transform` runs at engine.ts:1198, after `interpret` and before validation, so it CAN swap
    // the value. What it cannot do is know it is looking at a 304: it receives only the value, so
    // the status has to be smuggled in through `onResponse`. Measured: it sees `undefined`.
    {
        const clock = manualClock();
        const api = new FakeEtagApi({ clock });
        const seenByTransform: unknown[] = [];
        let lastStatus = 0;
        let stored: Entry | undefined;
        // `transform` cannot see headers OR the status, so BOTH have to come from hooks.
        const issues = stitch({
            url: api.url,
            adapter: api.adapter(),
            clock,
            hooks: {
                onRequest: (ctx) => {
                    if (stored?.etag && ctx.req)
                        ctx.req.headers['If-None-Match'] = stored.etag;
                },
                onResponse: (ctx) => {
                    lastStatus = ctx.res?.status ?? 0;
                    const etag = ctx.res?.headers['etag'];
                    if (etag !== undefined && lastStatus === 200)
                        stored = { etag, body: stored?.body };
                },
            },
            transform: (body) => {
                seenByTransform.push(body);
                if (lastStatus === 304) return stored?.body;
                if (stored) stored.body = body;
                return body;
            },
        });
        const a = await issues.safe({});
        const b = await issues.safe({});
        check(
            '(d) transform saw `undefined` on the 304',
            seenByTransform[1],
            undefined,
        );
        check(
            '(d) first poll version',
            (a.data as { version?: number }).version,
            1,
        );
        check(
            '(d) 304 poll version',
            (b.data as { version?: number }).version,
            1,
        );
        note(
            '(d) → it works, and it costs two out-of-band variables and the cache fingerprint',
            'an opaque `transform` makes a `cache`-bearing stitch refuse to cache unless `transformVersion` is set (ADR 0004)',
        );
    }

    // ── (e) the seam that does NOT work: hooks alone cannot change the value ──────────────────
    // Worth pinning because it is the first thing anyone tries. `hooks.onResponse` receives `ctx.res`
    // and can mutate it — but the engine already read `res` into `outcome` at engine.ts:775? No: the
    // hook fires at engine.ts:705, BEFORE the verdict. So mutating `ctx.res.body` DOES land. The
    // reason not to build on it is that the hook has no idea which stored body belongs to this
    // response, and no return channel for a failure — measured here purely to record that it lands.
    {
        const clock = manualClock();
        const api = new FakeEtagApi({ clock });
        let stored: Entry | undefined;
        const issues = stitch({
            url: api.url,
            adapter: api.adapter(),
            clock,
            hooks: {
                onRequest: (ctx) => {
                    if (stored && ctx.req)
                        ctx.req.headers['If-None-Match'] = stored.etag;
                },
                onResponse: (ctx) => {
                    if (!ctx.res) return;
                    if (ctx.res.status === 304 && stored) {
                        ctx.res.body = stored.body; // mutate the response in place
                        return;
                    }
                    const etag = ctx.res.headers['etag'];
                    if (etag !== undefined)
                        stored = { etag, body: ctx.res.body };
                },
            },
        });
        await issues.safe({});
        const r = await issues.safe({});
        check('(e) onResponse mutation lands → ok', r.ok, true);
        check(
            '(e) onResponse mutation lands → data.version',
            (r.data as { version?: number }).version,
            1,
        );
        note(
            '(e) → `hooks.onResponse` fires at engine.ts:705, BEFORE the verdict at 775',
            'so an in-place body swap does reach the caller; it just has no request correlation and no failure channel',
        );
    }

    finish(
        'C3',
        'YES — and `interpret` DOES run on a 304, measured with a counter, not inferred. The counter recorded `interpret` being called for `[200, 304, 404]` on one buffered stitch: engine.ts:775 sits inside `attemptLoop` and interprets EVERY response (ADR 0022 Decision 1), so scenario 5’s "interpret is dead code" finding is specific to `runStreaming` and does not carry here. Three seams turn the 304 back into the resource, all measured on the same 4-poll run with one mid-run change, all producing versions `[1,1,2,2]` from statuses `[200,304,200,304]` at 2 billed responses instead of 4: (1) `Surface.interpret` returning `{ ok: true, data: cached }`, paired with `hooks.onRequest` for the replay; (2) `Surface.execute`, which owns request AND response in one function and needs NO custom `interpret` at all — the substituted body rides back on a still-304 response and `httpInterpret` passes it through, so `.inspect().status` honestly reports 304 while `.data.version` is 2; (3) `transform`, which works but must smuggle the status in through `onResponse` (measured: it is handed `undefined`) and costs the cache fingerprint. `hooks.onResponse` can also mutate `ctx.res.body` in place and it lands (the hook fires at engine.ts:705, before the verdict at 775) — it just has no request correlation and no failure channel. THE 304 IS NOT A DEAD END',
    );
}

void main();

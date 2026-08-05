// C2 — can the ETag be read off a response and replayed as `If-None-Match` on the next request?
//
// Three seams can set an outgoing header, and they are NOT interchangeable. The difference that
// matters is WHEN each one runs, and it is measurable rather than arguable:
//
//   • `hooks.onRequest`      — engine.ts:652, once per ATTEMPT, AFTER `cfg.auth.apply` (engine.ts:649)
//   • `Surface.buildRequest` — engine.ts:253, once per RUN, BEFORE auth and before the attempt loop
//   • `Surface.execute`      — engine.ts:666-674, once per ATTEMPT, AFTER auth, and it also sees the
//                              response, which is the only way to correlate the two (C9)
//
// The read side has one more seam than the capture supposes: `Surface.interpret` receives the whole
// `AdapterResponse`, headers included, so the ETag does NOT have to come out through `onResponse`.
//
//   pnpm exec tsx docs/scenarios/proofs/conditional-requests-304/c2-replay-the-validator.ts
import { stitch, verdictOf } from '../../../../packages/core/src/index';
import type { Surface } from '../../../../packages/core/src/surface';
import { manualClock } from '../../../../packages/core/src/testing';
import { FakeEtagApi } from './fake-etag-api';
import { check, checkSeq, finish, heading, note } from './harness';

async function main(): Promise<void> {
    heading('C2 — reading the ETag out, and putting `If-None-Match` back in');

    // ── (a) hooks.onResponse reads it, hooks.onRequest replays it ─────────────────────────────
    {
        const clock = manualClock();
        const api = new FakeEtagApi({ clock });
        let stored: string | undefined;
        const issues = stitch({
            url: api.url,
            adapter: api.adapter(),
            clock,
            hooks: {
                onRequest: (ctx) => {
                    if (stored !== undefined && ctx.req)
                        ctx.req.headers['If-None-Match'] = stored;
                },
                onResponse: (ctx) => {
                    const etag = ctx.res?.headers['etag'];
                    if (etag !== undefined) stored = etag;
                },
            },
        });
        await issues.safe({});
        await issues.safe({});
        await issues.safe({});
        checkSeq('(a) `If-None-Match` on the wire', api.validators, [
            '(none)',
            '"v1.t1"',
            '"v1.t1"',
        ]);
        checkSeq('(a) statuses', api.statuses, [200, 304, 304]);
        check('(a) rate-limited responses', api.billed, 1);
        note(
            '(a) → the REQUEST half works exactly as hoped',
            'the header goes out byte-for-byte and the server answers 304',
        );
    }

    // ── (b) …but the DATA is still gone ───────────────────────────────────────────────────────
    // Replaying the validator is the cheap half. The result of doing so, with hooks alone, is that
    // the caller now receives `undefined` on 2 of 3 polls instead of 0 of 3 — strictly worse than
    // not conditionalising at all, unless something substitutes the body (C3).
    {
        const clock = manualClock();
        const api = new FakeEtagApi({ clock });
        let stored: string | undefined;
        const issues = stitch({
            url: api.url,
            adapter: api.adapter(),
            clock,
            hooks: {
                onRequest: (ctx) => {
                    if (stored !== undefined && ctx.req)
                        ctx.req.headers['If-None-Match'] = stored;
                },
                onResponse: (ctx) => {
                    const etag = ctx.res?.headers['etag'];
                    if (etag !== undefined) stored = etag;
                },
            },
        });
        const versions = [
            (await issues.safe({})).data,
            (await issues.safe({})).data,
            (await issues.safe({})).data,
        ].map((d) => (d as { version?: number } | undefined)?.version ?? null);
        checkSeq('(b) versions the caller received', versions, [1, null, null]);
        note(
            '(b) → hooks alone make the poll CHEAPER and the answer EMPTY',
            'the request half is free; the response half is the whole problem (C3)',
        );
    }

    // ── (c) `Surface.interpret` can read the ETag itself — `onResponse` is not required ───────
    // The capture asks whether the ETag is readable "off the previous response (`hooks.onResponse`?
    // `interpret`?)". Both. `interpret` gets the full `AdapterResponse`.
    {
        const clock = manualClock();
        const api = new FakeEtagApi({ clock });
        const seenByInterpret: (string | undefined)[] = [];
        let stored: string | undefined;
        const reader: Surface = {
            id: 'etag-reader',
            interpret: (res, cfg) => {
                seenByInterpret.push(res.headers['etag']);
                if (res.status === 200) stored = res.headers['etag'];
                return verdictOf(res, cfg) ?? { ok: true, data: res.body };
            },
        };
        const issues = stitch({
            url: api.url,
            kind: reader,
            adapter: api.adapter(),
            clock,
            hooks: {
                onRequest: (ctx) => {
                    if (stored !== undefined && ctx.req)
                        ctx.req.headers['If-None-Match'] = stored;
                },
            },
        });
        await issues.safe({});
        await issues.safe({});
        checkSeq('(c) ETags visible to `interpret`', seenByInterpret, [
            '"v1.t1"',
            '"v1.t1"',
        ]);
        checkSeq('(c) `If-None-Match` on the wire', api.validators, [
            '(none)',
            '"v1.t1"',
        ]);
        note(
            '(c) → `interpret` sees response HEADERS, not just the body',
            'so the store-write and the body-substitution can live in one function (C3)',
        );
    }

    // ── (d) `Surface.buildRequest` also sets it — but only ONCE PER RUN ───────────────────────
    // Same wire result on a happy path. The difference shows up under retry: `buildRequest` runs at
    // engine.ts:253, before `attemptLoop`, and every attempt is a `cloneReq(baseReq)` of that one
    // request. A validator baked in here can never be dropped mid-run. Measured against a stitch
    // whose `interpret` asks for a re-attempt (`{ ok: false, retry: true }`, ADR 0022 Decision 5):
    // all 3 attempts carry the SAME validator.
    {
        const clock = manualClock();
        const api = new FakeEtagApi({ clock });
        // Start with a validator already in hand but no body — the "orphan validator" case.
        let stored: string | undefined = api.etagFor('(none)');
        const baked: Surface = {
            id: 'bake-once',
            buildRequest: (_cfg, _input, base) =>
                stored === undefined
                    ? base
                    : {
                          ...base,
                          headers: { ...base.headers, 'If-None-Match': stored },
                      },
            interpret: (res, cfg) => {
                if (res.status === 304) {
                    stored = undefined; // "drop it and refetch" — has no effect on this run
                    return {
                        ok: false,
                        retry: true,
                        message: '304 with no cached body',
                    };
                }
                return verdictOf(res, cfg) ?? { ok: true, data: res.body };
            },
        };
        const issues = stitch({
            url: api.url,
            kind: baked,
            adapter: api.adapter(),
            clock,
            retry: { attempts: 3, backoff: { curve: 'fixed', base: 0 } },
        });
        const pending = issues.safe({});
        await clock.advance(10_000);
        const r = await pending;
        checkSeq(
            '(d) `buildRequest` validator across 3 attempts',
            api.validators,
            ['"v1.t1"', '"v1.t1"', '"v1.t1"'],
        );
        check('(d) run ok', r.ok, false);
        check('(d) error', r.error?.message, '304 with no cached body');
    }

    // ── (e) …whereas `hooks.onRequest` runs PER ATTEMPT and CAN drop it ───────────────────────
    // Identical surface logic, header moved to the hook: attempt 1 sends the orphan validator, gets
    // a 304, `interpret` asks for a re-attempt, and attempt 2 goes out UNCONDITIONAL and succeeds.
    {
        const clock = manualClock();
        const api = new FakeEtagApi({ clock });
        let stored: string | undefined = api.etagFor('(none)');
        let cached: unknown;
        const perAttempt: Surface = {
            id: 'per-attempt',
            interpret: (res, cfg) => {
                if (res.status === 304) {
                    if (cached !== undefined) return { ok: true, data: cached };
                    stored = undefined;
                    return {
                        ok: false,
                        retry: true,
                        message: '304 with no cached body',
                    };
                }
                const failure = verdictOf(res, cfg);
                if (failure) return failure;
                stored = res.headers['etag'];
                cached = res.body;
                return { ok: true, data: res.body };
            },
        };
        const issues = stitch({
            url: api.url,
            kind: perAttempt,
            adapter: api.adapter(),
            clock,
            retry: { attempts: 2, backoff: { curve: 'fixed', base: 0 } },
            hooks: {
                onRequest: (ctx) => {
                    if (!ctx.req) return;
                    if (stored !== undefined)
                        ctx.req.headers['If-None-Match'] = stored;
                    else delete ctx.req.headers['If-None-Match'];
                },
            },
        });
        const pending = issues.safe({});
        await clock.advance(10_000);
        const r = await pending;
        checkSeq('(e) validators across 2 attempts', api.validators, [
            '"v1.t1"',
            '(none)',
        ]);
        checkSeq('(e) statuses', api.statuses, [304, 200]);
        check('(e) run ok', r.ok, true);
        check('(e) data.version', (r.data as { version?: number }).version, 1);
        note(
            '(e) → an orphan validator is RECOVERABLE only from the per-attempt seam',
            'the identical logic behind `buildRequest` (case d) loops on the same 304 until the budget is gone',
        );
    }

    finish(
        'C2',
        'YES on both halves, and the seams are not interchangeable. `hooks.onRequest` puts `If-None-Match` on the wire byte-for-byte (measured `["(none)","\\"v1.t1\\"","\\"v1.t1\\""]` → statuses `[200,304,304]`, 1 billed response out of 3), and the ETag is readable from `hooks.onResponse` — but ALSO from `Surface.interpret`, which the capture treats as an open question: `interpret` receives the whole `AdapterResponse`, so `res.headers["etag"]` is right there (measured `["\\"v1.t1\\"","\\"v1.t1\\""]`). The ordering finding is the one worth carrying: `Surface.buildRequest` runs ONCE PER RUN (engine.ts:253, before `attemptLoop`), so a validator set there is baked into every `cloneReq` — measured 3 identical validators across 3 attempts and a run that fails — while `hooks.onRequest` runs ONCE PER ATTEMPT (engine.ts:652) and can DROP the header on a re-attempt, measured `["\\"v1.t1\\"","(none)"]` → `[304,200]` → `ok: true`. Replaying the validator alone still leaves the caller with `undefined` on every unchanged poll (measured versions `[1,null,null]`), which is C3',
    );
}

void main();

// C1 — what does a BARE stitch do with a `304 Not Modified`?
//
// The capture frames this as a fork: "treat it as a failure and every unchanged poll is an error;
// treat it as a success and the caller receives `undefined`". StitchAPI takes the second fork, and
// it takes it silently — because a 304 is not an error by any measure the engine applies.
// `classifyStatus` (surface.ts:143-149) fails a response only when `status >= 400`, so a 304 is
// "acceptable transport" exactly like a 200, and `httpInterpret` (surface.ts:234-237) then returns
// `{ ok: true, data: res.body }` where `res.body` is whatever an empty body decoded to.
//
// That last part is measured through the REAL `fetchAdapter` with an injected `fetch`, not asserted
// from the fake: a zero-byte JSON response decodes to `undefined` (http-adapter.ts:135) and a
// zero-byte response with no `content-type` decodes to `''` (http-adapter.ts:137). Neither is the
// resource, and neither is an error.
//
//   pnpm exec tsx docs/scenarios/proofs/conditional-requests-304/c1-bare-304.ts
import { fetchAdapter, stitch } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import { FakeEtagApi } from './fake-etag-api';
import { check, checkSeq, finish, heading, note } from './harness';

async function main(): Promise<void> {
    heading('C1 — a bare stitch meets a 304');

    // ── (a) the fork: success or failure? ─────────────────────────────────────────────────────
    {
        const clock = manualClock();
        const api = new FakeEtagApi({ clock });
        const issues = stitch({ url: api.url, adapter: api.adapter(), clock });

        const first = await issues.safe({});
        check('(a) plain GET → ok', first.ok, true);
        check(
            '(a) plain GET → data.version',
            (first.data as { version?: number }).version,
            1,
        );

        // Replay the validator the server just minted. This is the shape every subsequent poll has.
        const inm = { 'If-None-Match': api.etagFor('(none)') };
        const second = await issues.safe({ headers: inm });
        check('(a) 304 → ok', second.ok, true);
        check('(a) 304 → data', second.data, undefined);
        check('(a) 304 → error', second.error, null);
        checkSeq('(a) server saw', api.statuses, [200, 304]);
        note(
            '(a) → the fork is resolved as SUCCESS-WITH-NOTHING',
            'not an error, not the resource — `ok: true` carrying `undefined`',
        );
    }

    // ── (b) the awaited path does not throw either ────────────────────────────────────────────
    // `await stitch(...)` throws a StitchError on failure, so if a 304 were a failure this is where
    // it would surface. It resolves.
    {
        const clock = manualClock();
        const api = new FakeEtagApi({ clock });
        const issues = stitch({ url: api.url, adapter: api.adapter(), clock });
        await issues.safe({});
        let threw = '';
        let resolved: unknown = 'NOT REACHED';
        try {
            resolved = await issues({
                headers: { 'If-None-Match': api.etagFor('(none)') },
            });
        } catch (e) {
            threw = (e as Error).message;
        }
        check('(b) await threw', threw, '');
        check('(b) await resolved with', resolved, undefined);
        note(
            '(b) → a polling loop written as `const data = await issues()` gets `undefined`',
            'and every downstream read of it is a TypeError far from the cause',
        );
    }

    // ── (c) `.inspect()` — the accessor whose job is "what did the server send?" ──────────────
    {
        const clock = manualClock();
        const api = new FakeEtagApi({ clock });
        const issues = stitch({ url: api.url, adapter: api.adapter(), clock });
        await issues.safe({});
        const probe = await issues.inspect({
            headers: { 'If-None-Match': api.etagFor('(none)') },
        });
        check('(c) inspect().status', probe.status, 304);
        check('(c) inspect().data', probe.data, undefined);
        check('(c) inspect().raw', probe.raw, null);
        note(
            '(c) → the STATUS is the only place a 304 is visible',
            '`.inspect().status === 304` is the one signal a caller can branch on',
        );
    }

    // ── (d) `verdict.accept: [304]` is a no-op, because 304 was never rejected ────────────────
    // The natural first guess — "declare 304 acceptable" — changes nothing: `acceptsStatus` is only
    // consulted for `status >= 400` (surface.ts:147).
    {
        const clock = manualClock();
        const api = new FakeEtagApi({ clock });
        const issues = stitch({
            url: api.url,
            adapter: api.adapter(),
            clock,
            verdict: { accept: [304] },
        });
        await issues.safe({});
        const r = await issues.safe({
            headers: { 'If-None-Match': api.etagFor('(none)') },
        });
        check('(d) verdict.accept: [304] → ok', r.ok, true);
        check('(d) verdict.accept: [304] → data', r.data, undefined);
    }

    // ── (e) what an empty body ACTUALLY decodes to, through the real adapter ──────────────────
    // Injected `fetch`, no network. Both 304 shapes GitHub and friends send are covered.
    {
        const jsonCt = await fetchAdapter({
            fetch: async () =>
                new Response(null, {
                    status: 304,
                    headers: {
                        etag: '"v1"',
                        'content-type': 'application/json; charset=utf-8',
                    },
                }),
        })({
            url: 'https://api.github.example/repos/octo/hello/issues',
            method: 'GET',
            headers: {},
        });
        check('(e) real fetchAdapter → status', jsonCt.status, 304);
        check('(e) real fetchAdapter → body (json ct)', jsonCt.body, undefined);
        check(
            '(e) real fetchAdapter → etag survives',
            jsonCt.headers['etag'],
            '"v1"',
        );

        const noCt = await fetchAdapter({
            fetch: async () =>
                new Response(null, { status: 304, headers: { etag: '"v1"' } }),
        })({
            url: 'https://api.github.example/repos/octo/hello/issues',
            method: 'GET',
            headers: {},
        });
        check('(e) real fetchAdapter → body (no ct)', noCt.body, '');
        note(
            '(e) → the empty body is `undefined` or `""` depending on `content-type`',
            'so a caller cannot even rely on one falsy shape; the ETag header, though, always survives',
        );
    }

    finish(
        'C1',
        'a 304 is a SILENT SUCCESS CARRYING NOTHING. Measured: `ok: true`, `data: undefined`, `error: null`, and the awaited form resolves rather than throwing (`await issues()` → `undefined`). It is not a policy the engine chose for 304s — `classifyStatus` (surface.ts:143-149) only fails `status >= 400`, so a 304 is transport-healthy exactly like a 200, and `httpInterpret` (surface.ts:237) hands back `res.body` unexamined. `verdict.accept: [304]` is therefore a no-op (measured: still `ok: true`, `data: undefined`) because nothing rejected it. Through the REAL `fetchAdapter` with an injected `fetch`, the empty body decodes to `undefined` with a JSON `content-type` (http-adapter.ts:135) and to `""` without one (http-adapter.ts:137) — two different falsy values, neither of them the resource. The one place the 304 remains visible is `.inspect().status`, measured 304 with `data: undefined` and `raw: null`',
    );
}

void main();

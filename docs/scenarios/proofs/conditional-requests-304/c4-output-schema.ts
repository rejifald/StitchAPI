// C4 — does an `output` schema reject a 304's empty body, and can the SUBSTITUTED body be validated
// instead? The capture's worry is that "the substitution has to happen below whatever parses/
// validates the response", which in most clients it cannot.
//
// Here it can, and the ordering is not a coincidence — it is the run pipeline, in one place:
//
//   interpret (engine.ts:775) → transform (1198) → pick (1199) → validateOutput (1203)
//
// Substitution happens at step 1. Validation happens at step 4, on whatever step 1 produced. So an
// `output` contract sees the CACHED body and never sees the 304's `undefined` at all.
//
// The claim has a sharp edge worth measuring in both directions: without the substitution, the
// contract turns every unchanged poll into a hard failure, which is strictly worse than C1's silent
// `undefined` — a polling loop that "worked" starts erroring the moment someone adds a schema.
//
//   pnpm exec tsx docs/scenarios/proofs/conditional-requests-304/c4-output-schema.ts
import { stitch, verdictOf } from '../../../../packages/core/src/index';
import type { StandardSchemaV1 } from '../../../../packages/core/src/standard-schema';
import type { Surface } from '../../../../packages/core/src/surface';
import { manualClock } from '../../../../packages/core/src/testing';
import { FakeEtagApi } from './fake-etag-api';
import { check, checkSeq, finish, heading, note } from './harness';

/** Every value this schema is asked about, in order — so "what did validation actually see?" is
 *  a measurement rather than an inference. */
const validated: unknown[] = [];

/** A Standard Schema that requires the issues payload's shape. */
const issuesSchema: StandardSchemaV1 = {
    '~standard': {
        version: 1,
        vendor: 'conditional-requests-304-proof',
        validate: (value: unknown) => {
            validated.push(value);
            const v = value as { repo?: unknown } | null | undefined;
            if (v == null || typeof v !== 'object')
                return {
                    issues: [
                        {
                            message: `expected the issues payload, got ${String(value)}`,
                        },
                    ],
                };
            if (typeof v.repo !== 'string')
                return { issues: [{ message: '`repo` must be a string' }] };
            return { value };
        },
    },
};

async function main(): Promise<void> {
    heading('C4 — an `output` contract meets a 304');

    // ── (a) bare stitch + `output`: the 304 is a HARD FAILURE ─────────────────────────────────
    {
        validated.length = 0;
        const clock = manualClock();
        const api = new FakeEtagApi({ clock });
        const issues = stitch({
            url: api.url,
            adapter: api.adapter(),
            clock,
            output: issuesSchema,
        });
        const first = await issues.safe({});
        check('(a) plain GET → ok', first.ok, true);

        const r = await issues.safe({
            headers: { 'If-None-Match': api.etagFor('(none)') },
        });
        check('(a) 304 → ok', r.ok, false);
        check(
            '(a) 304 → error.message',
            r.error?.message,
            'contract violation (drift)',
        );
        check('(a) 304 → data', r.data, null);
        check('(a) value the schema was handed', validated[1], undefined);

        const report = await issues.report({
            headers: { 'If-None-Match': api.etagFor('(none)') },
        });
        check('(a) drift findings', report.findings.length, 1);
        check('(a) finding.level', report.findings[0]?.level, 'error');
        note('(a) finding.detail', report.findings[0]?.detail ?? '(none)');
        note(
            '(a) → adding a schema to a working conditional poll BREAKS it',
            'C1 gave `ok: true, data: undefined`; `output` turns the same 304 into `ok: false`',
        );
    }

    // ── (b) with substitution: validation runs on the SUBSTITUTED body ────────────────────────
    // Same schema, same server, same 304 — but `interpret` supplied the cached body first.
    {
        validated.length = 0;
        const clock = manualClock();
        const api = new FakeEtagApi({ clock });
        let entry: { etag: string; body: unknown } | undefined;
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
            output: issuesSchema,
            hooks: {
                onRequest: (ctx) => {
                    if (entry && ctx.req)
                        ctx.req.headers['If-None-Match'] = entry.etag;
                },
            },
        });
        await issues.safe({});
        const r = await issues.safe({});
        check('(b) 304 → ok', r.ok, true);
        check(
            '(b) 304 → data.version',
            (r.data as { version?: number }).version,
            1,
        );
        check('(b) times the schema ran', validated.length, 2);
        checkSeq(
            '(b) values the schema saw',
            validated.map(
                (v) => (v as { version?: number } | undefined)?.version ?? null,
            ),
            [1, 1],
        );
        checkSeq('(b) statuses on the wire', api.statuses, [200, 304]);
        note(
            '(b) → the contract never sees `undefined`',
            'substitution at engine.ts:775 is upstream of validation at engine.ts:1203',
        );
    }

    // ── (c) the contract still BITES on the substituted value ─────────────────────────────────
    // Substitution is not a bypass: a schema that rejects the cached body fails the run, so a store
    // holding a value that no longer satisfies the contract is caught rather than served.
    {
        validated.length = 0;
        const clock = manualClock();
        const api = new FakeEtagApi({ clock });
        // A store pre-seeded with a value that does NOT match the schema — the shape a persisted
        // cache written by an older version of the code would have.
        let entry: { etag: string; body: unknown } | undefined;
        const revalidating: Surface = {
            id: 'http+revalidate',
            interpret: (res, cfg) => {
                if (res.status === 304 && entry)
                    return { ok: true, data: entry.body };
                const failure = verdictOf(res, cfg);
                if (failure) return failure;
                const etag = res.headers['etag'];
                if (etag !== undefined)
                    entry = { etag, body: { stale: 'shape' } };
                return { ok: true, data: res.body };
            },
        };
        const issues = stitch({
            url: api.url,
            kind: revalidating,
            adapter: api.adapter(),
            clock,
            output: issuesSchema,
            hooks: {
                onRequest: (ctx) => {
                    if (entry && ctx.req)
                        ctx.req.headers['If-None-Match'] = entry.etag;
                },
            },
        });
        await issues.safe({});
        const r = await issues.safe({});
        check('(c) stale-shaped cached body → ok', r.ok, false);
        check(
            '(c) error.message',
            r.error?.message,
            'contract violation (drift)',
        );
        note(
            '(c) → the contract is enforced on the value the CALLER receives',
            'not on the bytes the server sent, which is the right place for it',
        );
    }

    // ── (d) `pick` runs on the substituted value too ──────────────────────────────────────────
    // Same pipeline position (engine.ts:1199). Worth pinning because `pick` on a bare 304's
    // `undefined` silently yields `undefined` rather than erroring.
    {
        validated.length = 0;
        const clock = manualClock();
        const api = new FakeEtagApi({ clock });
        let entry: { etag: string; body: unknown } | undefined;
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
        const picked = stitch({
            url: api.url,
            kind: revalidating,
            adapter: api.adapter(),
            clock,
            pick: 'issues',
            hooks: {
                onRequest: (ctx) => {
                    if (entry && ctx.req)
                        ctx.req.headers['If-None-Match'] = entry.etag;
                },
            },
        });
        await picked.safe({});
        const r = await picked.safe({});
        check('(d) pick on the substituted body → ok', r.ok, true);
        check('(d) picked length', (r.data as unknown[]).length, 1);

        const bare = stitch({
            url: api.url,
            adapter: api.adapter(),
            clock,
            pick: 'issues',
        });
        const b = await bare.safe({
            headers: { 'If-None-Match': api.etagFor('(none)') },
        });
        check('(d) pick on a bare 304 → ok', b.ok, true);
        check('(d) pick on a bare 304 → data', b.data, undefined);
    }

    finish(
        'C4',
        'YES to both halves, and the ordering is the finding. A bare `output` schema turns every unchanged poll into a HARD FAILURE — measured `ok: false`, `error.message` `contract violation (drift)`, `data: null`, one `error`-level finding reading "expected the issues payload, got undefined" — which is strictly worse than C1’s silent `undefined`, because adding a schema to a working conditional poll is what breaks it. With substitution in place the contract never sees the empty body at all: the pipeline is `interpret` (engine.ts:775) → `transform` (1198) → `pick` (1199) → `validateOutput` (1203), so validation runs on whatever `interpret` returned. Measured on a 200-then-304 pair: the schema ran twice and was handed version `[1, 1]` — never `undefined` — and the 304 poll resolved `ok: true` with `data.version: 1`. Substitution is not a bypass either: a store holding a value the schema rejects still fails the run (measured `ok: false`, same drift message), so the contract is enforced on the value the CALLER receives. `pick` sits at the same pipeline position and behaves the same way — measured 1 item off the substituted body, versus `undefined` off a bare 304',
    );
}

void main();

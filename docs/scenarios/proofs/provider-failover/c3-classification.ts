// C3 — classification. The consensus rule is that `429`/`5xx` are availability errors (fail over)
// and a `400` is your payload (stop the chain, because the next provider will reject it
// identically). So: can failover be made to trigger on one and not the other, and what does the
// caller actually receive when the primary returns a 400?
//
// The capture predicts "neither classifies, and a 400 surfaces as an AggregateError rather than the
// actionable error". Confirmed, and sharper than that in both directions:
//
//   • WORSE than predicted: the AggregateError has `status === undefined` and `body === undefined`.
//     Every caller-facing field the engine populates on a `StitchError` — status, response body,
//     url, attempts — is DROPPED at the combinator boundary. The actionable 400 is reachable only
//     by knowing to reach into `.errors[0]`, which is not a `StitchError` API, it is a JS builtin.
//   • BETTER than predicted, in one narrow spot: `race` DOES surface the actionable error, because
//     the first settle is the primary's rejection. It just is not failover — it never tries the
//     backup at all.
//
// And the 400 costs two bills: the backup received the identical malformed payload and 400'd on it.
//
//   pnpm exec tsx docs/scenarios/proofs/provider-failover/c3-classification.ts
import { any, linked, race } from '../../../../packages/core/src/pipe';
import type { StitchError } from '../../../../packages/core/src/types';
import { hits, outcomeOf } from './fake-provider';
import { check, checkSeq, finish, heading, note } from './harness';
import { rig } from './providers';
import { accepted, probeSpellings, rejected } from './type-probe';

/** A malformed payload 400s at BOTH providers — which is the entire reason a 400 must not fail over. */
function bothReject400() {
    const r = rig();
    r.p.primary.respond(400);
    r.p.backup.respond(400);
    return r;
}

async function main(): Promise<void> {
    heading('C3 — does a 400 stop the chain, and does the caller see it?');

    // ── (a) `any` on a 400: both providers billed, and the error is an aggregate ────────────────
    {
        const { p, primary, backup } = bothReject400();
        const r = await any(
            primary,
            backup,
        )({
            body: { prompt: null },
        }).then(
            () => ({ ok: true as const, err: undefined }),
            (e: unknown) => ({ ok: false as const, err: e as AggregateError }),
        );

        check('(a) call succeeded?', r.ok, false);
        check('(a) error name', r.err?.name, 'AggregateError');
        checkSeq('(a) [primary, backup] requests', hits(p), [1, 1]);
        check(
            '(a) providers that 400d on the same bad payload',
            p.primary.calls.filter((c) => c.status === 400).length +
                p.backup.calls.filter((c) => c.status === 400).length,
            2,
        );
        note(
            '(a) → one malformed payload became two bad requests and two bills',
            'and `any` "waits past failures for a success" (pipe.ts:294-297), so it waits for the backup to reject the same payload before it gives up',
        );
    }

    // ── (b) what the aggregate DROPS ───────────────────────────────────────────────────────────
    // The measurement that makes this a finding rather than a style complaint.
    {
        const { primary, backup } = bothReject400();
        const err = (await any(
            primary,
            backup,
        )({ body: { prompt: null } }).then(
            () => undefined,
            (e: unknown) =>
                e as AggregateError & { status?: number; body?: unknown },
        ))!;

        check('(b) aggregate.status', err.status, undefined);
        check('(b) aggregate.body', err.body, undefined);
        check(
            '(b) aggregate.message',
            err.message,
            'All promises were rejected',
        );
        check('(b) aggregate.errors.length', err.errors.length, 2);

        // The actionable error IS in there — one `.errors[0]` away, and nothing in the type says so.
        const first = err.errors[0] as StitchError;
        check('(b) errors[0].name', first.name, 'StitchError');
        check('(b) errors[0].status', first.status, 400);
        check(
            '(b) errors[0].body.error.code',
            (first.body as { error: { code: string } }).error.code,
            'invalid_request',
        );
        note(
            '(b) → every field a caller routes on is dropped at the combinator boundary',
            '`StitchError` carries status/body/url/attempts (types.ts:1657-1691); `Promise.any` (pipe.ts:152) rejects with a plain `AggregateError` that carries none of them, so a catch block written against `err.status` silently sees `undefined`',
        );
    }

    // ── (c) `race` surfaces the actionable error — and is not failover ──────────────────────────
    // Worth measuring because it is the ONE built-in that hands the caller a routable 400.
    {
        const { p, primary, backup } = rig();
        p.primary.respond(400);
        const err = (await race(
            primary,
            backup,
        )({ body: { prompt: null } }).then(
            () => undefined,
            (e: unknown) => e as StitchError,
        ))!;
        check('(c) race error name', err.name, 'StitchError');
        check('(c) race error status', err.status, 400);
        check(
            '(c) race error body.error.code',
            (err.body as { error: { code: string } }).error.code,
            'invalid_request',
        );
        // …but it still called the backup, and it would have failed over to NOTHING if the primary
        // had merely been slow-and-failing.
        checkSeq('(c) [primary, backup] requests', hits(p), [1, 1]);
        const healthy = rig();
        healthy.p.primary.respond(500);
        check(
            '(c) race with a 500 primary and a healthy backup',
            await outcomeOf(() =>
                race(healthy.primary, healthy.backup)({ body: {} }),
            ),
            '500',
        );
        note(
            '(c) → `race` keeps the error and loses the failover',
            'first to SETTLE (pipe.ts:293-297) means a fast failure wins over a good answer — it is a hedge, and it is unsafe as a failover',
        );
    }

    // ── (d) the classified version, in user code ───────────────────────────────────────────────
    // Nine lines. `err.status` is on the `StitchError` the stitch itself throws, so the classifier
    // is a predicate over one field — the seam is small and the trace still chains.
    {
        const AVAILABILITY = new Set([408, 429, 500, 502, 503, 504]);
        const failsOver = (e: unknown): boolean =>
            AVAILABILITY.has((e as StitchError).status ?? 0);

        // 400 → stop the chain.
        {
            const { p, primary, backup } = bothReject400();
            const err = (await linked(async (run) => {
                try {
                    return await run(primary, { body: { prompt: null } });
                } catch (e) {
                    if (!failsOver(e)) throw e;
                    return await run(backup, { body: { prompt: null } });
                }
            }).then(
                () => undefined,
                (e: unknown) => e as StitchError,
            ))!;
            checkSeq(
                '(d) classified, 400 → [primary, backup]',
                hits(p),
                [1, 0],
            );
            check('(d) 400: error name', err.name, 'StitchError');
            check('(d) 400: error status', err.status, 400);
            check(
                '(d) 400: error body.error.message',
                (err.body as { error: { message: string } }).error.message,
                'primary says 400',
            );
        }

        // 429 → fail over.
        {
            const { p, primary, backup } = rig();
            p.primary.respond(429);
            const out = (await linked(async (run) => {
                try {
                    return await run(primary, { body: {} });
                } catch (e) {
                    if (!failsOver(e)) throw e;
                    return await run(backup, { body: {} });
                }
            })) as { served_by: string };
            checkSeq(
                '(d) classified, 429 → [primary, backup]',
                hits(p),
                [1, 1],
            );
            check('(d) 429: who served it', out.served_by, 'backup');
        }

        // 500 → fail over.
        {
            const { p, primary, backup } = rig();
            p.primary.respond(500);
            const out = (await linked(async (run) => {
                try {
                    return await run(primary, { body: {} });
                } catch (e) {
                    if (!failsOver(e)) throw e;
                    return await run(backup, { body: {} });
                }
            })) as { served_by: string };
            checkSeq(
                '(d) classified, 500 → [primary, backup]',
                hits(p),
                [1, 1],
            );
            check('(d) 500: who served it', out.served_by, 'backup');
        }
        note(
            '(d) → classification is one `Set` and one `if`, over `StitchError.status`',
            'the library gives the caller the field; it gives no place to DECLARE the routing rule',
        );
    }

    // ── (e) is there a declarative spelling for "fail over on these statuses"? ──────────────────
    // `retry.on` exists and is the right vocabulary — for the SAME endpoint. Nothing carries it
    // across to a different one.
    {
        const results = probeSpellings([
            {
                label: 'retry: { on: [429, 503] }  (same endpoint)',
                code: "void stitch({ url: 'https://x.test', retry: { attempts: 3, on: [429, 503] } });",
            },
            {
                label: 'verdict: { accept: [429] }',
                code: "void stitch({ url: 'https://x.test', verdict: { accept: [429] } });",
            },
            {
                label: 'any(a, b, { on: [429, 503] })',
                code: 'void pipe.any(a, b, { on: [429, 503] });',
            },
            {
                label: 'any([a, b], { failOverOn: [429] })',
                code: 'void pipe.any([a, b], { failOverOn: [429] });',
            },
            {
                label: 'stitch({ failover: { to: b, on: [429] } })',
                code: "void stitch({ url: 'https://x.test', failover: { to: b, on: [429] } });",
            },
        ]);
        checkSeq('(e) declarative spellings that COMPILE', accepted(results), [
            'retry: { on: [429, 503] }  (same endpoint)',
            'verdict: { accept: [429] }',
        ]);
        check('(e) refused', rejected(results).length, 3);
        note(
            '(e) → `retry.on` (types.ts:981-986) is the exact vocabulary the failover needs',
            'and it is scoped to re-hitting the SAME endpoint — the docstring on `any` (pipe.ts:277-278) draws that distinction itself, and then offers no `on` of its own',
        );
    }

    finish(
        'C3',
        'NOT CLASSIFIABLE by any built-in, and the aggregate is worse than the capture predicts. `any` over a pair that both reject a malformed payload measured [1, 1] — one bad request became TWO bad requests and two bills — and rejected with `AggregateError`, message "All promises were rejected", whose `status` and `body` are both `undefined`. Every field a catch block routes on is DROPPED at the combinator boundary: the engine populates `StitchError.status`/`.body`/`.url`/`.attempts` (types.ts:1657-1691), and `Promise.any` (pipe.ts:152) replaces it with a builtin that carries none of them; the actionable 400 (`body.error.code === "invalid_request"`) survives only inside `.errors[0]`, which no `StitchError` API points at. ONE BUILT-IN DOES SURFACE IT, IN THE OPPOSITE DIRECTION: `race` handed the caller a real `StitchError` status 400 with the body intact — because first-to-SETTLE means the primary’s rejection wins — but that same property makes it useless as failover, since a 500 primary against a healthy backup also measured 500. The classified version is USER CODE and it is small: a 6-status `Set` and one `if` over `StitchError.status` inside a `linked` body measured [1, 0] on a 400 (chain stopped, actionable error preserved) and [1, 1] on both 429 and 500 (failed over, backup served). Of five declarative spellings probed, only `retry: { on: [...] }` and `verdict: { accept: [...] }` compile — and `retry.on` is exactly the right vocabulary scoped to the WRONG target, since it re-hits the same endpoint',
    );
}

void main();

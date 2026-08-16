// C2 — is SEQUENTIAL fallback expressible at all? The correct default is "try the primary; only on
// failure try the backup", so the measurement is: backup requests when the primary SUCCEEDS, which
// must be 0. Then the two costs that decide whether it is a real answer — how much user code, and
// whether the trace survives.
//
// The capture says "there is no sequential-fallback COMBINATOR" and that is confirmed by the
// compiler (six spellings probed, the two that exist are both concurrent). What it gets wrong is
// the conclusion it leans toward — that the correct default is therefore unavailable. It is
// available, it is `linked` + `try`/`catch`, it measured [10, 0], and it keeps the trace:
//
//   • `linked` + `try`/`catch` measured ONE traceId across primary and backup, with the backup
//     parented on the primary's span — the failover chain is a single readable trace tree.
//   • Bare `try`/`catch` measured TWO traceIds, both roots. Same 0 backup calls, no linkage.
//
// So the seam is real but small: 5 lines of body, and the loss is not correctness, it is that the
// flow is a statement rather than a value (a `linked` call cannot be handed to `all`, cached, or
// introspected the way a `Composable` can).
//
//   pnpm exec tsx docs/scenarios/proofs/provider-failover/c2-sequential-fallback.ts
import { any, linked } from '../../../../packages/core/src/pipe';
import { hits } from './fake-provider';
import { check, checkSeq, finish, heading, note } from './harness';
import { rig } from './providers';
import { recordingSink } from './trace-probe';
import { accepted, probeSpellings, rejected } from './type-probe';

async function main(): Promise<void> {
    heading('C2 — sequential fallback: 0 backup calls on a healthy primary?');

    // ── (a) `linked` + try/catch, primary healthy ──────────────────────────────────────────────
    // The whole shape, and the number that defines the claim.
    {
        const { p, primary, backup } = rig();
        for (let i = 0; i < 10; i++) {
            await linked(async (run) => {
                try {
                    return await run(primary, { body: { prompt: `q${i}` } });
                } catch {
                    return await run(backup, { body: { prompt: `q${i}` } });
                }
            });
        }
        checkSeq(
            '(a) linked + try/catch → [primary, backup]',
            hits(p),
            [10, 0],
        );
        note(
            '(a) → the happy path costs exactly one request',
            'against `any`’s [10, 10] on the identical providers (C1a)',
        );
    }

    // ── (b) …and it does fail over when the primary is genuinely down ──────────────────────────
    {
        const { p, primary, backup } = rig();
        p.primary.respond(503);
        const out = (await linked(async (run) => {
            try {
                return await run(primary, { body: { prompt: 'q' } });
            } catch {
                return await run(backup, { body: { prompt: 'q' } });
            }
        })) as { served_by: string };
        checkSeq('(b) primary 503 → [primary, backup]', hits(p), [1, 1]);
        check('(b) who served it', out.served_by, 'backup');
    }

    // ── (c) the trace: does the failover stay ONE tree? ─────────────────────────────────────────
    // This is the reason to reach for `linked` over a bare try/catch, and it is measurable.
    {
        const trace = recordingSink();
        const { p, primary, backup } = rig({ trace });
        p.primary.respond(500);
        await linked(async (run) => {
            try {
                return await run(primary, { body: { prompt: 'q' } });
            } catch {
                return await run(backup, { body: { prompt: 'q' } });
            }
        });
        check('(c) linked: distinct traceIds', trace.traceIds().length, 1);
        checkSeq('(c) linked: trace spine', trace.spine(), [
            'primary<-<root>',
            'backup<-primary',
        ]);
        note(
            '(c) → `linked` chains each call under the PREVIOUS one (pipe.ts:361-368)',
            'so the failover reads as `primary → backup` in one trace tree, which is exactly the shape an on-call engineer wants',
        );

        // The bare try/catch, for contrast: identical counts, two unrelated traces.
        const trace2 = recordingSink();
        const b = rig({ trace: trace2 });
        b.p.primary.respond(500);
        try {
            await b.primary({ body: { prompt: 'q' } });
        } catch {
            await b.backup({ body: { prompt: 'q' } });
        }
        checkSeq('(c) bare try/catch → [primary, backup]', hits(b.p), [1, 1]);
        check(
            '(c) bare try/catch: distinct traceIds',
            trace2.traceIds().length,
            2,
        );
        checkSeq('(c) bare try/catch: trace spine', trace2.spine(), [
            'primary<-<root>',
            'backup<-<root>',
        ]);
    }

    // ── (d) `any` cannot be made sequential by any member-level configuration ───────────────────
    // A stitch's `throttle` paces SUCCESSIVE calls, not the first one, so it cannot be used to hold
    // the backup back behind the primary. Measured: the first request leaves at t=0 either way.
    {
        const { p, primary, backup } = rig({
            onBackup: { throttle: { rate: '1/10s' } },
        });
        await any(primary, backup)({ body: { prompt: 'q' } });
        checkSeq(
            '(d) any + backup throttle 1/10s → [primary, backup]',
            hits(p),
            [1, 1],
        );
        check(
            '(d) backup request arrival (virtual ms)',
            p.backup.calls[0]?.at,
            0,
        );
        note(
            '(d) → `throttle` is a minimum SPACING between successive calls',
            'the first acquire is free, so there is no member-level knob that delays a member’s first request — a hedge delay is not expressible on the member',
        );
    }

    // ── (e) which spellings exist, per the compiler ─────────────────────────────────────────────
    {
        const results = probeSpellings([
            { label: 'pipe.all', code: 'void pipe.all;' },
            { label: 'pipe.any', code: 'void pipe.any;' },
            { label: 'pipe.race', code: 'void pipe.race;' },
            { label: 'pipe.linked', code: 'void pipe.linked;' },
            { label: 'pipe.first', code: 'void pipe.first;' },
            { label: 'pipe.fallback', code: 'void pipe.fallback;' },
            { label: 'pipe.series', code: 'void pipe.series;' },
            { label: 'pipe.sequence', code: 'void pipe.sequence;' },
            { label: 'pipe.hedge', code: 'void pipe.hedge;' },
            {
                label: 'any(a, b, { sequential: true })',
                code: 'void pipe.any(a, b, { sequential: true });',
            },
            {
                label: "any([a, b], { delay: '100ms' })",
                code: "void pipe.any([a, b], { delay: '100ms' });",
            },
            {
                label: 'stitch({ fallback: b })',
                code: "void stitch({ url: 'https://x.test', fallback: b });",
            },
            {
                label: 'stitch({ retry: { fallback: b } })',
                code: "void stitch({ url: 'https://x.test', retry: { fallback: b } });",
            },
        ]);
        checkSeq('(e) spellings that COMPILE', accepted(results), [
            'pipe.all',
            'pipe.any',
            'pipe.race',
            'pipe.linked',
        ]);
        check(
            '(e) spellings the compiler REFUSED',
            rejected(results).length,
            9,
        );
        note(
            '(e) → the vocabulary is 3 concurrent combinators + 1 sequential SCOPE',
            'no `first`/`fallback`/`series`, no per-call option that makes `any` sequential, and no `fallback` key on a stitch — sequential failover is a body you write, never a node you declare',
        );
    }

    // ── (f) what a `linked` fallback is NOT ────────────────────────────────────────────────────
    // `linked` returns a Promise, not a `Composable`. The failover therefore cannot be nested in
    // `all`/`any`/`race`, and it is not a value with `__config` to inspect, diff, or export.
    {
        const { primary, backup } = rig();
        const flow = linked(async (run) => {
            try {
                return await run(primary, { body: { prompt: 'q' } });
            } catch {
                return await run(backup, { body: { prompt: 'q' } });
            }
        });
        await flow;
        check(
            '(f) is the linked flow a Composable node?',
            (flow as { __composable?: true }).__composable ?? false,
            false,
        );
        check('(f) is it callable (re-runnable)?', typeof flow, 'object');
        note(
            '(f) → `linked` is a Promise, not a node (pipe.ts:357-369)',
            'so the failover runs ONCE at the point of definition and cannot be handed to a combinator, wrapped in a seam member, or introspected — wrap it in a plain function to get a re-runnable unit back',
        );
    }

    finish(
        'C2',
        'EXPRESSIBLE, and the capture under-sells it. Sequential fallback is not a combinator — the compiler refused 9 of 13 candidate spellings, and the four that exist (`all`/`any`/`race`/`linked`) are three concurrent joins plus one sequential SCOPE — but `linked` + `try`/`catch` IS the correct default and it measured [10, 0]: ten calls with a healthy primary sent ZERO requests to the backup, against `any`’s [10, 10] on the identical providers, and a 503 primary failed over correctly to a backup-served answer at [1, 1]. THE OBSERVABILITY SURVIVES, AND ONLY THROUGH `linked`: the failover measured ONE traceId with the spine primary<-<root>, backup<-primary — the chain an on-call engineer wants — where the bare `try`/`catch` measured the same counts but TWO unrelated root traces. The cost is 5 lines of body and one real loss: `linked` returns a Promise, not a `Composable` (pipe.ts:357-369), so the flow is a statement that runs once, not a node you can nest in a combinator, hand to a seam, or introspect. Nor can `any` be coaxed into sequencing: a member-level `throttle: "1/10s"` on the backup did NOT hold its first request back — it left at t=0 and the pair measured [1, 1] — because a throttle is a minimum spacing between SUCCESSIVE calls, so no member-level knob delays a first request',
    );
}

void main();

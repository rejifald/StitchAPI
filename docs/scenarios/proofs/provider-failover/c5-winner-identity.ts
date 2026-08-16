// C5 — is the WINNER'S IDENTITY recoverable by the caller? Cost attribution needs it: you cannot
// bill, rate-limit, or debug a provider you cannot name. Three places it could live — the returned
// value, the events, the trace — measured in turn.
//
// The capture predicts "a combinator that returns the value tends to lose it". Confirmed, and the
// two mechanisms are worth separating because only one of them is fixable in config:
//
//   • The RESULT is the winner's body and nothing else. `any` returns `OutputOf<M[number]>` — a
//     union of the members' outputs, with no discriminant unless the provider happens to put one
//     in the body. Normalising the two vendors' envelopes with `pick` (which C4 measured working)
//     DESTROYS the only identity that was there.
//   • The TRACE cannot break the tie either, and this is the part the capture does not reach: on a
//     happy path BOTH members emit a terminal `result` event, and nothing distinguishes the one the
//     caller received. The group is not a span — `makeComposable` (pipe.ts:210-220) emits no events
//     at all — so there is no "failover" node in the trace to hang the decision on. And when the
//     loser IS cancelled it emits `start` and then nothing: no `error`, no `done`, a dangling span.
//
// The fix is one line per member and it is `transform`, not `pick`.
//
//   pnpm exec tsx docs/scenarios/proofs/provider-failover/c5-winner-identity.ts
import { any, linked } from '../../../../packages/core/src/pipe';
import type { StitchError } from '../../../../packages/core/src/types';
import { check, checkSeq, finish, heading, note } from './harness';
import { rig } from './providers';
import { recordingSink } from './trace-probe';
import { accepted, probeSpellings, rejected } from './type-probe';

async function main(): Promise<void> {
    heading('C5 — who served this call?');

    // ── (a) the returned value: identity only if the vendor volunteered it ─────────────────────
    {
        const { primary, backup } = rig();
        const raw = (await any(primary, backup)({ body: {} })) as Record<
            string,
            unknown
        >;
        checkSeq('(a) keys on the raw winner', Object.keys(raw).sort(), [
            'choices',
            'served_by',
        ]);
        check(
            '(a) served_by (the vendor volunteered it)',
            raw['served_by'],
            'primary',
        );
        note(
            '(a) → the combinator adds nothing',
            '`any` resolves to `OutputOf<M[number]>` (pipe.ts:281-286) — the member’s own value, with no envelope, index, or name',
        );
    }

    // ── (b) …and normalising the two vendors destroys it ───────────────────────────────────────
    // C4(e) showed `pick` unifying two different response shapes. That is the same operation that
    // removes the only attribution the caller had.
    {
        const { p, primary, backup } = rig({
            onPrimary: { pick: 'choices.0.text' },
            onBackup: { pick: 'output' },
        });
        const won = await any(primary, backup)({ body: {} });
        check('(b) normalised winner', won, 'answer from primary');
        check('(b) typeof', typeof won, 'string');
        p.primary.respond(503);
        const failedOver = await any(primary, backup)({ body: {} });
        check('(b) after failover', failedOver, 'answer from backup');
        note(
            '(b) → normalise OR attribute, not both, with `pick`',
            'the caller’s two goals — one uniform result type, and knowing who produced it — pull in opposite directions under `pick`',
        );
    }

    // ── (c) the trace: two winners, no tiebreak ────────────────────────────────────────────────
    // The measurement that closes the question: on a happy path both members SUCCEED, so a sink
    // sees two terminal `result` events and no marker on the one the caller got.
    {
        const trace = recordingSink();
        const { primary, backup } = rig({ trace });
        await any(primary, backup)({ body: {} });

        checkSeq(
            '(c) members that emitted a terminal `result`',
            trace.names('result').sort(),
            ['backup', 'primary'],
        );
        check('(c) distinct traceIds', trace.traceIds().length, 1);
        checkSeq('(c) trace spine', trace.spine(), [
            'primary<-span',
            'backup<-span',
        ]);
        check(
            '(c) events emitted by the `any` group itself',
            trace.records.filter(
                (r) => r.name !== 'primary' && r.name !== 'backup',
            ).length,
            0,
        );
        note(
            '(c) → the group is not a span',
            '`makeComposable` (pipe.ts:210-220) mints a run context for the members and emits nothing of its own, so the trace shows a fan with two successes and no node that says which one the caller received',
        );
    }

    // ── (d) the cancelled loser leaves a DANGLING span ─────────────────────────────────────────
    // Sharper than "the trace can't tell you": a member that is auto-cancelled emits `start` and
    // then never terminates. No `error`, no `done`. So the trace of a hedge is one closed span and
    // one span that simply stops — which a span-based backend reports as a timeout or a leak, and
    // which no cost report can attribute.
    {
        const trace = recordingSink();
        const { p, primary, backup } = rig({ trace });
        p.primary.takes(50);
        await any(primary, backup)({ body: {} });

        check('(d) the primary WAS aborted mid-flight', p.primary.aborted, 1);
        checkSeq('(d) members that emitted `result`', trace.names('result'), [
            'backup',
        ]);
        checkSeq('(d) members that emitted `error`', trace.names('error'), []);
        checkSeq('(d) members that emitted `done`', trace.names('done'), [
            'backup',
        ]);
        checkSeq(
            '(d) every event the cancelled primary emitted',
            trace.records
                .filter((r) => r.name === 'primary')
                .map((r) => r.type),
            ['start', 'progress'],
        );
        note(
            '(d) → the loser’s span is opened and never closed',
            'the cancellation rejects the member promise, which `swallowLateRejections` (pipe.ts:90-92) catches OUTSIDE the engine — so no `error`/`done` event is ever emitted and the span dangles',
        );
        note(
            '(d) → and when the loser is fast it emits `result` instead',
            'C1(b) measured 10/10 losers COMPLETING on a fast backup, so a sink sees either two successes or one success and one unterminated span — never a marked winner',
        );
    }

    // ── (e) what the caller can reach on the combinator itself ─────────────────────────────────
    // `.safe()`, `.inspect()` and `__config` are Stitch API; a `Composable` is a bare callable.
    {
        const { primary, backup } = rig();
        const node = any(primary, backup);
        check('(e) typeof the composable', typeof node, 'function');
        check('(e) node.__composable', node.__composable, true);
        check(
            '(e) does it have .safe()?',
            'safe' in (node as unknown as Record<string, unknown>),
            false,
        );
        check(
            '(e) does it have .inspect()?',
            'inspect' in (node as unknown as Record<string, unknown>),
            false,
        );
        check(
            '(e) does it have __config?',
            '__config' in (node as unknown as Record<string, unknown>),
            false,
        );

        const results = probeSpellings([
            { label: 'any(a, b).safe()', code: 'void pipe.any(a, b).safe();' },
            {
                label: 'any(a, b).inspect()',
                code: 'void pipe.any(a, b).inspect();',
            },
            { label: 'a.safe()', code: 'void a.safe();' },
            {
                label: 'any({ primary: a, backup: b })  (named bag)',
                code: 'void pipe.any({ primary: a, backup: b });',
            },
            {
                label: 'all({ primary: a, backup: b })  (named bag)',
                code: 'void pipe.all({ primary: a, backup: b });',
            },
        ]);
        checkSeq('(e) spellings that COMPILE', accepted(results), [
            'a.safe()',
            'all({ primary: a, backup: b })  (named bag)',
        ]);
        check('(e) refused', rejected(results).length, 3);
        note(
            '(e) → `all` takes a NAMED bag and returns keys; `any` and `race` do not',
            'the one combinator that already carries member NAMES through to its result is the one whose semantics never need them (pipe.ts:252-260 vs 281-286) — the naming exists, it is just on the wrong combinator',
        );
    }

    // ── (f) the two ways to get identity back ──────────────────────────────────────────────────
    // Per-member `transform`: one line each, and it survives `pick`-style normalisation because it
    // IS the normalisation.
    {
        const { p, primary, backup } = rig({
            onPrimary: {
                transform: (b) => ({
                    provider: 'primary',
                    text: (b as { choices: { text: string }[] }).choices[0]
                        ?.text,
                }),
            },
            onBackup: {
                transform: (b) => ({
                    provider: 'backup',
                    text: (b as { output: string }).output,
                }),
            },
        });
        const won = (await any(primary, backup)({ body: {} })) as {
            provider: string;
            text: string;
        };
        checkSeq(
            '(f) transform: [provider, text]',
            [won.provider, won.text],
            ['primary', 'answer from primary'],
        );
        p.primary.respond(500);
        const after = (await any(primary, backup)({ body: {} })) as {
            provider: string;
        };
        check('(f) transform after failover', after.provider, 'backup');

        // …and in the sequential shape, identity is free: the caller KNOWS which branch it took.
        const seq = rig();
        seq.p.primary.respond(503);
        const attributed = await linked(async (run) => {
            try {
                return {
                    provider: 'primary',
                    value: await run(seq.primary, { body: {} }),
                };
            } catch (e) {
                void (e as StitchError).status;
                return {
                    provider: 'backup',
                    value: await run(seq.backup, { body: {} }),
                };
            }
        });
        check('(f) linked: who served it', attributed.provider, 'backup');
        note(
            '(f) → `transform` (a per-stitch config field) is the one-line fix for `any`',
            'and the sequential shape needs no fix at all, because the branch the code took IS the attribution',
        );
    }

    finish(
        'C5',
        'NOT RECOVERABLE from any built-in, in either of the two places it could live. The RESULT is the winner’s raw body and nothing more — `any` resolves to `OutputOf<M[number]>` (pipe.ts:281-286) with no envelope, index or name — so attribution exists only when the vendor volunteered a field, and the per-stitch `pick` that C4 measured normalising two different response envelopes DESTROYS exactly that field (the winner measured as the bare string "answer from primary", indistinguishable in type and shape from the backup’s). The TRACE cannot break the tie either, which is the part the capture does not reach: on a happy path BOTH members emitted a terminal `result` event (measured ["backup","primary"]) with nothing marking the one the caller received, and the group emitted ZERO events of its own because `makeComposable` (pipe.ts:210-220) is not a span — there is no failover node in the trace to hang the decision on. AND INFERENCE FROM THE TRACE DOES NOT WORK EITHER, FOR A REASON THE CAPTURE DOES NOT ANTICIPATE: a member that IS auto-cancelled emits `start` and `progress` and then NOTHING — measured 0 `error` events and 0 `done` events for a primary that the ledger confirms was aborted mid-flight — because the cancellation rejects the member promise and `swallowLateRejections` (pipe.ts:90-92) catches it outside the engine. So a hedge’s trace is one closed span and one span that simply stops, which a span-based backend reads as a timeout or a leak; and when the loser is fast it emits `result` instead (C1(b): 10/10). Nor can the caller reach for `.safe()`/`.inspect()`/`__config` — a `Composable` is a bare branded callable and all three probes refused to compile. THE SHARPEST DETAIL: `all` accepts a NAMED bag and returns a keyed object (pipe.ts:252-260); `any` and `race` accept only arrays and bare arguments. The one combinator that carries member names through to its result is the one whose semantics never need them. The fix is `transform` — one line per member, measured returning `{ provider: "primary" }` and `{ provider: "backup" }` across a failover — or the sequential shape, where the branch taken IS the attribution',
    );
}

void main();

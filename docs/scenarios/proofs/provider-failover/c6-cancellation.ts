// C6 — cancellation. "The losers are auto-cancelled" (pipe.ts:276, 296) is the sentence that makes
// a concurrent combinator sound like a cheap one. Two measurements decide what it is worth:
// (a) did the loser's request reach the provider at all, and (b) did the provider see it aborted
// MID-FLIGHT, or had it already finished?
//
// The capture is right that a cancelled request still reaches the provider, and right that
// cancelling does not refund. What it does not say is that the saving is a FRACTION, and the
// fraction is set by the latency gap between the two providers — the same gap that decides whether
// the loser was cheap in the first place:
//
//   • Loser as fast as the winner  → 0% saved. It completed. (C1(b): 10/10.)
//   • Loser 100ms, winner 40ms     → 60% of the loser's work saved, 40% billed. Measured exactly.
//   • Loser slower still           → more saved, and it was never going to win anyway.
//
// So the cancellation refunds the tail and bills the head, and the head is what an LLM charges for.
//
//   pnpm exec tsx docs/scenarios/proofs/provider-failover/c6-cancellation.ts
import { any, linked, race } from '../../../../packages/core/src/pipe';
import { hits, outcomeOf } from './fake-provider';
import { check, checkSeq, finish, heading, note } from './harness';
import { rig } from './providers';

async function main(): Promise<void> {
    heading('C6 — is the loser cancelled, and what does that save?');

    // ── (a) the request ARRIVES either way ─────────────────────────────────────────────────────
    // Cancellation is a property of the response, never of the request. Both providers received it.
    {
        const { clock, p, primary, backup } = rig();
        p.primary.takes(100);
        const call = any(primary, backup)({ body: {} });
        await clock.advance(200);
        await call;

        checkSeq('(a) [primary, backup] requests RECEIVED', hits(p), [1, 1]);
        check('(a) primary completed?', p.primary.completed, 0);
        check('(a) primary aborted mid-flight?', p.primary.aborted, 1);
        note(
            '(a) → "auto-cancelled" never means "not sent"',
            'the abort is raised after the winner settles (pipe.ts:154-156); by then every member has already made its request',
        );
    }

    // ── (b) how much of the loser's work was actually saved ────────────────────────────────────
    // The number the framing turns on. The loser is aborted at the instant the winner answers, so
    // it is billed for exactly the winner's latency.
    {
        const { clock, p, primary, backup } = rig();
        p.primary.takes(100); // the loser would have taken 100
        p.backup.takes(40); // the winner answers at t=40
        const call = any(primary, backup)({ body: {} });
        await clock.advance(200);
        await call;

        check('(b) winner latency (virtual ms)', p.backup.workedMs, 40);
        check('(b) loser work BILLED (virtual ms)', p.primary.workedMs, 40);
        check(
            '(b) loser work SAVED (virtual ms of 100)',
            100 - p.primary.workedMs,
            60,
        );
        check('(b) timers left pending', clock.pending(), 0);
        note(
            '(b) → the loser is billed for the WINNER’s latency, every time',
            'for a token-metered API that is the tokens generated in the first 40ms — cancelling refunds the tail, and the head is not free',
        );
    }

    // ── (c) the degenerate case the docstring implies is safe ──────────────────────────────────
    // Two providers of similar speed — the normal case for a deliberately-chosen backup — save
    // nothing at all.
    {
        const { clock, p, primary, backup } = rig();
        p.primary.takes(40);
        p.backup.takes(40);
        const call = any(primary, backup)({ body: {} });
        await clock.advance(200);
        await call;

        check('(c) primary work billed', p.primary.workedMs, 40);
        check('(c) backup work billed', p.backup.workedMs, 40);
        check(
            '(c) total work for ONE answer (virtual ms)',
            p.primary.workedMs + p.backup.workedMs,
            80,
        );
        // The sting: the loser IS recorded as aborted — and it had already done all 40ms of its
        // work when the abort landed, because the two were due at the same instant. "Cancelled"
        // and "saved something" are different facts, and only the first one is observable.
        check(
            '(c) requests recorded as aborted mid-flight',
            p.primary.aborted + p.backup.aborted,
            1,
        );
        check(
            '(c) work the abort actually saved (virtual ms)',
            80 - (p.primary.workedMs + p.backup.workedMs),
            0,
        );
        note(
            '(c) → equally-fast providers = 100% of the double spend, 0% saved',
            'the loser is recorded as ABORTED and still burned its full 40ms — "cancelled" is a statement about the response, not about the work; the closer the backup is to the primary in speed, i.e. the better a backup it is, the less cancellation saves',
        );
    }

    // ── (d) non-idempotent writes: two charges for one intent ──────────────────────────────────
    // The hazard the capture names, as a number. `any`/`race` on a POST send the payload TWICE, and
    // the abort lands after the second one arrived.
    {
        const { clock, p, primary, backup } = rig();
        p.primary.takes(100);
        const call = race(
            primary,
            backup,
        )({
            body: { charge: { amount: 4200, currency: 'usd' } },
        });
        await clock.advance(200);
        await call;

        checkSeq('(d) POSTs delivered [primary, backup]', hits(p), [1, 1]);
        checkSeq(
            '(d) method each provider saw',
            [p.primary.calls[0]?.method, p.backup.calls[0]?.method],
            ['POST', 'POST'],
        );
        checkSeq(
            '(d) amount each provider was asked to charge',
            [
                (p.primary.calls[0]?.body as { charge: { amount: number } })
                    .charge.amount,
                (p.backup.calls[0]?.body as { charge: { amount: number } })
                    .charge.amount,
            ],
            [4200, 4200],
        );
        note(
            '(d) → one intent, two writes, and the cancel arrives after both landed',
            'nothing in `any`/`race` inspects `method`; hedging a non-idempotent call is a correctness bug the type system will not catch',
        );
    }

    // ── (e) the caller's own signal DOES cancel the whole group ────────────────────────────────
    // The half that works exactly as documented, and worth stating: an outer abort reaches every
    // member, because the group controller is linked to the caller's (pipe.ts:57-71).
    {
        const { clock, p, primary, backup } = rig();
        p.primary.takes(100);
        p.backup.takes(100);
        const ctrl = new AbortController();
        const outcome = outcomeOf(() =>
            any(primary, backup)({ body: {}, signal: ctrl.signal }),
        );
        await clock.advance(30);
        ctrl.abort();
        const seen = await outcome;
        await clock.advance(200);

        check('(e) call outcome', seen, 'AggregateError');
        checkSeq(
            '(e) providers that saw the abort',
            [p.primary.aborted, p.backup.aborted],
            [1, 1],
        );
        checkSeq(
            '(e) work billed to each before the abort',
            [p.primary.workedMs, p.backup.workedMs],
            [30, 30],
        );
        check('(e) timers left pending', clock.pending(), 0);
        note(
            '(e) → an outer abort propagates to every member',
            '`linkedController` (pipe.ts:57-71) links the group signal to the caller’s, so a request-scoped deadline does reach both providers',
        );
    }

    // ── (f) the sequential shape has no loser to cancel ────────────────────────────────────────
    {
        const { clock, p, primary, backup } = rig();
        p.primary.takes(40);
        p.backup.takes(40);
        const call = linked(async (run) => {
            try {
                return await run(primary, { body: {} });
            } catch {
                return await run(backup, { body: {} });
            }
        });
        await clock.advance(200);
        await call;
        checkSeq('(f) sequential → [primary, backup]', hits(p), [1, 0]);
        check(
            '(f) total work for ONE answer (virtual ms)',
            p.primary.workedMs + p.backup.workedMs,
            40,
        );
        note(
            '(f) → 40 virtual ms against the hedge’s 80 in (c)',
            'the cancellation machinery exists to reclaim a cost the sequential shape never incurs',
        );
    }

    finish(
        'C6',
        'THE LOSER IS CANCELLED, THE REQUEST STILL ARRIVED, AND THE SAVING IS A FRACTION SET BY THE LATENCY GAP — which is the part the capture does not quantify. Every measurement here confirms the loser’s request REACHES the provider: `any` with a 100ms primary and an instant backup measured [1, 1] received, 0 completed and 1 aborted on the primary — "auto-cancelled" never means "not sent", because the abort is raised in `runAny`’s `finally` (pipe.ts:154-156), after every member has already made its request. What the cancel actually saves: with a 100ms loser and a 40ms winner, the loser was billed for exactly 40 virtual ms of work and saved 60 — IT IS BILLED FOR THE WINNER’S LATENCY, EVERY TIME, which for a token-metered API is the tokens generated before the abort landed. And in the case that matters most the saving is ZERO: two equally-fast 40ms providers burned 40 virtual ms EACH — 80 for one answer — and although the loser IS recorded as aborted mid-flight, the work the abort saved measured 0, because the two were due at the same instant. "Cancelled" is a statement about the response, not about the work, and the closer the backup is to the primary in speed — i.e. the better a backup it is — the less it saves. The non-idempotency hazard is a number too: `race` over a POST delivered the identical `{ charge: { amount: 4200 } }` body to BOTH providers, method POST at each, with the cancel arriving after both landed — nothing in the combinators inspects `method`. The half that works exactly as documented is the outer signal: an external abort at t=30 reached BOTH members (1 and 1 aborted, 30 virtual ms billed each) via `linkedController` (pipe.ts:57-71), with 0 timers left pending. The sequential shape produced the same answer for 40 virtual ms and [1, 0] — the cancellation machinery exists to reclaim a cost that failover never incurs',
    );
}

void main();

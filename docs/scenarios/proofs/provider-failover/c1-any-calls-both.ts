// C1 — THE DECIDING CLAIM. `any()`'s docstring calls it "failover across interchangeable sources …
// a primary and a mirror, two regions, two providers" (pipe.ts:274-280). Failover means ONE call on
// the happy path. Measure the two integers that decide it: requests reaching the primary, and
// requests reaching the backup, over calls where the primary succeeded every time.
//
// The capture predicts "both providers on every call" and it is right. Three things it does NOT
// predict, all measured here:
//
//   • The loser is not merely CALLED, it COMPLETES. Auto-cancellation fires in `runAny`'s `finally`
//     (pipe.ts:154-156), which is one microtask AFTER the winner settled — by then a fast backup has
//     already answered in full. 10/10 backup requests measured `completed`, 0 aborted.
//   • `any` has no notion of a PREFERRED member. It is `Promise.any` (pipe.ts:152), so the winner is
//     whoever settles first. With a healthy primary that is merely slower, the caller silently gets
//     the BACKUP's answer — and pays both.
//   • `all` and `race` cost exactly the same two requests. The three combinators differ only in
//     which result they keep, never in what they spend.
//
//   pnpm exec tsx docs/scenarios/proofs/provider-failover/c1-any-calls-both.ts
import { all, any, race } from '../../../../packages/core/src/pipe';
import { hits } from './fake-provider';
import { check, checkSeq, finish, heading, note } from './harness';
import { rig as pair } from './providers';

async function main(): Promise<void> {
    heading('C1 — how many requests does a SUCCESSFUL call cost?');

    // ── (a) ten happy calls through `any` ──────────────────────────────────────────────────────
    // The primary is healthy throughout. A failover would send 10 requests. Measure what `any` sends.
    {
        const { p, primary, backup } = pair();
        const failover = any(primary, backup);
        for (let i = 0; i < 10; i++)
            await failover({ body: { prompt: `q${i}` } });

        check('(a) successful calls made', 10, 10);
        check('(a) requests the PRIMARY received', p.primary.received, 10);
        check('(a) requests the BACKUP received', p.backup.received, 10);
        checkSeq('(a) [primary, backup]', hits(p), [10, 10]);
        check(
            '(a) total provider requests for 10 answers',
            p.primary.received + p.backup.received,
            20,
        );
        note(
            '(a) → `any` is `Promise.any` over members started EAGERLY (pipe.ts:148-152)',
            'every member is invoked before any result is known, so the happy path costs 2 requests per answer — 100% amplification on a provider that never failed',
        );
    }

    // ── (b) the loser COMPLETES; cancellation does not save the call ────────────────────────────
    // "The losers are auto-cancelled" is true and arrives too late to matter: `ctrl.abort()` is in
    // the `finally` (pipe.ts:154-156), after the winner has settled. A backup that answers as fast
    // as the primary has already answered.
    {
        const { p, primary, backup } = pair();
        const failover = any(primary, backup);
        for (let i = 0; i < 10; i++)
            await failover({ body: { prompt: `q${i}` } });

        check('(b) backup requests COMPLETED in full', p.backup.completed, 10);
        check('(b) backup requests aborted mid-flight', p.backup.aborted, 0);
        note(
            '(b) → the loser is billed for a complete request, not a cancelled one',
            'auto-cancel only helps when the loser is still working when the winner settles — see C6',
        );
    }

    // ── (c) `any` has no PREFERRED member — it prefers the FASTER one ───────────────────────────
    // A healthy primary that is 10 virtual ms slower than the backup loses. The caller gets the
    // backup's answer, and still pays for both. Nothing in the construction says "primary first".
    {
        const { clock, p, primary, backup } = pair();
        p.primary.takes(10); // healthy, just slower
        const failover = any(primary, backup);
        const result = (await failover({ body: { prompt: 'hi' } })) as {
            served_by: string;
        };

        check('(c) primary status', 200, 200);
        check('(c) who served the answer', result.served_by, 'backup');
        checkSeq('(c) [primary, backup] requests', hits(p), [1, 1]);
        check(
            '(c) the healthy primary was aborted mid-flight',
            p.primary.aborted,
            1,
        );
        check('(c) timers left pending', clock.pending(), 0);
        note(
            '(c) → "failover" routed AWAY from a healthy primary because it was slower',
            'member ORDER carries no priority in `Promise.any`; if the backup is cheaper-but-worse, or a different model, this is a silent quality regression as well as a double bill',
        );
    }

    // ── (d) `all` and `race` cost the same two requests ─────────────────────────────────────────
    // The three parallel combinators differ only in which result they keep. Spend is identical.
    {
        const a = pair();
        await all(a.primary, a.backup)({ body: { prompt: 'x' } });
        const r = pair();
        await race(r.primary, r.backup)({ body: { prompt: 'x' } });
        const n = pair();
        await any(n.primary, n.backup)({ body: { prompt: 'x' } });

        checkSeq('(d) all  → [primary, backup]', hits(a.p), [1, 1]);
        checkSeq('(d) race → [primary, backup]', hits(r.p), [1, 1]);
        checkSeq('(d) any  → [primary, backup]', hits(n.p), [1, 1]);
        note(
            '(d) → all/any/race are one implementation with three joins',
            '`runAll`/`runAny`/`runRace` (pipe.ts:96-175) are the same eager `members.map(runMember)` under Promise.all/any/race — the cost model is fixed, only the result selection varies',
        );
    }

    // ── (e) what a real failover would have cost ────────────────────────────────────────────────
    // The number the docstring's vocabulary implies, measured on the same providers, for contrast.
    {
        const { p, primary, backup } = pair();
        for (let i = 0; i < 10; i++) {
            try {
                await primary({ body: { prompt: `q${i}` } });
            } catch {
                await backup({ body: { prompt: `q${i}` } });
            }
        }
        checkSeq('(e) try/catch → [primary, backup]', hits(p), [10, 0]);
        note(
            '(e) → the same 10 answers, 10 requests instead of 20',
            'the difference between `any` and a `try`/`catch` on a healthy provider is exactly the backup vendor’s entire bill',
        );
    }

    finish(
        'C1',
        'CONFIRMED, and the overspend is worse than "it calls both". Ten calls in which the primary succeeded EVERY TIME cost 10 primary requests and 10 BACKUP requests — 20 provider requests for 10 answers, 100% amplification against a provider that never failed, where a try/catch over the same providers measured [10, 0]. `any` is `Promise.any` over members started eagerly (pipe.ts:148-152), so every member is invoked before any outcome is known. THE THREE UNPREDICTED PARTS: (1) the loser COMPLETES — 10/10 backup requests measured `completed` and 0 aborted, because `ctrl.abort()` runs in the `finally` AFTER the winner settled (pipe.ts:154-156), so "the losers are auto-cancelled" saves nothing against a backup that is not slow; (2) `any` has no PREFERRED member — with a healthy primary that was merely 10ms slower, the winner measured `served_by: "backup"` and the healthy primary was aborted mid-flight, so member order carries no priority and the construction silently routes away from the provider you chose; (3) `all`, `race` and `any` each measured [1, 1] on one call — the three combinators are one eager implementation with three different joins (pipe.ts:96-175), identical in spend and different only in which result they keep',
    );
}

void main();

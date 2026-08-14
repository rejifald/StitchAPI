// A caller's abort must surface the caller's OWN error, and a deliberate cancel must never read
// as a retry. Two engine guarantees pinned here, plus the clock primitive they rest on:
//   • an abort DURING a retry backoff rejects with the signal's `reason` — `sleep` (systemClock
//     and manualClock alike) rejects with the reason when it is an Error, so a custom
//     `abort(reason)` (or the default AbortError) rides out of the engine instead of a generic
//     `Error('aborted')` minted by the sleep;
//   • an abort MID-FLIGHT ends the run at the attempt-loop catch: no `retry` progress event, no
//     `onRetry` hook, no backoff — before the guard, a cancelled call emitted a phantom retry and
//     only then died in the backoff sleep.
import { stitch, systemClock } from '../src';
import { manualClock, mockAdapter } from '../src/testing';
import type { StitchEvent } from '../src/types';

describe('abort during a retry backoff preserves the reason', () => {
    test('a custom abort(reason) surfaces as the call error, not a generic abort', async () => {
        const clock = manualClock();
        const api = mockAdapter({
            match: '/flaky',
            respond: [{ status: 503 }, { body: { ok: true } }],
        });
        const ac = new AbortController();
        const call = stitch({
            baseUrl: 'https://api.test',
            path: '/flaky',
            adapter: api,
            retry: {
                attempts: 2,
                on: [503],
                backoff: { curve: 'fixed', base: 10_000 },
            },
            clock,
        });

        const p = call({ signal: ac.signal }).safe();
        await clock.advance(0); // first attempt → 503 → the backoff sleep is armed
        expect(api.callCount()).toBe(1);
        expect(clock.pending()).toBe(1); // parked on the backoff

        ac.abort(new Error('user closed the panel')); // mid-backoff, with a custom reason

        const res = await p; // settles on the abort alone — no advance needed
        expect(res.ok).toBe(false);
        expect(res.error?.message).toBe('user closed the panel');
        expect(api.callCount()).toBe(1); // the second attempt never ran
        expect(clock.pending()).toBe(0); // the backoff timer was dropped, not leaked
    });
});

describe('abort mid-flight is a cancel, not a retry', () => {
    test('no retry event, no onRetry hook, and the reason still surfaces', async () => {
        const api = mockAdapter({
            match: '/slow',
            // Long enough that only the abort can end the attempt; the delay is abortable, so the
            // cancel cuts it short like a real socket.
            respond: { body: { ok: true }, delay: 5_000 },
        });
        const ac = new AbortController();
        const retried: unknown[] = [];
        const call = stitch({
            baseUrl: 'https://api.test',
            path: '/slow',
            adapter: api,
            retry: { attempts: 3, on: [503], backoff: { base: 5 } },
            hooks: {
                onRetry: (ctx) => {
                    retried.push(ctx);
                },
            },
        });

        const events: StitchEvent[] = [];
        const drained = (async () => {
            for await (const ev of call({ signal: ac.signal }).stream())
                events.push(ev);
        })();

        // Let the attempt reach the transport, then cancel deliberately.
        await new Promise((r) => setTimeout(r, 10));
        expect(api.callCount()).toBe(1); // in flight
        ac.abort(new Error('nevermind, user cancelled'));
        await drained;

        expect(
            events.filter((e) => e.type === 'progress' && e.phase === 'retry'),
        ).toHaveLength(0);
        expect(retried).toHaveLength(0);
        expect(events.find((e) => e.type === 'error')).toMatchObject({
            type: 'error',
            message: 'nevermind, user cancelled',
        });
        expect(api.callCount()).toBe(1); // no second attempt after the cancel
    });
});

// The primitive the backoff guarantee rests on: `systemClock.sleep` rejects with the signal's
// reason — the SAME instance, so `instanceof`/`cause` chains the caller built stay intact.
describe('systemClock.sleep rejects with the abort reason', () => {
    test('an abort mid-sleep rejects with the caller-supplied Error instance', async () => {
        const ac = new AbortController();
        const reason = new Error('caller reason');
        const p = systemClock.sleep(60_000, ac.signal);
        ac.abort(reason);
        await expect(p).rejects.toBe(reason);
    });

    test('a pre-aborted signal rejects with its existing reason', async () => {
        const ac = new AbortController();
        const reason = new RangeError('already gone');
        ac.abort(reason);
        await expect(systemClock.sleep(60_000, ac.signal)).rejects.toBe(reason);
    });

    test('a non-Error reason falls back to a generic abort Error', async () => {
        const ac = new AbortController();
        ac.abort('just a string');
        await expect(systemClock.sleep(0, ac.signal)).rejects.toThrow(
            'the operation was aborted',
        );
    });
});

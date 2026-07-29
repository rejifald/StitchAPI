// A manual {@link Clock} for tests: virtual time you advance by hand. Inject it as `clock` on a
// stitch/seam and retry backoff, throttle pacing, the per-attempt timeout, and circuit cooldown all
// resolve with zero real waiting — drive them with `advance(ms)`. (Per ADR 0010, `timeout.total`
// and event `at`/`ms` timestamps stay on wall-clock.) Browser-safe: no `node:*`.
import type { Clock, TimerHandle } from './types';

/** A {@link Clock} whose time only moves when you call {@link ManualClock.advance}. */
export interface ManualClock extends Clock {
    /**
     * Move virtual time forward by `ms`, firing every timer / `sleep` due at or before the new time
     * in due order — including ones scheduled by a callback fired during this advance (so a retry's
     * next backoff is armed before the next `advance`). Resolves once woken continuations settle.
     */
    advance(ms: number): Promise<void>;
    /** Count of still-pending timers/sleeps — assert `0` to prove nothing leaked. */
    pending(): number;
}

interface Scheduled {
    id: number;
    at: number; // virtual time (ms) it is due
    fn: () => void;
    seq: number; // insertion order — stable tie-break for same-time timers
}

// Yield to the macrotask queue: drains all pending microtasks (a just-woken sleep's `.then` chain,
// up to wherever the engine next parks on the clock) before we fire the next timer.
const drainMicrotasks = (): Promise<void> =>
    new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
    });

/**
 * Build a {@link ManualClock} starting at `start` (default `0`). Inject it as `clock`:
 *
 * ```ts
 * const clock = manualClock();
 * const call = stitch({ url, adapter, retry: { attempts: 3, backoff: { base: 10_000 }}, clock });
 * const p = call.safe();
 * await clock.advance(0); // run the first attempt
 * await clock.advance(10_000); // fire the backoff → next attempt
 * ```
 */
export function manualClock(start = 0): ManualClock {
    let current = start;
    let nextId = 1;
    let seq = 0;
    const scheduled: Scheduled[] = [];

    const schedule = (fn: () => void, ms: number): TimerHandle => {
        const id = nextId++;
        scheduled.push({ id, at: current + Math.max(0, ms), fn, seq: seq++ });
        return id;
    };
    const cancel = (handle: TimerHandle): void => {
        const i = scheduled.findIndex((s) => s.id === handle);
        if (i !== -1) scheduled.splice(i, 1);
    };

    return {
        now: () => current,
        setTimer: schedule,
        clearTimer: cancel,
        sleep: (ms, signal) =>
            new Promise<void>((resolve, reject) => {
                if (signal?.aborted) {
                    reject(new Error('aborted'));
                    return;
                }
                const onAbort = () => {
                    cancel(handle);
                    reject(new Error('aborted'));
                };
                const handle = schedule(() => {
                    signal?.removeEventListener('abort', onAbort);
                    resolve();
                }, ms);
                signal?.addEventListener('abort', onAbort, { once: true });
            }),
        async advance(ms: number): Promise<void> {
            const target = current + Math.max(0, ms);
            for (;;) {
                // Let woken continuations run (and arm their next timer) before scanning.
                await drainMicrotasks();
                const next = scheduled
                    .filter((s) => s.at <= target)
                    .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
                if (!next) break;
                scheduled.splice(scheduled.indexOf(next), 1);
                current = next.at;
                next.fn();
            }
            current = target;
            await drainMicrotasks();
        },
        pending: () => scheduled.length,
    };
}

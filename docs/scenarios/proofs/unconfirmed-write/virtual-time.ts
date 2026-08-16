// Driving a `manualClock` when the code under test does a little real async work.
//
// `manualClock.advance(ms)` fires every timer due before the target and drains the MICROTASK queue
// between fires, which is enough for code whose only asynchrony is the clock. Everything in this
// directory is that code — the fake payment server is pure in-memory logic with no crypto and no
// I/O, so `advance` alone is faithful here in a way it was not for `expiring-signatures` (whose
// SigV4 signing settled on the macrotask queue several turns deep).
//
// `runOut` exists anyway, for one reason: several claims here run a call to completion while the
// engine is sleeping on a RETRY BACKOFF, and the sleep is armed only after the failing attempt
// settles. Advancing in slices, with a macrotask turn between them, means a backoff armed during
// slice N is fired by slice N+1 rather than being missed — so a claim can say "advance past
// everything" instead of hand-computing the schedule.
import type { ManualClock } from '../../../../packages/core/src/testing';

// Yield one full turn of the event loop. `setImmediate` fires in the check phase and costs
// microseconds; `setTimeout(…, 0)` is clamped to ~1ms by Node and would make a deep drain slow.
const macrotask: () => Promise<void> =
    typeof setImmediate === 'function'
        ? () =>
              new Promise<void>((resolve) => {
                  setImmediate(resolve);
              })
        : () =>
              new Promise<void>((resolve) => {
                  setTimeout(resolve, 0);
              });

/** Yield `turns` times, so anything sitting on the macrotask queue settles. */
export async function drain(turns = 5): Promise<void> {
    for (let i = 0; i < turns; i++) await macrotask();
}

/**
 * Advance `clock` by `totalMs` in `stepMs` slices, draining real macrotasks before the first slice
 * and after every one.
 *
 * `stepMs` only has to be smaller than the smallest interval being measured; it does not have to
 * divide anything evenly.
 */
export async function runOut(
    clock: ManualClock,
    totalMs: number,
    stepMs = 1_000,
): Promise<void> {
    await drain();
    for (let left = totalMs; left > 0;) {
        const slice = Math.min(stepMs, left);
        await clock.advance(slice);
        await drain();
        left -= slice;
    }
}

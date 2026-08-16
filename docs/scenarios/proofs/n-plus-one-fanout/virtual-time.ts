// Driving a `manualClock` when the code under test does a little real async work.
//
// `manualClock.advance(ms)` fires every timer due before the target and drains the MICROTASK queue
// between fires. That is enough for code whose only asynchrony is the clock, and almost everything
// here is that code — the fake vendor is pure in-memory logic with no I/O.
//
// `runOut` exists for the two places it is not. A retry backoff is armed only after the failing
// attempt settles, and a coalescing follower's continuation lands on the microtask queue behind a
// leader that may itself be sleeping. Advancing in slices with a macrotask turn between them means
// a timer armed during slice N is fired by slice N+1 rather than being missed — so a claim can say
// "advance past everything" instead of hand-computing a hundred backoff schedules.
//
// SLICE SIZE IS THE MEASUREMENT RESOLUTION for C5. Arrival times are read off `clock.now()`, so a
// request whose backoff lands at 37.4ms is recorded at the first slice boundary at or after it. At
// `stepMs = 1` that is 1ms buckets, which is exactly the granularity "how many retries land in the
// same millisecond" is asking about.
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

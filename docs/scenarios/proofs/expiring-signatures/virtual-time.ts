// Driving a `manualClock` when the code under test does REAL async work.
//
// `manualClock.advance(ms)` fires every timer due before the target, draining the microtask queue
// between fires. That is enough for code whose only asynchrony is the clock. SigV4 signing is not
// that code: `crypto.subtle.digest`/`sign` are genuinely async and settle on the MACROTASK queue,
// several turns deep (`signRequestV4` chains four HMACs and two digests).
//
// The consequence, measured before this helper existed: a request signed at virtual t=0 had not
// reached the transport by the time `advance` fired the NEXT timer and moved virtual time to
// t=120000 — so the fake server stamped its arrival at 120000 and the ledger reported a 120-second
// signature age for a request that was signed at the last possible moment. A pure artifact: the
// virtual clock jumped while real crypto was still running.
//
// `runOut` removes it by advancing in slices and letting real macrotasks drain between them, so
// every request woken at virtual time T reaches the transport before virtual time leaves T. That is
// the faithful model — real signing takes well under a millisecond, so in production the request
// does arrive at essentially the instant it was signed. Without the drain the instrument
// manufactures the very ageing it is trying to detect, in the library's DISfavour.
import type { ManualClock } from '../../../../packages/core/src/testing';

// Yield one full turn of the event loop.
//
// `setImmediate` rather than `setTimeout(…, 0)`: Node clamps a zero timeout to ~1ms, which made a
// drain deep enough to be reliable (see `drain`) cost tens of milliseconds and a whole run of these
// proofs over a minute. `setImmediate` fires in the check phase — AFTER the poll phase where
// libuv delivers `crypto.subtle`'s threadpool completions — so it observes settled crypto just as
// well, at roughly a thousandth of the cost. `manualClock.advance` keeps using `setTimeout` for its
// own internal drain; this only governs the turns `runOut` adds around it.
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

/**
 * Yield `turns` times.
 *
 * The default is deliberately generous. It is not just `signRequestV4`'s six awaits: the deepest
 * chain in these proofs is a skew CORRECTION — response → `shouldRefresh` → `refresh` → `attempt--`
 * → re-acquire → re-sign → transport — and that path takes no clock wait at all, so a slice
 * boundary landing inside it advances virtual time between the signing and the arrival and reports
 * an age that is pure artifact. Measured at six turns, C7 (c) reported a 1000ms skew on roughly half
 * its runs; at this depth it reports 0 on all of them. Each turn is a `setTimeout(0)`, so the whole
 * drain costs single-digit milliseconds.
 */
export async function drain(turns = 40): Promise<void> {
    for (let i = 0; i < turns; i++) await macrotask();
}

/**
 * Advance `clock` by `totalMs` in `stepMs` slices, draining real macrotasks before the first slice
 * and after every one. Use this instead of a bare `advance()` in any run where signing (or any
 * other real async work) sits between a clock wait and the transport.
 *
 * `stepMs` only has to be smaller than the smallest interval being measured; it does not have to
 * divide anything evenly.
 */
export async function runOut(
    clock: ManualClock,
    totalMs: number,
    stepMs = 30_000,
): Promise<void> {
    await drain();
    for (let left = totalMs; left > 0;) {
        const slice = Math.min(stepMs, left);
        await clock.advance(slice);
        await drain();
        left -= slice;
    }
}

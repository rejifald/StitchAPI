// Pins docs/GAP-AUDIT.md §1.4: throttle `pool:'host'` must pool the rate budget across SEPARATE
// stitch() instances hitting the same host in-process, as throttle.mdx documents.
//
// DETERMINISM — why this was rewritten (root-causing a known real-timer flake): the prior version
// measured a WALL-CLOCK gap between two SERVER-side arrival timestamps (via a real mock server) and
// asserted it was >= 250ms (the '2/s' → 500ms rate spacing). But that spacing is enforced CLIENT-side
// via `clock.sleep`; reading SERVER arrival folded in an unbounded transit / event-loop-lag term
// dominated by the FIRST fetch's cold-start (undici lazy-init + TCP handshake). On a loaded runner
// that skew ate into the 500ms and breached the 250ms floor — a flake that passed on re-run.
//
// Host pooling is a pure CLIENT-side throttle property: the budget is keyed by the request URL's host
// (resilience.ts `hostStates`), so proving it needs NO socket at all. This version drives the rate
// math on a shared `manualClock()` (ADR 0010) over the published `mockAdapter`, exactly like
// clock-seam.spec.ts — with the budget pooled, the second of two independent stitches is gated until
// the clock is advanced. Deterministic, zero wall-clock. (The new download-concurrency-*.spec.ts
// tests, which genuinely need real sockets, avoid this pattern's flake by asserting on-the-wire
// overlap COUNT via the server probe, not a measured timing gap — so they don't inherit it.)
//
// The 500ms figure is the IN-PROCESS limiter's, and ADR 0023 Decision 1 ratified exactly it: a rate
// denotes ONE number — the minimum spacing `per / count` — so `'2/s'` is 500ms between grants with
// the first immediate. `pool:'host'` is what keeps that state in the module-level registry instead of
// a closure-local map, which is the property under test. The store-backed limiter, whose cold-start
// burst the same ADR fixed, is not in play here: no `store` is configured.
import { stitch } from '../../src';
import { manualClock, mockAdapter } from '../../src/testing';

describe('GAP-AUDIT §1.4 — throttle pool:"host" pools the rate budget across instances', () => {
    test('two independent stitches on one host share a 2/s budget — the second is gated in virtual time', async () => {
        const clock = manualClock();
        // One adapter, one host URL, TWO independent stitches (no shared `store`). Pooling can ONLY
        // come from the module-level host registry (resilience.ts `hostStates`), keyed by the URL
        // host — the property under test.
        const api = mockAdapter({ respond: { body: { ok: true } } });
        const a = stitch({
            url: 'https://api.test/pooled',
            adapter: api,
            throttle: { rate: '2/s', pool: 'host' },
            clock,
        });
        const b = stitch({
            url: 'https://api.test/pooled',
            adapter: api,
            throttle: { rate: '2/s', pool: 'host' },
            clock,
        });

        // `.safe()` eagerly drives each call (a cold StitchResult would not start on its own).
        const pa = a.safe();
        const pb = b.safe();

        // First grant is immediate; the second reserves the next 2/s slot (500ms out) and parks on a
        // virtual-time sleep. If the budget were NOT pooled, each instance would own a fresh
        // 0-baseline budget and BOTH would fire at once — callCount 2, pending 0. So `callCount 1 +
        // pending 1` here is precisely the pooling oracle.
        await clock.advance(0);
        expect(api.callCount()).toBe(1);
        expect(clock.pending()).toBe(1);

        // Advance past the 500ms spacing → release the second grant. Both settle; nothing leaks.
        await clock.advance(500);
        await Promise.all([pa, pb]);
        expect(api.callCount()).toBe(2);
        expect(clock.pending()).toBe(0);
    });
});

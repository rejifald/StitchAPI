// C4 — noisy neighbour. With `throttle: { rate }` on a shared seam, does one tenant's burst consume
// other tenants' budget? Measure per-tenant ARRIVAL TIMES on an injected clock.
//
// It does, and the number is exact because the clock is. A seam's throttle re-keys EVERY member
// acquire onto one seam-stable key (`seam:${seamId}`, seam.ts:51-69), so a 20-call burst from one
// customer at `'10/s'` (a 100ms minimum spacing) reserves the next 2000ms of grants and the quiet
// customer's single call leaves at t=2000 instead of t=0.
//
// The concurrency half is sharper still and the capture does not mention it: `concurrency` is a
// FIFO queue over the same shared key (resilience.ts:120-127,159-177), so a quiet tenant is not
// merely slowed, it is queued BEHIND every call the noisy tenant already placed.
//
//   pnpm exec tsx docs/scenarios/proofs/multi-tenant-blast-radius/c4-noisy-neighbour.ts
import { seam } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import type { StitchConfig } from '../../../../packages/core/src/types';
import { FakeVendor } from './fake-vendor';
import { check, checkSeq, finish, heading, note } from './harness';
import { probeStore } from './probe-store';

const NOISY = 'noisy';
const QUIET = 'quiet';
const BURST = 20;

/**
 * One seam, one throttle, `.as()` per customer — the construction the scenario is about. Fires
 * `BURST` calls for the noisy tenant and ONE for the quiet tenant, all in the same tick, then runs
 * the virtual clock out and reports arrival times.
 */
async function noisyNeighbour(
    throttle: NonNullable<StitchConfig['throttle']>,
    slow: Record<string, number> = {},
) {
    const clock = manualClock();
    const store = probeStore();
    const vendor = new FakeVendor({ clock, slow });
    const s = seam({
        baseUrl: 'https://api.vendor.test',
        adapter: vendor.adapter(),
        store,
        clock,
        throttle,
    });
    const call = (t: string) =>
        s.as(t).stitch({ path: '/v1/items', headers: { 'x-tenant': t } });
    const inFlight = [
        ...Array.from({ length: BURST }, () => call(NOISY)({}).safe()),
        call(QUIET)({}).safe(),
    ];
    await clock.advance(120_000);
    await Promise.all(inFlight);
    return { clock, store, vendor };
}

async function main(): Promise<void> {
    heading("C4 — one tenant's burst against everyone else's budget");

    // ── (a) the rate case: the quiet tenant's arrival time ─────────────────────────────────────
    {
        const { vendor } = await noisyNeighbour({ rate: '10/s' });
        const quiet = vendor.arrivals(QUIET);
        const noisy = vendor.arrivals(NOISY);
        check('(a) requests the vendor saw', vendor.calls.length, BURST + 1);
        checkSeq(
            "(a) the quiet tenant's single call left at (virtual ms)",
            quiet,
            [2000],
        );
        check(
            '(a) the noisy burst occupied',
            `${noisy[0]}..${noisy.at(-1)}`,
            '0..1900',
        );
        check(
            '(a) → virtual ms the quiet tenant waited for a budget it did not spend',
            quiet[0],
            2000,
        );
        note(
            "(a) → `'10/s'` is a 100ms MINIMUM SPACING, not a bucket (types.ts:1006-1031)",
            'the burst reserves `nextGrantAt` 20 slots ahead (store.ts:187-231), and the quiet tenant queues behind all of them',
        );
    }

    // ── (b) the budget is ONE key, and `.as()` does not split it ───────────────────────────────
    {
        const { store } = await noisyNeighbour({ rate: '10/s' });
        const rl = store.keys('rl:');
        check('(b) rate-counter keys for 2 different principals', rl.length, 1);
        // The id itself is a process-wide counter (`s1`, `s2`, … — seam.ts:38,233), so the SHAPE is
        // what is asserted. C5 (g) measures what that counter costs across processes.
        check(
            '(b) …and its shape',
            /^rl:seam:s\d+:\d+$/.test(rl[0] ?? ''),
            true,
        );
        check(
            '(b) does the key contain a principal?',
            rl.some((k) => k.includes(NOISY) || k.includes(QUIET)),
            false,
        );
        note('(b) the measured key', rl[0]);
        note(
            '(b) → `seamBucket` re-keys EVERY acquire onto `seam:${seamId}` (seam.ts:51-69)',
            "the member's own key is discarded (`acquire: (_key, opts) => inner.acquire(key, opts)`, seam.ts:64), so nothing a member declares can widen or split the seam budget",
        );
    }

    // ── (c) severity scales with the burst, not with the window ────────────────────────────────
    // `'600/m'` declares the same 100ms spacing as `'10/s'` — the limiter reads only the RATIO — so
    // a "generous per-minute quota" buys the quiet tenant nothing.
    {
        const perMinute = await noisyNeighbour({ rate: '600/m' });
        checkSeq(
            '(c) quiet arrival under `600/m`',
            perMinute.vendor.arrivals(QUIET),
            [2000],
        );
        const slower = await noisyNeighbour({ rate: '2/s' });
        checkSeq(
            '(c) quiet arrival under `2/s`',
            slower.vendor.arrivals(QUIET),
            [10_000],
        );
        note(
            '(c) → the tighter the declared rate, the worse the neighbour damage',
            "a 20-call burst at `2/s` pushed one unrelated customer's single call out by 10 virtual seconds",
        );
    }

    // ── (d) the concurrency case: the quiet tenant is QUEUED, not just paced ───────────────────
    // No `rate` at all — just a cap on simultaneous calls, which is the other half of
    // `ThrottleOptions`. The noisy tenant's calls are slow; the quiet tenant's is instant and still
    // waits for all 20 of them, because the waiter queue is FIFO over one shared key.
    {
        const { vendor } = await noisyNeighbour(
            { concurrency: 2 },
            { [NOISY]: 500 },
        );
        const quiet = vendor.arrivals(QUIET);
        check('(d) requests the vendor saw', vendor.calls.length, BURST + 1);
        checkSeq(
            "(d) the quiet tenant's call left at (virtual ms)",
            quiet,
            [5000],
        );
        check(
            '(d) noisy calls that went out BEFORE it',
            vendor.arrivals(NOISY).filter((at) => at < quiet[0]!).length,
            20,
        );
        note(
            '(d) → concurrency waiters are served FIFO over the shared key (resilience.ts:120-127,159-177)',
            'the quiet tenant is behind the whole queue: it is not slowed proportionally, it is last',
        );
    }

    // ── (e) the isolated baseline, so the numbers above have a zero to be measured against ─────
    // The identical burst with NO shared throttle: the quiet tenant leaves at t=0.
    {
        const clock = manualClock();
        const store = probeStore();
        const vendor = new FakeVendor({ clock });
        const s = seam({
            baseUrl: 'https://api.vendor.test',
            adapter: vendor.adapter(),
            store,
            clock,
        });
        const call = (t: string) =>
            s.as(t).stitch({ path: '/v1/items', headers: { 'x-tenant': t } });
        const inFlight = [
            ...Array.from({ length: BURST }, () => call(NOISY)({}).safe()),
            call(QUIET)({}).safe(),
        ];
        await clock.advance(1000);
        await Promise.all(inFlight);
        checkSeq(
            '(e) quiet arrival with no shared budget',
            vendor.arrivals(QUIET),
            [0],
        );
        check('(e) rate-counter keys written', store.keys('rl:').length, 0);
    }

    finish(
        'C4',
        "CONFIRMED, with an exact number. On a shared seam at `throttle: { rate: \"10/s\" }`, a 20-call burst from ONE customer pushed an unrelated customer's single call from t=0 to t=2000 virtual ms — the noisy tenant occupied 0..1900 and the quiet one queued behind all of it. The budget is one key: two different principals touched exactly ONE key, `rl:seam:s<n>:<window>`, because `seamBucket` DISCARDS the member's key and re-keys every acquire onto `seam:${seamId}` (seam.ts:51-69,64). A longer window does not help — `600/m` declares the same 100ms spacing as `10/s` and measured the same 2000ms — while a tighter one is worse: the same burst at `2/s` cost the quiet tenant 10 virtual seconds. THE CONCURRENCY HALF IS SHARPER AND THE CAPTURE DOES NOT MENTION IT: with `concurrency: 2` and no rate at all, the quiet tenant's instant call left at t=5000 with all 20 of the noisy tenant's slow calls ahead of it, because waiters are served FIFO over the same shared key (resilience.ts:120-127,159-177) — it is not slowed proportionally, it is last. The isolated baseline for all of these is t=0",
    );
}

void main();

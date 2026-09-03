// C5 — can `StitchStore` serve as the dedup ledger from USER code? Durable, TTL beyond the retry
// window? Measure a duplicate delivery being skipped, and the TTL boundary.
//
// The capture inherits an open question from scenario 4 — "the store is engine state, so whether a
// user can borrow it cleanly is open". That framing is backwards, and this script measures why:
// `store` is a config key the USER supplies (types.ts:1583-1584), and `memoryStore` is a public
// export (index.ts:62). Nothing is borrowed. You construct the store, use it as your ledger, and
// hand the same instance to the engine — one Redis connection serving both.
//
// Two findings the capture does not predict:
//
//   • `get`-then-`set` is a RACE, and the store already ships the fix. Two concurrent handlers for
//     one event id both read `undefined` and both process. `increment` is atomic and returns 1 and
//     2, so exactly one processes. Measured in (b).
//   • `memoryStore`'s TTL reads `Date.now()` (store.ts:16,45,54 via util.ts:4) and ignores an
//     injected clock entirely, so the boundary of a 3-DAY dedup window is not testable against it
//     at all. Measured in (d), where a `manualClock` advanced four virtual days changes nothing.
//
//   pnpm exec tsx docs/scenarios/proofs/webhook-receipt/c5-dedup-ledger.ts
import { memoryStore, stitch } from '../../../../packages/core/src/index';
import {
    conformance,
    manualClock,
} from '../../../../packages/core/src/testing';
import type { Adapter, StitchStore } from '../../../../packages/core/src/types';
import { clockStore } from './clock-store';
import { check, checkSeq, finish, heading, note } from './harness';

/** Stripe retries a failed delivery for up to 3 days. The ledger has to outlive that. */
const RETRY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
/** …so the TTL is set beyond it. This is the number the whole claim turns on. */
const DEDUP_TTL_MS = 4 * 24 * 60 * 60 * 1000;

/** The ledger, written the way a handler would write it. Racy on purpose — see `claimAtomic`. */
async function claimNaive(
    store: StitchStore,
    eventId: string,
): Promise<boolean> {
    if ((await store.get(`webhook:${eventId}`)) !== undefined) return false;
    await store.set(`webhook:${eventId}`, 1, DEDUP_TTL_MS);
    return true;
}

/** The same ledger on the store's atomic verb. First caller gets 1; everyone else loses. */
async function claimAtomic(
    store: StitchStore,
    eventId: string,
): Promise<boolean> {
    return (await store.increment(`webhook:${eventId}`, DEDUP_TTL_MS)) === 1;
}

async function main(): Promise<void> {
    heading('C5 — StitchStore as a dedup ledger, from user code');

    // ── (a) the ownership direction, and a duplicate actually skipped ──────────────────────────
    // The user makes the store. The engine is handed the same one. Nothing is extracted from
    // anything.
    {
        // Wrap the store so every key either side touches is recorded — the evidence that ONE
        // instance is carrying both the dedup ledger and the engine's own state.
        const inner = memoryStore();
        const touched: string[] = [];
        const store: StitchStore = {
            get: (k) => {
                touched.push(k);
                return inner.get(k);
            },
            set: (k, v, ttl) => {
                touched.push(k);
                return inner.set(k, v, ttl);
            },
            increment: (k, ttl) => {
                touched.push(k);
                return inner.increment(k, ttl);
            },
            close: () => inner.close?.() ?? Promise.resolve(),
        };
        let sideEffects = 0;
        const provision: Adapter = async () => {
            sideEffects++;
            return { status: 200, headers: {}, body: { ok: true } };
        };
        const act = stitch({
            url: 'https://api.billing.test/v1/provision',
            method: 'POST',
            adapter: provision,
            store, // ← the SAME instance the ledger uses
            // A rate gives the engine a reason to write to the store, so "shared" is measurable
            // rather than asserted.
            throttle: { rate: '100/s' },
        });

        // Delivery, then the provider's at-least-once retry of the identical event.
        const outcomes: string[] = [];
        for (const attempt of ['first', 'retry', 'retry']) {
            if (await claimNaive(store, 'evt_1PqR')) {
                await act({ body: { sub: 'sub_1' } });
                outcomes.push(`${attempt}:processed`);
            } else {
                outcomes.push(`${attempt}:skipped`);
            }
        }
        checkSeq('(a) three deliveries of one event id', outcomes, [
            'first:processed',
            'retry:skipped',
            'retry:skipped',
        ]);
        check('(a) side effects performed', sideEffects, 1);
        check(
            '(a) the ledger wrote its own keys to that store',
            touched.some((k) => k.startsWith('webhook:')),
            true,
        );
        check(
            '(a) …and the ENGINE wrote its throttle counter to the same instance',
            touched.some((k) => k.startsWith('rl:')),
            true,
        );
        note(
            '(a) → `store` is a config key the USER supplies (types.ts:1583-1584)',
            '`memoryStore()` is a public export (index.ts:62); the ledger owns it and lends it to the engine, not the other way round',
        );
        await store.close?.();
    }

    // ── (b) get-then-set is a race; `increment` is not ─────────────────────────────────────────
    // Two workers pulling the same event off the wire at once. This is the normal case at any
    // scale above one process, and the naive ledger double-processes.
    {
        const store = memoryStore();
        const naive = await Promise.all([
            claimNaive(store, 'evt_race'),
            claimNaive(store, 'evt_race'),
            claimNaive(store, 'evt_race'),
        ]);
        checkSeq('(b) `get`-then-`set`, 3 concurrent claims', naive, [
            true,
            true,
            true,
        ]);
        check(
            '(b) → how many handlers would have charged the card?',
            naive.filter(Boolean).length,
            3,
        );

        const atomic = await Promise.all([
            claimAtomic(store, 'evt_race_atomic'),
            claimAtomic(store, 'evt_race_atomic'),
            claimAtomic(store, 'evt_race_atomic'),
        ]);
        checkSeq('(b) `increment`, 3 concurrent claims', atomic, [
            true,
            false,
            false,
        ]);
        check(
            '(b) → how many handlers charge the card?',
            atomic.filter(Boolean).length,
            1,
        );
        note(
            '(b) → the atomic verb is already in the contract',
            '`increment(key, ttl)` (types.ts:1969-1970) exists for the throttle counter and is exactly the dedup primitive',
        );
        await store.close?.();
    }

    // ── (c) the TTL boundary, on a clock-backed store ──────────────────────────────────────────
    // A 4-day TTL against a 3-day retry window. The boundary is `expires > now` (store.ts:16), so
    // the entry is live up to and including the last tick before expiry and gone on it.
    {
        const clock = manualClock();
        const store = clockStore(clock);
        await claimAtomic(store, 'evt_ttl');

        const probe: string[] = [];
        // t = retry window: a Stripe retry at the far edge of its window.
        await clock.advance(RETRY_WINDOW_MS);
        probe.push(
            (await claimAtomic(store, 'evt_ttl')) ? 'processed' : 'skipped',
        );
        // t = ttl - 1ms.
        await clock.advance(DEDUP_TTL_MS - RETRY_WINDOW_MS - 1);
        probe.push(
            (await claimAtomic(store, 'evt_ttl')) ? 'processed' : 'skipped',
        );
        // t = ttl exactly — `expires > now` is now false.
        await clock.advance(1);
        probe.push(
            (await claimAtomic(store, 'evt_ttl')) ? 'processed' : 'skipped',
        );

        checkSeq('(c) claims at t = 3d, ttl-1ms, ttl', probe, [
            'skipped',
            'skipped',
            'processed',
        ]);
        check(
            '(c) does the ledger cover the whole retry window?',
            probe[0] === 'skipped' && probe[1] === 'skipped',
            true,
        );
        note(
            '(c) → the boundary is `expires > now`, exclusive (store.ts:16)',
            'a TTL equal to the retry window would let the last retry through; 4 days over 3 leaves a day of margin',
        );
        await store.close?.();
    }

    // ── (d) …and that boundary is NOT testable against `memoryStore` ──────────────────────────
    // The trap scenario 6 measured, in the shape this scenario hits it: `memoryStore` takes no
    // clock and reads `Date.now()`, so no amount of virtual time expires anything.
    {
        check(
            '(d) `memoryStore` arity (a clock-aware store would take one)',
            memoryStore.length,
            0,
        );
        const clock = manualClock();
        const store = memoryStore();
        await claimAtomic(store, 'evt_virtual');
        await clock.advance(DEDUP_TTL_MS + 24 * 60 * 60 * 1000); // four days, then some
        const afterFourVirtualDays = await claimAtomic(store, 'evt_virtual');
        check(
            '(d) claim again after FOUR virtual days → processed?',
            afterFourVirtualDays,
            false,
        );
        check(
            '(d) virtual ms advanced',
            clock.now(),
            DEDUP_TTL_MS + 86_400_000,
        );
        note(
            '(d) → the injected clock is ignored (store.ts:16,45,54 via util.ts:4)',
            'the key is still live because `Date.now()` has not moved. A 3-day TTL cannot be boundary-tested without a clock-backed store',
        );
        await store.close?.();
    }

    // ── (e) durability: what `memoryStore` costs you, and that the swap is contract-tested ─────
    {
        // The in-memory default conflates "release the handle" with "drop the data".
        const mem = memoryStore();
        await claimAtomic(mem, 'evt_restart');
        await mem.close?.();
        const survived = !(await claimAtomic(mem, 'evt_restart'));
        check(
            '(e) memoryStore: did the ledger survive `close()`?',
            survived,
            false,
        );
        note(
            '(e) → `memoryStore.close()` is `data.clear()` (store.ts:59-61)',
            "a deploy inside Stripe's 3-day window re-processes every event still being retried",
        );

        // A durable store is the same interface with the data outside the handle. Two successive
        // stores over one backing map = the process restarted.
        const clock = manualClock();
        const disk = new Map<string, { value: unknown; expires: number }>();
        const before = clockStore(clock, disk);
        await claimAtomic(before, 'evt_restart');
        await before.close?.();
        const after = clockStore(clock, disk);
        const stillDeduped = !(await claimAtomic(after, 'evt_restart'));
        check(
            '(e) durable store: ledger survived a restart?',
            stillDeduped,
            true,
        );

        // And the swap is not a leap of faith: the contract suite ships.
        const report = await conformance.store(() =>
            clockStore(
                {
                    now: () => Date.now(),
                    setTimer: setTimeout,
                    clearTimer: clearTimeout,
                    sleep: async () => undefined,
                },
                new Map(),
            ),
        );
        conformance.assert(report);
        check('(e) `conformance.store` on the BYO store → ok', report.ok, true);
        check('(e) → rules passed', report.passed.length, 11);
        check('(e) → violations', report.violations.length, 0);
        note(
            '(e) → `redisStore` / `cloudflareKvStore` / `denoKvStore` implement this same interface',
            'the durable ledger is a one-line config change, and `conformance.store` (testing.ts:185) proves a BYO one conforms',
        );
    }

    finish(
        'C5',
        'YES, and the capture\'s open question has the ownership backwards. `store` is a config key the USER supplies (types.ts:1583-1584) and `memoryStore()` is a public export (index.ts:62) — nothing is borrowed from the engine; the ledger constructs the store and lends the same instance to the stitch. Three deliveries of one event id measured ["first:processed","retry:skipped","retry:skipped"] with exactly 1 side effect. TWO FINDINGS THE CAPTURE MISSES. First, `get`-then-`set` is a race the store already fixes: 3 concurrent claims on one id returned [true,true,true] — three charges — while `increment(key, ttl)` (types.ts:1969-1970) returned [true,false,false], exactly one. Second, the TTL boundary is exact but only against a clock-backed store: with a 4-day TTL over Stripe\'s 3-day window, claims at t=3d and t=ttl-1ms both skipped and t=ttl processed (the boundary is `expires > now`, exclusive, store.ts:16) — whereas `memoryStore` takes no clock (arity 0) and after FOUR virtual days on a `manualClock` the key was still live, so a 3-day window cannot be boundary-tested against it at all. Durability is the real gap in the default: `memoryStore.close()` is `data.clear()` (store.ts:59-61), so the ledger did not survive, and a deploy inside the retry window re-processes everything still in flight. The swap is first-class — a BYO durable store over the same interface survived a restart and passed all 11 rules of `conformance.store` (testing.ts:185) with 0 violations',
    );
}

void main();

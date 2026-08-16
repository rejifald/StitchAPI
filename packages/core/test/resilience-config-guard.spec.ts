// Issue #651 §3 — a `backoff` the retry loop cannot read must THROW at construction, the way an
// unparseable `throttle.rate` already does (`bad rate: …`, util.ts `rate.parse`), rather than
// degrading to a default nobody asked for. The message names the slot the way that precedent
// does — `bad backoff` — but stops there rather than quoting the value: the entry's gzip gate had
// one byte left for this whole check, and the interpolation cost five. The offending value is in
// the caller's own `stitch({…})` literal, which is what makes that trade survivable.
//
// The reported case: `backoff: () => 6000` is correctly a TYPE error, but a cast past it (which
// people write when they believe a feature exists) constructed clean and then never invoked the
// function — `expandShorthand` folds the bare form into `{ curve: <fn> }`, `backoffDelay` matches
// neither `'fixed'` nor `'expo-jitter'`, and the wait silently became the plain `expo` curve on the
// default 100ms base. Measured gaps of 100, 200ms where the config asked for 6000. Because the fold
// runs first, every authoring spelling of the slot lands on `curve`, so the cases below are one
// check seen from four directions rather than four checks.
//
// The other resilience slots were swept for the same defect and are NOT guarded here — the core
// entry's gzip budget is measured in tens of bytes and this check spends ~34 of them; see the PR
// for the measured cost of extending to each. What they still do on a value cast past the type is therefore unchanged,
// and the last block below is the part that matters for them: no legitimate shape may start
// throwing as a side effect of this one.
import { stitch } from '../src';
import type { StitchConfig } from '../src/types';

// A construction attempt with a value the type system rejects — the cast IS the reported scenario.
const bad = (extra: Record<string, unknown>) => () =>
    stitch({ url: 'https://example.test/x', ...extra } as never);
// The same, for a config that is legal and must keep constructing. Deliberately NOT cast: these
// have to typecheck as well as run.
const ok = (extra: Partial<StitchConfig>) => () =>
    stitch({ url: 'https://example.test/x', ...extra });

describe('an unusable `backoff` throws at construction (#651 §3)', () => {
    test('the function form — a type error, and a cast past it no longer vanishes', () => {
        // The reported reproduction: typechecked, then vanished, before this guard existed.
        expect(bad({ retry: { attempts: 3, backoff: () => 6000 } })).toThrow(
            /^bad backoff$/,
        );
    });

    test('a curve name that is not one of the three', () => {
        expect(bad({ retry: { attempts: 3, backoff: 'exponential' } })).toThrow(
            /^bad backoff$/,
        );
        expect(
            bad({ retry: { attempts: 3, backoff: { curve: 'linear' } } }),
        ).toThrow(/^bad backoff$/);
    });

    test('a bare number — `backoff: 6000` is not the P12 shorthand (`curve` is)', () => {
        expect(bad({ retry: { attempts: 3, backoff: 6000 } })).toThrow(
            /^bad backoff$/,
        );
    });

    test('the shorthand fold is what makes one check cover every spelling', () => {
        // Not an object ⇒ the bare form ⇒ folded onto `curve`, whatever it was.
        expect(bad({ retry: { attempts: 3, backoff: ['expo'] } })).toThrow(
            /^bad backoff$/,
        );
        expect(bad({ retry: { attempts: 3, backoff: null } })).toThrow(
            /^bad backoff$/,
        );
    });

    test('it throws at CONSTRUCTION, not on the first retry', () => {
        // The distinction the issue asks for: nothing is called, and it still fails.
        let built = false;
        expect(() => {
            stitch({
                url: 'https://example.test/x',
                retry: { attempts: 3, backoff: 'exponential' },
            } as never);
            built = true;
        }).toThrow(/^bad backoff$/);
        expect(built).toBe(false);
    });

    test('the precedent this mirrors: `throttle.rate` already threw at construction', () => {
        expect(bad({ throttle: 'fast' })).toThrow(/bad rate: fast/);
    });
});

describe('every legitimate resilience shape still constructs', () => {
    test('all three curves, in both the bare and the envelope spelling', () => {
        for (const curve of ['expo', 'expo-jitter', 'fixed'] as const) {
            expect(
                ok({ retry: { attempts: 3, backoff: curve } }),
            ).not.toThrow();
            expect(
                ok({ retry: { attempts: 3, backoff: { curve } } }),
            ).not.toThrow();
        }
    });

    test('a `backoff` envelope that sets no curve keeps the default', () => {
        expect(
            ok({ retry: { attempts: 3, backoff: { base: 50 } } }),
        ).not.toThrow();
        expect(
            ok({ retry: { attempts: 3, backoff: { base: '1s', max: '10s' } } }),
        ).not.toThrow();
    });

    test('numbers and duration tokens on every widened slot (P17)', () => {
        expect(
            ok({
                retry: {
                    attempts: 3,
                    on: 429,
                    respect: false,
                    backoff: { curve: 'expo', base: '1s', max: 10_000 },
                },
                timeout: { total: '10s', each: 3000 },
                throttle: { rate: '2/s', concurrency: 4, lease: '45s' },
                circuit: { failures: 5, cooldown: 30_000 },
            }),
        ).not.toThrow();
    });

    test('the scalar shorthands and the positional circuit tuple', () => {
        expect(ok({ retry: 3 })).not.toThrow();
        expect(ok({ timeout: '5s' })).not.toThrow();
        expect(ok({ timeout: 5000 })).not.toThrow();
        expect(ok({ throttle: '2/s' })).not.toThrow();
        expect(ok({ circuit: [5, '30s'] })).not.toThrow();
    });

    test('an omitted slot, and a slot whose guarded field is omitted', () => {
        expect(ok({})).not.toThrow();
        expect(ok({ retry: { on: 503 } })).not.toThrow();
        expect(ok({ timeout: { total: '1s' } })).not.toThrow();
        expect(ok({ throttle: { pool: 'host', rate: '1/s' } })).not.toThrow();
        // `circuit` with neither required field still defers to `createCircuit`'s
        // required-by-design throw at CALL time (CONTRACT.md P15) — this guard must not pre-empt it.
        expect(ok({ circuit: { key: 'k' } })).not.toThrow();
    });
});

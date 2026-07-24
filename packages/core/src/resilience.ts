// Resilience primitives: retry backoff math, Retry-After parsing, a proactive
// throttle (rate + concurrency, per key), and a timeout wrapper. Dependency-free;
// pacing/cancellation go through the shared `sleep`/`now` helpers from `./util`.
import type {
    AcquireOptions,
    AdapterResponse,
    CircuitOptions,
    Clock,
    RetryOptions,
    StitchStore,
    ThrottleOptions,
} from './types';
import { parseDuration, parseRate, systemClock } from './util';

export class TimeoutError extends Error {}

/**
 * Backoff (ms) BEFORE the given 1-based `attempt` (attempt=2 is the first retry).
 * 'expo' = base * 2^(attempt-2); 'expo-jitter' adds random jitter in [0, computed];
 * 'fixed' = base. Result is clamped to max.
 */
export function backoffDelay(attempt: number, opts?: RetryOptions): number {
    const kind = opts?.backoff ?? 'expo-jitter';
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- `baseMs` is the @deprecated alias of `baseDelay`, read for back-compat until the GA cut (CONTRACT.md P17)
    const base = parseDuration(opts?.baseDelay ?? opts?.baseMs) ?? 100;
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- `maxMs` is the @deprecated alias of `maxDelay`, read for back-compat until the GA cut (CONTRACT.md P17)
    const max = parseDuration(opts?.maxDelay ?? opts?.maxMs) ?? 10_000;
    const exp = Math.max(0, attempt - 2); // attempt 2 -> 2^0
    let delay: number;
    if (kind === 'fixed') {
        delay = base;
    } else {
        const computed = base * 2 ** exp;
        delay = kind === 'expo-jitter' ? Math.random() * computed : computed;
    }
    return Math.min(delay, max);
}

/** Parse a `Retry-After` header (delta-seconds OR HTTP-date) into ms, or undefined. */
export function parseRetryAfter(
    headerValue?: string,
    clock: Clock = systemClock,
): number | undefined {
    if (headerValue == null) return undefined;
    const raw = headerValue.trim();
    if (raw === '') return undefined;
    if (/^\d+$/.test(raw)) return parseInt(raw, 10) * 1000;
    const when = Date.parse(raw); // HTTP-date
    if (Number.isNaN(when)) return undefined;
    return Math.max(0, when - clock.now());
}

interface KeyState {
    inFlight: number;
    waiters: (() => void)[]; // FIFO concurrency waiters; each resolves its acquire
    nextGrantAt: number; // earliest time the next rate-limited acquire may proceed
}

// In-process registry of host-pooled limiter state. `pool:'host'` must pool the rate
// budget across SEPARATE stitch() instances hitting the same host even without a shared
// store (throttle.mdx: "'host' pools the budget across every stitch hitting the same
// host"). Closure-local maps can't do that, so host-pooled throttles share their KeyState
// here, keyed by the host. A configured `store` still overrides for cross-process pooling.
const hostStates = new Map<string, KeyState>();

/**
 * Proactive limiter. `rate` ("2/s") enforces a minimum spacing between successive
 * acquires for a key; `concurrency` caps simultaneous in-flight holders for a key.
 * `acquire` resolves once a slot is free (reporting how long it waited) and MUST be
 * paired with `release`. Concurrency waiters are served FIFO.
 *
 * With `pool:'host'`, per-key state lives in the module-level `hostStates` registry so the
 * budget pools in-process across independent stitch instances; `pool:'stitch'` (default)
 * keeps state closure-local to this limiter.
 */
export function createThrottle(
    opts?: ThrottleOptions,
    clock: Clock = systemClock,
): {
    acquire(key: string, opts?: AcquireOptions): Promise<{ waited: number }>;
    release(key: string): void;
} {
    const limit = opts?.concurrency;
    const rate = opts?.rate ? parseRate(opts.rate) : undefined;
    const spacing = rate ? rate.per / rate.count : 0; // ms between grants
    const hostPooled = opts?.pool === 'host';
    const states = hostPooled ? hostStates : new Map<string, KeyState>();

    const stateFor = (key: string): KeyState => {
        let s = states.get(key);
        if (!s) {
            s = { inFlight: 0, waiters: [], nextGrantAt: 0 };
            states.set(key, s);
        }
        return s;
    };

    // Resolves once this acquire holds a concurrency slot (immediately if there is
    // capacity, otherwise when an earlier holder releases). No-op when unbounded.
    const takeSlot = (s: KeyState): Promise<void> => {
        if (limit == null) return Promise.resolve();
        if (s.inFlight < limit) {
            s.inFlight++;
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => s.waiters.push(resolve));
    };

    async function acquire(
        key: string,
        acqOpts?: AcquireOptions,
    ): Promise<{ waited: number }> {
        const s = stateFor(key);
        let waited = 0;
        // A rate-only acquire (a streaming surface — ADR 0005 Decision 12) skips the concurrency
        // slot entirely: it never takes (or, lacking a paired release, holds) one. It still paces
        // on the rate budget below, so opening a stream is counted against the rate limiter.
        if (!acqOpts?.rateOnly) {
            // Only a real concurrency block counts as "waited" — not incidental scheduling
            // jitter — so `waited` (and the 'throttled' event) is deterministic.
            const blocked = limit != null && s.inFlight >= limit;
            const blockStart = clock.now();
            await takeSlot(s); // gate entry on concurrency first
            if (blocked) waited = clock.now() - blockStart;
        }
        if (spacing > 0) {
            // Then pace within the held slot: reserve the next grant time and wait for it.
            const at = Math.max(clock.now(), s.nextGrantAt);
            s.nextGrantAt = at + spacing;
            const wait = at - clock.now();
            if (wait > 0) {
                await clock.sleep(wait);
                waited += wait;
            }
        }
        return { waited };
    }

    function release(key: string): void {
        const s = states.get(key);
        if (!s || limit == null) return;
        const next = s.waiters.shift();
        if (next)
            next(); // hand the held slot directly to the FIFO-next waiter
        else if (s.inFlight > 0) s.inFlight--;
        // Drop a fully-idle key's state so the per-key Map (or the shared `hostStates` registry)
        // doesn't accumulate one entry per ever-seen key over long uptime. Only when nothing is
        // in flight, no one is queued, AND no future rate grant is still reserved — deleting a key
        // whose `nextGrantAt` is in the future would reset its pacing and let the next acquire
        // burst, so a still-pacing key is kept until its reservation lapses.
        if (
            s.inFlight === 0 &&
            s.waiters.length === 0 &&
            s.nextGrantAt <= clock.now()
        )
            states.delete(key);
    }

    const api = { acquire, release };
    // Non-enumerable test probe: the live per-key state Map, so the resource-leak suite can assert
    // an idle key's entry is dropped after its last release. Not on the public return type.
    Object.defineProperty(api, THROTTLE_STATES, {
        value: states,
        enumerable: false,
    });
    return api;
}

/** Internal: keys the non-enumerable per-key state Map probe used by the resource-leak suite. */
export const THROTTLE_STATES = Symbol('stitch.throttle.states');

// The Error to reject with when a linked signal is already aborted — its own `reason` when that is
// an Error (the default AbortError, or a caller-supplied one), else a generic abort Error.
function abortError(signal: AbortSignal): Error {
    const reason: unknown = signal.reason;
    return reason instanceof Error
        ? reason
        : new Error('the operation was aborted');
}

/**
 * Run `fn` with an AbortSignal that aborts after `ms`. On timeout, reject with TimeoutError and
 * ensure the signal is aborted. If `ms` is undefined, just run `fn` with a non-aborting signal.
 * An optional `linkSignal` (a caller's `AbortSignal`, e.g. on a `download` — ADR 0005 Decision 8)
 * is mirrored onto this attempt: aborting it cancels the call. The listener is cleaned up when `fn`
 * settles; an already-aborted `linkSignal` rejects before `fn` runs.
 */
export function withTimeout<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    ms?: number,
    linkSignal?: AbortSignal,
    clock: Clock = systemClock,
): Promise<T> {
    const controller = new AbortController();
    let unlink: (() => void) | undefined;
    if (linkSignal) {
        if (linkSignal.aborted) return Promise.reject(abortError(linkSignal));
        const onAbort = () => {
            controller.abort(linkSignal.reason);
        };
        linkSignal.addEventListener('abort', onAbort, { once: true });
        unlink = () => {
            linkSignal.removeEventListener('abort', onAbort);
        };
    }
    if (ms == null) {
        const out = fn(controller.signal);
        return unlink ? out.finally(unlink) : out;
    }
    return new Promise<T>((resolve, reject) => {
        const timer = clock.setTimer(() => {
            controller.abort();
            reject(new TimeoutError(`timed out after ${ms}ms`));
        }, ms);
        fn(controller.signal).then(
            (value) => {
                clock.clearTimer(timer);
                unlink?.();
                resolve(value);
            },
            (err) => {
                clock.clearTimer(timer);
                unlink?.();
                reject(err);
            },
        );
    });
}

/** Thrown (and surfaced as an `error` event) when a stitch fast-fails because its breaker is open. */
export class CircuitOpenError extends Error {
    readonly status = 503;
    constructor(message = 'circuit open') {
        super(message);
        this.name = 'CircuitOpenError';
    }
}

/**
 * Thrown (and surfaced as an `error` event) when a stitch runs in **delegate-backoff** mode
 * (`rateLimit.delegate`) and the response carries a rate-limit status (default `429`). Instead of
 * retrying internally or pacing on the built-in throttle, the engine surfaces the outcome so an
 * OUTER gate/circuit — owned by the host — decides the backoff (issue #145). Carries the structured
 * signal that gate needs: the `status`, the `retryAfter` parsed from `Retry-After` (delta-seconds
 * OR HTTP-date; `undefined` when the header is absent/unparseable), and the raw `response` so the
 * host can read other rate headers (`X-RateLimit-*`, etc.). The full `response` rides on the live
 * instance only — never the serialized `error` event — so it cannot leak into a trace sink.
 */
export class RateLimitError extends Error {
    readonly status: number;
    /** `Retry-After` parsed to ms (delta-seconds OR HTTP-date); `undefined` when absent/unparseable. */
    readonly retryAfter: number | undefined;
    /** @deprecated Renamed to {@link RateLimitError.retryAfter} (CONTRACT.md P17). Read until the 1.0 GA cut. */
    readonly retryAfterMs: number | undefined;
    readonly response: AdapterResponse;
    constructor(opts: {
        status: number;
        retryAfter?: number | undefined;
        /** @deprecated Use `retryAfter` (CONTRACT.md P17). */
        retryAfterMs?: number | undefined;
        response: AdapterResponse;
        message?: string;
    }) {
        super(opts.message ?? `rate limited (HTTP ${opts.status})`);
        this.name = 'RateLimitError';
        this.status = opts.status;
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- read the @deprecated constructor alias for back-compat (CONTRACT.md P17)
        this.retryAfter = opts.retryAfter ?? opts.retryAfterMs;
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- co-set the @deprecated field alias for back-compat (CONTRACT.md P17)
        this.retryAfterMs = this.retryAfter;
        this.response = opts.response;
    }
}

export type CircuitPhase = 'closed' | 'open' | 'half-open';
interface CircuitRecord {
    failures: number; // consecutive failures
    openedAt: number; // epoch ms the breaker opened; 0 = closed
}

/**
 * A store-backed circuit breaker. After `failures` consecutive failures it OPENS:
 * calls fast-fail for `cooldown`, then it goes HALF-OPEN and lets a single trial through —
 * a success closes it, another failure re-opens it. State lives in the StitchStore, so a shared
 * store gives a breaker shared across workers (DESIGN.md §13).
 *
 * `failures` and `cooldown` are required by design (CONTRACT.md P15); this throws if neither they
 * nor their deprecated `failureThreshold`/`cooldownMs` aliases are set.
 */
export function createCircuit(
    opts: CircuitOptions,
    store: StitchStore,
    fallbackKey: string,
    clock: Clock = systemClock,
): {
    phase(): Promise<CircuitPhase>;
    onSuccess(): Promise<void>;
    onFailure(): Promise<boolean>;
} {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- `failureThreshold` is the @deprecated alias of `failures` (CONTRACT.md P4)
    const failureThreshold = opts.failures ?? opts.failureThreshold;
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- `cooldownMs` is the @deprecated alias of `cooldown` (CONTRACT.md P17)
    const cooldown = parseDuration(opts.cooldown ?? opts.cooldownMs);
    if (failureThreshold == null || cooldown == null)
        throw new Error(
            'circuit requires `failures` and `cooldown`. Fix: set both, e.g. `circuit: { failures: 5, cooldown: "30s" }`.',
        );
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- `halfOpenAfterMs` is the @deprecated alias of `halfOpenAfter` (CONTRACT.md P17)
    const halfOpenInput = opts.halfOpenAfter ?? opts.halfOpenAfterMs;
    const halfOpenAfter = parseDuration(halfOpenInput) ?? cooldown;
    const nsKey = 'circuit:' + (opts.key ?? fallbackKey);

    const read = async (): Promise<CircuitRecord> =>
        ((await store.get(nsKey)) as CircuitRecord | undefined) ?? {
            failures: 0,
            openedAt: 0,
        };

    return {
        // Current phase given the clock: closed, open (fast-fail), or half-open (one trial).
        async phase(): Promise<CircuitPhase> {
            const r = await read();
            if (r.openedAt === 0) return 'closed';
            return clock.now() - r.openedAt >= halfOpenAfter
                ? 'half-open'
                : 'open';
        },
        // A success closes the breaker and clears the failure count.
        async onSuccess(): Promise<void> {
            await store.set(nsKey, { failures: 0, openedAt: 0 });
        },
        // A failure increments the count; returns true iff THIS failure opened the breaker.
        async onFailure(): Promise<boolean> {
            const r = await read();
            const failures = r.failures + 1;
            const wasOpen = r.openedAt !== 0;
            if (wasOpen || failures >= failureThreshold) {
                // (re)open — arm a fresh cooldown window.
                await store.set(nsKey, { failures, openedAt: clock.now() });
                return !wasOpen; // "newly opened" only when it had been closed
            }
            await store.set(nsKey, { failures, openedAt: 0 });
            return false;
        },
    };
}

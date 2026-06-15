// Resilience primitives: retry backoff math, Retry-After parsing, a proactive
// throttle (rate + concurrency, per key), and a timeout wrapper. Dependency-free;
// pacing/cancellation go through the shared `sleep`/`now` helpers from `./util`.
import type {
    CircuitOptions,
    RetryOptions,
    StitchStore,
    ThrottleOptions,
} from './types';
import { now, parseRate, sleep } from './util';

export class TimeoutError extends Error {}

/**
 * Backoff (ms) BEFORE the given 1-based `attempt` (attempt=2 is the first retry).
 * 'expo' = baseMs * 2^(attempt-2); 'expo-jitter' adds random jitter in [0, computed];
 * 'fixed' = baseMs. Result is clamped to maxMs.
 */
export function backoffDelay(attempt: number, opts?: RetryOptions): number {
    const kind = opts?.backoff ?? 'expo-jitter';
    const baseMs = opts?.baseMs ?? 100;
    const maxMs = opts?.maxMs ?? 10_000;
    const exp = Math.max(0, attempt - 2); // attempt 2 -> 2^0
    let delay: number;
    if (kind === 'fixed') {
        delay = baseMs;
    } else {
        const computed = baseMs * 2 ** exp;
        delay = kind === 'expo-jitter' ? Math.random() * computed : computed;
    }
    return Math.min(delay, maxMs);
}

/** Parse a `Retry-After` header (delta-seconds OR HTTP-date) into ms, or undefined. */
export function parseRetryAfter(headerValue?: string): number | undefined {
    if (headerValue == null) return undefined;
    const raw = headerValue.trim();
    if (raw === '') return undefined;
    if (/^\d+$/.test(raw)) return parseInt(raw, 10) * 1000;
    const when = Date.parse(raw); // HTTP-date
    if (Number.isNaN(when)) return undefined;
    return Math.max(0, when - now());
}

interface KeyState {
    inFlight: number;
    waiters: (() => void)[]; // FIFO concurrency waiters; each resolves its acquire
    nextGrantAt: number; // earliest time the next rate-limited acquire may proceed
}

// In-process registry of host-scoped limiter state. `scope:'host'` must pool the rate
// budget across SEPARATE stitch() instances hitting the same host even without a shared
// store (throttle.mdx: "'host' pools the budget across every stitch hitting the same
// host"). Closure-local maps can't do that, so host-scoped throttles share their KeyState
// here, keyed by the host. A configured `store` still overrides for cross-process pooling.
const hostStates = new Map<string, KeyState>();

/**
 * Proactive limiter. `rate` ("2/s") enforces a minimum spacing between successive
 * acquires for a key; `concurrency` caps simultaneous in-flight holders for a key.
 * `acquire` resolves once a slot is free (reporting how long it waited) and MUST be
 * paired with `release`. Concurrency waiters are served FIFO.
 *
 * With `scope:'host'`, per-key state lives in the module-level `hostStates` registry so the
 * budget pools in-process across independent stitch instances; `scope:'stitch'` (default)
 * keeps state closure-local to this limiter.
 */
export function createThrottle(opts?: ThrottleOptions): {
    acquire(key: string): Promise<{ waitedMs: number }>;
    release(key: string): void;
} {
    const limit = opts?.concurrency;
    const rate = opts?.rate ? parseRate(opts.rate) : undefined;
    const spacing = rate ? rate.perMs / rate.count : 0; // ms between grants
    const states =
        opts?.scope === 'host' ? hostStates : new Map<string, KeyState>();

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

    async function acquire(key: string): Promise<{ waitedMs: number }> {
        const s = stateFor(key);
        // Only a real concurrency block counts as "waited" — not incidental scheduling
        // jitter — so waitedMs (and the 'throttled' event) is deterministic.
        const blocked = limit != null && s.inFlight >= limit;
        const blockStart = now();
        await takeSlot(s); // gate entry on concurrency first
        let waitedMs = blocked ? now() - blockStart : 0;
        if (spacing > 0) {
            // Then pace within the held slot: reserve the next grant time and wait for it.
            const at = Math.max(now(), s.nextGrantAt);
            s.nextGrantAt = at + spacing;
            const wait = at - now();
            if (wait > 0) {
                await sleep(wait);
                waitedMs += wait;
            }
        }
        return { waitedMs };
    }

    function release(key: string): void {
        const s = states.get(key);
        if (!s || limit == null) return;
        const next = s.waiters.shift();
        if (next)
            next(); // hand the held slot directly to the FIFO-next waiter
        else if (s.inFlight > 0) s.inFlight--;
    }

    return { acquire, release };
}

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
        const timer = setTimeout(() => {
            controller.abort();
            reject(new TimeoutError(`timed out after ${ms}ms`));
        }, ms);
        fn(controller.signal).then(
            (value) => {
                clearTimeout(timer);
                unlink?.();
                resolve(value);
            },
            (err) => {
                clearTimeout(timer);
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

export type CircuitPhase = 'closed' | 'open' | 'half-open';
interface CircuitRecord {
    failures: number; // consecutive failures
    openedAt: number; // epoch ms the breaker opened; 0 = closed
}

/**
 * A store-backed circuit breaker. After `failureThreshold` consecutive failures it OPENS:
 * calls fast-fail for `cooldownMs`, then it goes HALF-OPEN and lets a single trial through —
 * a success closes it, another failure re-opens it. State lives in the StitchStore, so a shared
 * store gives a breaker shared across workers (DESIGN.md §13).
 */
export function createCircuit(
    opts: CircuitOptions,
    store: StitchStore,
    fallbackKey: string,
): {
    phase(): Promise<CircuitPhase>;
    onSuccess(): Promise<void>;
    onFailure(): Promise<boolean>;
} {
    const halfOpenAfter = opts.halfOpenAfterMs ?? opts.cooldownMs;
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
            return now() - r.openedAt >= halfOpenAfter ? 'half-open' : 'open';
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
            if (wasOpen || failures >= opts.failureThreshold) {
                // (re)open — arm a fresh cooldown window.
                await store.set(nsKey, { failures, openedAt: now() });
                return !wasOpen; // "newly opened" only when it had been closed
            }
            await store.set(nsKey, { failures, openedAt: 0 });
            return false;
        },
    };
}

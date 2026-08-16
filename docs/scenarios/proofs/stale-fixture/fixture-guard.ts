// The assembled answer to "my fixtures cannot silently rot" — the USER CODE half of C8.
//
// Everything between the markers is what an integrator has to write and maintain. Everything
// outside them is StitchAPI. The four gaps this closes are the four C1–C5 measured:
//
//   C1(e)  the vendor drifts while the fixture holds  -> `parity()` + `stamp()`
//   C2     a config slot is inert under `manualClock` -> `assertClockHonest()`
//   C3     a fixture body no wire could produce       -> `jsonOnly()`
//   C5     a stub that skips the input contract       -> `contractStub()`
//
// The design constraint that shapes all four: NOTHING here may need a network call, except the one
// function that is explicitly about needing one. `parity()` is quarantined for that reason — it is
// the only export that must run outside the offline suite, and saying so is half its value.
import { validate } from '../../../../packages/core/src/index';
import type { SchemaLike } from '../../../../packages/core/src/infer';
import { stubStitch } from '../../../../packages/core/src/test-stub';
import type {
    Adapter,
    Stitch,
    StitchInput,
} from '../../../../packages/core/src/types';

// >>> BEGIN USER CODE

/** A fixture with the one fact the library cannot hold: when it was taken. */
export interface Dated<T> {
    body: T;
    recordedOn: string;
    /** Days after which this fixture must be re-recorded. */
    staleAfterDays: number;
}

/** Stamp a fixture with its recording date. The only place `recordedOn` can live. */
export function stamp<T>(
    body: T,
    recordedOn: string,
    staleAfterDays = 90,
): Dated<T> {
    return { body, recordedOn, staleAfterDays };
}

/** Which stamped fixtures are past their re-record date, as of `today`. */
export function expired(
    fixtures: Record<string, Dated<unknown>>,
    today: Date,
): string[] {
    const out: string[] = [];
    for (const [name, f] of Object.entries(fixtures)) {
        const age =
            (today.getTime() - new Date(f.recordedOn).getTime()) / 86_400_000;
        if (age > f.staleAfterDays)
            out.push(
                `${name} recorded ${f.recordedOn} (${Math.floor(age)}d old)`,
            );
    }
    return out;
}

/** The first non-wire value in `v`, as a `path: description`, or `null` if it is all wire shapes. */
function nonWire(v: unknown, path = '$'): string | null {
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v))
        return null;
    if (typeof v !== 'object') return `${path}: ${typeof v}`;
    const proto: unknown = Object.getPrototypeOf(v);
    if (Array.isArray(v))
        return v.reduce<string | null>(
            (acc, el, i) => acc ?? nonWire(el, `${path}[${String(i)}]`),
            null,
        );
    if (proto !== Object.prototype && proto !== null)
        return `${path}: ${(v.constructor as { name: string } | undefined)?.name ?? 'exotic'}`;
    for (const [k, el] of Object.entries(v)) {
        const hit = nonWire(el, `${path}.${k}`);
        if (hit) return hit;
    }
    return null;
}

/**
 * Wrap a transport so every response body must be a shape a JSON wire can actually deliver, and is
 * then normalised through a real round-trip. A `Date`, a `Map`, a class instance, a function or a
 * `bigint` — anywhere in the tree — is REJECTED rather than silently degraded, which is what a bare
 * `JSON.stringify` comparison would do (a prototype getter is not enumerable, so it vanishes without
 * changing the JSON text).
 */
export function jsonOnly(inner: Adapter): Adapter {
    return async (req) => {
        const res = await inner(req);
        if (res.body === undefined || res.body instanceof ReadableStream)
            return res;
        const bad = nonWire(res.body);
        if (bad)
            throw new Error(
                `fixture is not a wire shape (${bad}): ${req.method} ${req.url}`,
            );
        return {
            ...res,
            body: JSON.parse(JSON.stringify(res.body)) as unknown,
        };
    };
}

/** A `stubStitch` that runs the SAME `input` schemas the real stitch declares. */
export function contractStub<TOut>(
    input: Record<string, SchemaLike>,
    impl: TOut | ((i: StitchInput) => TOut | Promise<TOut>),
): ReturnType<typeof stubStitch<TOut>> {
    return stubStitch<TOut>(async (call: StitchInput) => {
        for (const [slot, schema] of Object.entries(input)) {
            const value = (call as Record<string, unknown>)[slot];
            const r = await validate(schema, value ?? {});
            if (!r.ok)
                throw new Error(
                    `stub input.${slot}: ${r.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
                );
        }
        return typeof impl === 'function'
            ? (impl as (i: StitchInput) => TOut | Promise<TOut>)(call)
            : impl;
    });
}

/** Config slots that ignore an injected `Clock` (measured in C2) — inert under `manualClock`. */
export const WALL_CLOCK_SLOTS = ['cache'] as const;

/**
 * Fail a test that pairs a `manualClock` with a slot the clock cannot drive. The library has no
 * such diagnostic, so this reads the config the way `policySummary` does and refuses the pairing.
 */
export function assertClockHonest(cfg: Record<string, unknown>): void {
    const bad = WALL_CLOCK_SLOTS.filter((s) => cfg[s] !== undefined);
    const total = (cfg['timeout'] as { total?: unknown } | undefined)?.total;
    if (total !== undefined) bad.push('timeout.total' as never);
    if (bad.length)
        throw new Error(
            `manualClock cannot drive: ${bad.join(', ')} — these read wall-clock (ADR 0010 §4), so an advance() proves nothing about them`,
        );
}

/** Run one input against two targets and report whether they agree. NEEDS A LIVE CALL. */
export async function parity(
    live: Stitch,
    fake: Stitch,
    input: StitchInput,
): Promise<string> {
    const [a, b] = await Promise.all([live.safe(input), fake.safe(input)]);
    if (a.ok === b.ok) return 'AGREE';
    return `DISAGREE live=${a.ok ? 'ok' : (a.error?.message ?? 'err')} fake=${b.ok ? 'ok' : (b.error?.message ?? 'err')}`;
}

// <<< END USER CODE

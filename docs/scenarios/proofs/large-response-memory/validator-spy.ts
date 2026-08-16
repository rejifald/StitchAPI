// An instrumented `output` contract. C4 asks a mechanism question — does validation run PER DELTA
// or over the AGGREGATE — and the honest way to answer it is to look at what the validator was
// handed, not to infer it from a heap number.
//
// So this is a real {@link Validator} (the `{ validate }` shape `toValidator` passes through
// untouched — `validator.ts:44-55`) that records every call: how many, and what SHAPE each argument
// was. If `output` validated the aggregate, one call would arrive carrying a 100,000-element array
// and `sawArrayOfLength` would say so. If it validates per delta, N calls arrive each carrying one
// object. The counter is the proof; the heap number is the consequence.
//
// It also does REAL per-field work — eight field checks against the declared product shape — so a
// heap measurement taken with it on is not measuring a no-op.
import type { Validator } from '../../../../packages/core/src/validator';

export interface ValidatorSpy extends Validator {
    /** How many times the engine called `validate`. */
    readonly calls: () => number;
    /** The largest array length ever handed to `validate`, or 0 if it never saw an array. */
    readonly sawArrayOfLength: () => number;
    /** How many calls carried a plain (non-array) object — i.e. one record. */
    readonly recordCalls: () => number;
    /** How many calls failed the shape check. */
    readonly rejects: () => number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A contract for one product row, wired to count. Retains NOTHING it was handed — only counters —
 * so the spy itself can never be the reason a measurement looks linear.
 */
export function countingValidator(): ValidatorSpy {
    let calls = 0;
    let maxArray = 0;
    let records = 0;
    let rejects = 0;
    const spy: ValidatorSpy = {
        validate(value: unknown) {
            calls++;
            if (Array.isArray(value))
                maxArray = Math.max(maxArray, (value as unknown[]).length);
            else if (isRecord(value)) records++;
            if (!isRecord(value)) {
                rejects++;
                return Promise.resolve({
                    ok: false as const,
                    issues: [{ path: [], message: 'expected an object' }],
                });
            }
            // Eight real field checks — the cost a schema library would charge, near enough.
            const bad =
                typeof value['id'] !== 'string' ||
                typeof value['sku'] !== 'string' ||
                typeof value['title'] !== 'string' ||
                typeof value['price_cents'] !== 'number' ||
                typeof value['currency'] !== 'string' ||
                typeof value['in_stock'] !== 'boolean' ||
                !Array.isArray(value['tags']) ||
                typeof value['updated_at'] !== 'string';
            if (bad) {
                rejects++;
                return Promise.resolve({
                    ok: false as const,
                    issues: [{ path: [], message: 'bad product row' }],
                });
            }
            return Promise.resolve({ ok: true as const, value });
        },
        calls: () => calls,
        sawArrayOfLength: () => maxArray,
        recordCalls: () => records,
        rejects: () => rejects,
    };
    return spy;
}

/**
 * A contract that COERCES: it returns a value that is not the one it was given (a `price` in
 * dollars added alongside the cents). Used to ask whether the streaming path serves the VALIDATED
 * value or the raw chunk — the buffered path serves the validated one (`engine.ts:1264`).
 */
export function coercingValidator(): Validator {
    return {
        validate(value: unknown) {
            if (!isRecord(value))
                return Promise.resolve({
                    ok: false as const,
                    issues: [{ path: [], message: 'expected an object' }],
                });
            return Promise.resolve({
                ok: true as const,
                value: { ...value, coerced_marker: true },
            });
        },
    };
}

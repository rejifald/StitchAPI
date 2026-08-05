// The best available answer for "primary with a backup, classified correctly, one call on the happy
// path" — assembled from what the library actually provides, with the gaps filled in.
//
// Everything PER PROVIDER stays declared on the stitch and costs nothing: origin, path, method,
// auth strategy, `retry` with its own `on` set, `circuit`, `timeout`, `pick`/`transform`. What the
// library does not provide, and what this file is, is the ROUTING: try in order, classify the
// failure before moving on, and name the provider that served the call.
//
// It is written over `linked` rather than plain `try`/`catch` for one measured reason (C2c): the
// scope chains each call under the previous one, so the whole failover is a single trace tree
// reading `primary → backup` instead of two unrelated root traces.
//
// The region between the markers is what C8 counts.
import { linked } from '../../../../packages/core/src/pipe';
import type {
    Stitch,
    StitchError,
    StitchInput,
} from '../../../../packages/core/src/types';

// <count:begin>
/** Availability failures — try the next provider. A 400 is not here, by design. */
export const AVAILABILITY = [408, 425, 429, 500, 502, 503, 504] as const;

/** One leg of the chain: a name for attribution, and the stitch that carries its own config. */
export interface Leg<T> {
    name: string;
    call: Stitch<T>;
}

/** What the caller gets back: the value, and who produced it. */
export interface Served<T> {
    provider: string;
    value: T;
}

/**
 * Try each leg in order. Move on only when the failure is an AVAILABILITY failure; anything else
 * (a 400, a validation error, a bad credential) stops the chain and reaches the caller unchanged.
 */
export function failover<T>(
    legs: readonly Leg<T>[],
    input: StitchInput = {},
    on: readonly number[] = AVAILABILITY,
): Promise<Served<T>> {
    return linked(async (run) => {
        let last: unknown;
        for (const leg of legs) {
            try {
                return {
                    provider: leg.name,
                    value: await run(leg.call, input),
                };
            } catch (e) {
                if (!on.includes((e as StitchError).status ?? 0)) throw e;
                last = e;
            }
        }
        throw last;
    });
}
// <count:end>

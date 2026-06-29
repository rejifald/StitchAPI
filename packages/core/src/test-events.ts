// Drain a stitch's event stream into its parts — the canonical way to assert on `.stream()`.
// Accepts the generator from `someStitch(input).stream()`, OR the `StitchResult` itself (anything
// with a `.stream()` method), so `await collectStitchEvents(getUser({ params: { id: 1 } }))` works.
// Browser-safe: no `node:*`, no test framework.
import type { DriftFinding, StitchEvent } from './types';

/** The parts of a drained event stream, ready to assert on. */
export interface CollectedEvents<T> {
    /** Every event's `type`, in order — e.g. `['start','progress','result','done']`. */
    types: string[];
    /** Every `delta` chunk (streaming surfaces), in order. */
    deltas: unknown[];
    /** Every `drift` finding, in order. */
    drifts: DriftFinding[];
    /** The terminal `result` value, if the run produced one. */
    result: T | undefined;
    /** The `error` event's message + status, if the run failed. */
    error: { message: string; status: number | undefined } | undefined;
    /** The `done` event's `ok`, if the run settled. */
    done: { ok: boolean } | undefined;
    /** Every event, untouched — for assertions the convenience fields above don't cover. */
    events: StitchEvent<T>[];
}

/** A stitch event generator, or anything that hands one back (a `StitchResult`). */
export type StitchEventSource<T> =
    | AsyncGenerator<StitchEvent<T>, void>
    | { stream(): AsyncGenerator<StitchEvent<T>, void> };

/**
 * Drain a stitch event stream into its parts: every delta chunk, every drift finding, and the
 * terminal result/error/done — plus the full event list. Replaces the hand-rolled `collect()`
 * helper that recurs across spec files.
 */
export async function collectStitchEvents<T = unknown>(
    source: StitchEventSource<T>,
): Promise<CollectedEvents<T>> {
    const gen =
        typeof (source as { stream?: unknown }).stream === 'function'
            ? (
                  source as { stream(): AsyncGenerator<StitchEvent<T>, void> }
              ).stream()
            : (source as AsyncGenerator<StitchEvent<T>, void>);

    const events: StitchEvent<T>[] = [];
    const types: string[] = [];
    const deltas: unknown[] = [];
    const drifts: DriftFinding[] = [];
    let result: T | undefined;
    let error: { message: string; status: number | undefined } | undefined;
    let done: { ok: boolean } | undefined;
    for await (const ev of gen) {
        events.push(ev);
        types.push(ev.type);
        if (ev.type === 'delta') deltas.push(ev.chunk);
        else if (ev.type === 'drift') drifts.push(ev.finding);
        else if (ev.type === 'result') result = ev.data;
        else if (ev.type === 'error')
            error = { message: ev.message, status: ev.status };
        else if (ev.type === 'done') done = { ok: ev.ok };
    }
    return { types, deltas, drifts, result, error, done, events };
}

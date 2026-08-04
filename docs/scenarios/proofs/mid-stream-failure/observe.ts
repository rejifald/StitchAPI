// The CONSUMER side of the measurement: drain a stitch's `.stream()` and record the EXACT sequence
// of `delta` chunks it observed, plus the control events around them.
//
// This is the instrument the whole scenario turns on. "Does a retry duplicate content?" is not a
// question about the engine's source — it is a question about what arrives at a downstream
// accumulator, so the accumulator is what gets built and printed. `text` is the token stream
// concatenated exactly as a UI would render it: a duplicated answer reads `ABCDEABCDE` at a glance.
import type { ManualClock } from '../../../../packages/core/src/test-clock';
import type {
    StitchEvent,
    StitchInput,
} from '../../../../packages/core/src/types';
import { contentOf, errorOf, isDone } from './fake-llm-stream';

/** What a `.stream()` consumer actually saw. */
export interface Observation {
    /** Every `delta`'s parsed SSE `data` payload, in order — the raw evidence. */
    data: unknown[];
    /**
     * The token text a UI would have rendered, concatenated across the whole run. `'ABCABC'` means
     * the consumer was handed the same content twice.
     */
    text: string;
    /** Event types in order; a `progress` is tagged with its phase (`progress:reconnect`). */
    events: string[];
    /** How many `progress` events carried `phase: 'reconnect'` — reconnect boundaries the consumer CAN see. */
    reconnects: number;
    /** `[DONE]` sentinels observed. `0` on a truncated OpenAI stream; `> 1` means the stream replayed. */
    dones: number;
    /** In-band `data: {"error": …}` frames observed. */
    errorFrames: number;
    /** The terminal `done` event's `ok`. */
    ok: boolean | undefined;
    /** The terminal `error` event's message, when one was emitted. */
    error: string | undefined;
    /** Set when the async iterator itself THREW rather than emitting a terminal event. */
    threw: string | undefined;
}

export interface ObserveOptions {
    /** Stop consuming (`break`) as soon as this returns true for a delta's `data`. */
    stopOn?: (data: unknown) => boolean;
    /** Virtual ms to advance while the stream runs. Default one hour — enough for any backoff here. */
    advance?: number;
}

/**
 * Drain `stitch.stream(input)` under an injected clock and report what the consumer saw.
 *
 * The clock is advanced CONCURRENTLY with the drain, because every wait in the streaming path
 * (reconnect backoff, throttle pacing) sleeps on the injected clock — so an hour of reconnect
 * backoff costs no real time and lands on exact virtual timestamps.
 */
export async function observe(
    stitch: { stream: (input?: StitchInput) => AsyncIterable<StitchEvent> },
    input: StitchInput,
    clock: ManualClock,
    opts: ObserveOptions = {},
): Promise<Observation> {
    const obs: Observation = {
        data: [],
        text: '',
        events: [],
        reconnects: 0,
        dones: 0,
        errorFrames: 0,
        ok: undefined,
        error: undefined,
        threw: undefined,
    };

    const drain = (async () => {
        try {
            for await (const ev of stitch.stream(input)) {
                obs.events.push(
                    ev.type === 'progress'
                        ? `progress:${String(ev.phase)}`
                        : ev.type,
                );
                if (ev.type === 'progress' && ev.phase === 'reconnect')
                    obs.reconnects++;
                if (ev.type === 'error') obs.error = ev.message;
                if (ev.type === 'done') obs.ok = ev.ok;
                if (ev.type !== 'delta') continue;

                const data = (ev.chunk as { data: unknown }).data;
                obs.data.push(data);
                if (isDone(data)) obs.dones++;
                if (errorOf(data) !== undefined) obs.errorFrames++;
                obs.text += contentOf(data) ?? '';
                if (opts.stopOn?.(data) === true) break;
            }
        } catch (e) {
            obs.threw = e instanceof Error ? e.message : String(e);
        }
    })();

    await clock.advance(opts.advance ?? 3_600_000);
    await drain;
    return obs;
}

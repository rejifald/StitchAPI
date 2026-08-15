// USER CODE — the assembled answer for the LLM case, built on StitchAPI. Two seams and one loop.
//
// The policy it implements is the one the research capture describes as what every LLM client
// actually wants, and none of it is reachable from config alone:
//
//   1. RETRY THE CONNECT, NEVER THE BODY. A 503 before the first byte is replayed; a drop after the
//      first byte is not. `Surface.execute` is the right home for this because it runs before a
//      single delta is decoded (engine.ts:1400), so it cannot re-deliver one.
//   2. `[DONE]` OR IT DID NOT FINISH. The surface's `stream` hook is the only place that sees the
//      body end, so it is the only place that can tell "ended" from "ended early".
//   3. AN IN-BAND `{ "error": … }` FRAME IS A FAILURE. Same hook, same reason — and throwing from
//      it means the bad frame is never handed to the consumer.
//   4. NEVER LOSE THE PARTIAL. `.stream()` is the only channel that has it (C7), so the consumer
//      accumulates as it goes and keeps what it has when the run fails.
//   5. `sse.reconnect` STAYS OFF. On an id-less stream there is nothing to resume from — since
//      #647 the flag is a no-op there rather than a replay (C4) — so it buys nothing here.
import type { SseEvent } from '../../../../packages/core/src/sse';
import { sseSurface } from '../../../../packages/core/src/sse';
import type { Surface } from '../../../../packages/core/src/surface';
import type {
    Adapter,
    AdapterRequest,
    AdapterResponse,
    ResolvedStitchConfig,
    StitchEvent,
    StitchInput,
} from '../../../../packages/core/src/types';
import { contentOf, errorOf, isDone } from './fake-llm-stream';

const decodeSse = sseSurface.stream as NonNullable<Surface['stream']>;

/** Statuses worth replaying at the connect phase — the engine's own default `retry.on`. */
const TRANSIENT = [429, 502, 503, 504];

/**
 * The `sse` surface with the three rules above baked in. `transport` is the HTTP client to use
 * (`fetchAdapter` in production; the fake here), because `execute` replaces `config.adapter`.
 */
export function llmSurface(transport: Adapter, connectAttempts = 4): Surface {
    return {
        ...sseSurface,
        id: 'llm-sse',
        // Rule 1 — connect only. Nothing has been decoded yet, so a replay here is free of the
        // duplication hazard by construction.
        execute: async (req: AdapterRequest): Promise<AdapterResponse> => {
            let res = await transport(req);
            for (
                let i = 1;
                i < connectAttempts && TRANSIENT.includes(res.status);
                i++
            )
                res = await transport(req);
            return res;
        },
        // Rules 2 and 3 — the body's own verdict, in the one hook that sees the body end.
        stream: async function* (
            res: AdapterResponse,
            cfg: ResolvedStitchConfig,
        ) {
            let sawDone = false;
            for await (const chunk of decodeSse(res, cfg)) {
                const data = (chunk as SseEvent).data;
                const err = errorOf(data);
                if (err !== undefined)
                    throw new Error(
                        `provider error frame: ${String(err.message)}`,
                    );
                sawDone ||= isDone(data);
                yield chunk;
            }
            if (!sawDone)
                throw new Error('stream truncated: no `[DONE]` sentinel');
        },
    };
}

/** What a completion attempt produced — including a failed one. */
export interface Completion {
    /** Every token the model produced, whether or not it finished. Never discarded. */
    text: string;
    /** True only when the `[DONE]` sentinel arrived. */
    complete: boolean;
    /** Why it stopped, when it did not complete. */
    error?: string;
    /** Deltas delivered. Equal to the tokens generated — a replay would make this larger. */
    deltas: number;
}

/**
 * Rule 4 — drain `.stream()`, keeping the partial. The `error` event is "stop and keep what you
 * have", not "throw away the answer": on every failure shape this still returns the tokens the
 * caller has already paid for.
 */
export async function completion(
    chat: { stream: (input?: StitchInput) => AsyncIterable<StitchEvent> },
    input: StitchInput,
): Promise<Completion> {
    let text = '';
    let deltas = 0;
    let complete = false;
    let error: string | undefined;
    for await (const ev of chat.stream(input)) {
        if (ev.type === 'delta') {
            const data = (ev.chunk as SseEvent).data;
            deltas++;
            complete ||= isDone(data);
            text += contentOf(data) ?? '';
        } else if (ev.type === 'error') error = ev.message;
    }
    return error === undefined
        ? { text, complete, deltas }
        : { text, complete, deltas, error };
}

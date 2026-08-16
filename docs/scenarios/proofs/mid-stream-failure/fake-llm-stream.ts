// Fake, in-memory `text/event-stream` PROVIDERS — the three shapes a mid-stream failure arrives in,
// plus the recorders that make duplication a measurement rather than an assertion.
//
//   (a) OPENAI-SHAPED — `data: {"choices":[{"delta":{"content":"A"}}]}` frames with NO `id:`,
//       terminated by `data: [DONE]`. This is the most common streaming API in the world and the
//       one `Last-Event-ID` structurally cannot help: there is no id to resume from.
//   (b) RESUMABLE FEED — every frame carries `id: t3`, and the server HONOURS a `Last-Event-ID`
//       request header by resuming after that id. The shape SSE was designed for.
//   (c) CONNECT-PHASE FAILURE — a `503` before any byte of body is written. Safe to retry: the
//       consumer has seen nothing, so a replay duplicates nothing.
//
// Every provider records each OPEN with the virtual timestamp and the `Last-Event-ID` header it
// received, so three things are numbers rather than arguments:
//
//   - `opens.length`   — how many times the client opened a connection. `> 1` on a completed stream
//                        means the model ran again: paid twice, and the consumer saw it twice.
//   - `lastEventIds`   — the exact header value replayed on each reopen. `undefined` means the
//                        client reopened from scratch.
//   - `gaps`           — virtual ms between opens: the reconnect pacing, measured.
//
// Nothing touches the network and every wait rides an injected {@link Clock}, so a 5-second
// reconnect backoff is exact virtual time.
import type {
    Adapter,
    AdapterRequest,
    AdapterResponse,
    Clock,
} from '../../../../packages/core/src/types';

const enc = new TextEncoder();

/** One recorded connection open, as the provider saw it. */
export interface RecordedOpen {
    /** Virtual time (ms) the open arrived, read off the injected clock. */
    at: number;
    /** The `Last-Event-ID` request header, or `undefined` when the client sent none. */
    lastEventId: string | undefined;
    /** Status this open was answered with. */
    status: number;
}

/** How a connection ENDS after its frames are written. */
export type CutMode =
    /** The socket errors — a transport-level drop, the classic mid-stream failure. */
    | 'error'
    /** The socket closes normally, mid-answer. Truncation that looks exactly like completion. */
    | 'close';

export interface ProviderOptions {
    clock: Clock;
    /**
     * The tokens the model "generates", one per SSE frame. Single letters keep the measured delta
     * sequence readable: a duplicated stream reads `ABCABC`.
     */
    tokens?: string[];
    /**
     * Frame ids. `'none'` is the OpenAI shape (no `id:` anywhere — nothing to resume from);
     * `'per-token'` is a resumable feed (`id: t1`, `id: t2`, … honoured on reconnect).
     */
    ids?: 'none' | 'per-token';
    /** Terminate a complete stream with `data: [DONE]` (the OpenAI completion sentinel). Default true. */
    done?: boolean;
    /**
     * End the body after `after` frames instead of completing: `'error'` errors the socket,
     * `'close'` closes it cleanly (a truncation indistinguishable from a finished answer). Applies
     * only to the opens listed in `onOpens` — default `[1]`, so a reconnect gets a healthy body.
     */
    cut?: { after: number; how: CutMode; onOpens?: number[] };
    /**
     * Emit an in-band `data: {"error": {...}}` frame after this many token frames and then close
     * cleanly — the HTTP-200 failure OpenRouter documents. The status line is already spent.
     */
    errorFrameAfter?: number;
    /**
     * Answer with `status` before writing any byte, healing to a normal 200 body from open
     * `healAfter` + 1 onward. The connect-phase failure — shape (c).
     */
    connect?: { status: number; healAfter: number };
    /** Emit `retry: N` on the first frame — the server's own reconnect pacing hint. */
    retryHint?: number;
}

/**
 * A fake streaming provider. One instance is one server; `opens` accumulates across every
 * connection the client makes, which is exactly what a duplication claim needs to measure.
 */
export class FakeStreamProvider {
    /** Every connection open, in order. */
    readonly opens: RecordedOpen[] = [];
    private readonly clock: Clock;
    private readonly tokens: string[];
    private readonly ids: 'none' | 'per-token';
    private readonly done: boolean;
    private readonly cut: ProviderOptions['cut'];
    private readonly errorFrameAfter: number | undefined;
    private readonly connect: ProviderOptions['connect'];
    private readonly retryHint: number | undefined;

    constructor(opts: ProviderOptions) {
        this.clock = opts.clock;
        this.tokens = opts.tokens ?? ['A', 'B', 'C', 'D', 'E'];
        this.ids = opts.ids ?? 'none';
        this.done = opts.done ?? true;
        this.cut = opts.cut;
        this.errorFrameAfter = opts.errorFrameAfter;
        this.connect = opts.connect;
        this.retryHint = opts.retryHint;
    }

    /** The `Last-Event-ID` header sent on each open, in order. `undefined` = reopened from scratch. */
    get lastEventIds(): (string | undefined)[] {
        return this.opens.map((o) => o.lastEventId);
    }

    /** Virtual-clock ms between successive opens — the reconnect pacing, measured. */
    get gaps(): number[] {
        const at = this.opens.map((o) => o.at);
        return at.slice(1).map((t, i) => t - (at[i] as number));
    }

    /** The id of the nth token frame (1-based), the way `'per-token'` mints them. */
    static idOf(n: number): string {
        return `t${String(n)}`;
    }

    adapter(): Adapter {
        return (req: AdapterRequest): Promise<AdapterResponse> => {
            const lastEventId = req.headers['Last-Event-ID'];
            const openNo = this.opens.length + 1;

            if (this.connect && openNo <= this.connect.healAfter) {
                this.opens.push({
                    at: this.clock.now(),
                    lastEventId,
                    status: this.connect.status,
                });
                // A connect-phase failure: a normal buffered error payload, NOT a live body. Not one
                // byte of the answer has been written, so replaying this duplicates nothing.
                return Promise.resolve({
                    status: this.connect.status,
                    headers: {},
                    body: { error: { message: 'server overloaded' } },
                });
            }

            this.opens.push({ at: this.clock.now(), lastEventId, status: 200 });
            return Promise.resolve({
                status: 200,
                headers: { 'content-type': 'text/event-stream' },
                body: this.body(openNo, lastEventId),
            });
        };
    }

    // Build one connection's frames, honouring `Last-Event-ID` when the shape supports it.
    private body(
        openNo: number,
        lastEventId: string | undefined,
    ): ReadableStream<Uint8Array> {
        // Resume point: a `'per-token'` provider skips everything up to and including the acked id.
        // A `'none'` provider has no ids, so it can only start over — that is the whole problem.
        const from =
            this.ids === 'per-token' && lastEventId !== undefined
                ? this.tokens.findIndex(
                      (_, i) => FakeStreamProvider.idOf(i + 1) === lastEventId,
                  ) + 1
                : 0;

        const frames: string[] = [];
        const remaining = this.tokens.slice(from);
        const cutHere =
            this.cut && (this.cut.onOpens ?? [1]).includes(openNo)
                ? this.cut.after
                : undefined;

        for (const [i, token] of remaining.entries()) {
            if (cutHere !== undefined && i >= cutHere) break;
            if (
                this.errorFrameAfter !== undefined &&
                i >= this.errorFrameAfter
            ) {
                // The in-band failure: HTTP 200, headers long since flushed, so the only place the
                // error can live is a `data:` frame the consumer has to recognise.
                frames.push(
                    frame({
                        data: {
                            error: {
                                message: 'upstream provider overloaded',
                                code: 'provider_error',
                            },
                        },
                    }),
                );
                return streamOf(frames, 'close');
            }
            frames.push(
                frame({
                    data: chunkOf(token),
                    ...(this.ids === 'per-token'
                        ? { id: FakeStreamProvider.idOf(from + i + 1) }
                        : {}),
                    ...(i === 0 && this.retryHint !== undefined
                        ? { retry: this.retryHint }
                        : {}),
                }),
            );
        }

        if (cutHere !== undefined) return streamOf(frames, this.cut?.how);
        // A completed stream: the OpenAI sentinel, then a normal close.
        if (this.done) frames.push('data: [DONE]\n\n');
        return streamOf(frames, 'close');
    }
}

/** The OpenAI streaming-chunk shape, so `contentOf` reads a delta the way real client code does. */
export const chunkOf = (
    content: string,
): { object: string; choices: { delta: { content: string } }[] } => ({
    object: 'chat.completion.chunk',
    choices: [{ delta: { content } }],
});

/** Pull the token text out of one parsed `data:` payload — `undefined` for `[DONE]` or an error frame. */
export const contentOf = (data: unknown): string | undefined => {
    if (typeof data !== 'object' || data === null) return undefined;
    const choices = (data as { choices?: { delta?: { content?: string } }[] })
        .choices;
    return choices?.[0]?.delta?.content;
};

/** Read the in-band error payload off a parsed `data:` payload, if this frame is one. */
export const errorOf = (data: unknown): { message?: string } | undefined =>
    typeof data === 'object' && data !== null
        ? (data as { error?: { message?: string } }).error
        : undefined;

/** True for the `data: [DONE]` completion sentinel. */
export const isDone = (data: unknown): boolean => data === '[DONE]';

// ---- wire helpers ---------------------------------------------------------------------------

interface Frame {
    data: unknown;
    id?: string;
    retry?: number;
}

function frame(f: Frame): string {
    const lines: string[] = [];
    if (f.id !== undefined) lines.push(`id: ${f.id}`);
    if (f.retry !== undefined) lines.push(`retry: ${String(f.retry)}`);
    lines.push(`data: ${JSON.stringify(f.data)}`);
    return `${lines.join('\n')}\n\n`;
}

// A body that emits each frame as its own read, then ends: `'close'` closes the socket normally
// (indistinguishable from completion at the transport layer), `'error'` errors it (a drop).
function streamOf(
    frames: string[],
    how: CutMode = 'close',
): ReadableStream<Uint8Array> {
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(c) {
            if (i >= frames.length) {
                if (how === 'error') c.error(new Error('socket reset by peer'));
                else c.close();
                return;
            }
            c.enqueue(enc.encode(frames[i++] as string));
        },
    });
}

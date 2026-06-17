// The `stitchapi/postmessage` surface subpath (ADR 0009): a typed, validated, observable wrapper
// over browser `postMessage` RPC + events. The parent↔iframe channel is the most browser-native
// capability StitchAPI has — `Window` / iframe `contentWindow` / `MessagePort` — so it ships as a
// CORE subpath (not a peer package), reached only through `cfg.kind`, never the root entry.
//
// A `PostMessageChannel` binds the raw transport + the security policy (allowed origins) ONCE at
// construction. Its four verbs each ride an existing surface hook (ADR 0005/0008):
//   • `request` — correlated request→response: a buffered `execute` surface (id `'postmessage'`)
//     that posts `{ type, id, payload }` and resolves when the matching `{ type: reply, id }` lands.
//   • `emit` — fire-and-forget: the same buffered surface, but `execute` posts `{ type, payload }`
//     (no id) and resolves immediately; result `void`.
//   • `events` — inbound event subscription: a STREAMING surface (id `'postmessage-event'`) whose
//     `execute` hands back a `ReadableStream` of envelopes the channel feeds it; `await` collects the
//     validated payloads, `.stream()` yields live deltas.
//   • `respond` — the RECEIVING side: register an origin-gated handler that answers inbound requests
//     of a `type`. NOT a stitch (no outbound call), just an unsubscribe.
//
// SECURITY — origin is FIRST-CLASS and STRUCTURAL, not advisory (the "structural, not advisory" bar
// the shell surface and the rejected `inferBearer` set):
//   • {@link Origin} structurally forbids `'*'` (a template-literal type) — you cannot type a
//     wildcard targetOrigin; `windowChannel` also RUNTIME-throws on `'*'` (defense in depth).
//   • the demux gates EVERY inbound message on its `origin` BEFORE any dispatch or validation:
//     an origin not in `allowedOrigins` is dropped, never correlated/validated/delivered.
//   • `MessagePort` messages carry no origin (a port is already a private channel), so the gate is
//     bypassed for ports — documented, not silent.
//
// Browser-first + bundle-frugal + zero-dep: only `postMessage`/`MessageEvent`/`MessagePort`/
// `ReadableStream`/`globalThis.crypto` — no `node:*`, no `Buffer`. Reached only through this subpath;
// `import { stitch }` pulls in none of it.
import type { InputOf, OutputOf, SchemaLike } from './infer';
import { makeStitch } from './stitch';
import type { Surface } from './surface';
import type {
    AdapterRequest,
    AdapterResponse,
    Stitch,
    StitchConfig,
} from './types';

// ---------------------------------------------------------------------------
// the raw channel (transport) + the typed channel (PostMessageChannel)
// ---------------------------------------------------------------------------

/**
 * The raw channel a {@link PostMessageChannel} rides — the one seam between this surface and a
 * concrete browser primitive (a `Window`, an iframe's `contentWindow`, a `MessagePort`). Keeping it
 * this small is what lets the tests drive the whole surface over an in-memory fake pair with no DOM.
 */
export interface MessageTransport {
    /** Post one envelope to the peer (optionally transferring ownership of `transfer`'s objects). */
    post(message: unknown, transfer?: Transferable[]): void;
    /** Subscribe to inbound messages; returns an unsubscribe fn. `origin` is `''` for a MessagePort. */
    subscribe(handler: (data: unknown, origin: string) => void): () => void;
}

/**
 * A concrete, non-wildcard target origin: `https://app.example.com` or `http://localhost:3000`. The
 * template-literal union structurally **forbids `'*'`** — `'*'` is not assignable to either arm — so
 * the type itself rejects the "post to anyone" footgun that makes `postMessage('*')` a data leak.
 */
export type Origin = `https://${string}` | `http://${string}`;

// ---- the wire envelope ----------------------------------------------------
// Everything on the wire is one of these. `request` posts `{ type, id, payload }` and the responder
// replies `{ type: reply, id, payload: result }`; `emit`/events use `{ type, payload }` (no id).
interface Envelope {
    type: string;
    id?: string;
    payload?: unknown;
}

// A shape-guard for an inbound message: it must be an object carrying a string `type` (everything
// else — a bare number, a string, a `null` — is dropped by the demux). Returns the narrowed view.
function asEnvelope(data: unknown): Envelope | undefined {
    if (typeof data !== 'object' || data === null) return undefined;
    const t = (data as { type?: unknown }).type;
    if (typeof t !== 'string') return undefined;
    return data as Envelope;
}

// A pending correlated request, keyed by its minted id. `reply` is the `type` its answer must carry.
interface Pending {
    reply: string;
    resolve: (payload: unknown) => void;
    reject: (err: Error) => void;
}

// A live event subscription (from `events(...)`): every inbound envelope whose `type` matches is
// handed to `enqueue`, which extracts its `payload` onto the surface's ReadableStream — so a `delta`
// and the collected result are the payload (this surface's `payload[]` shape), not the envelope.
interface EventSub {
    type: string;
    enqueue: (envelope: Envelope) => void;
}

// A registered responder (from `respond(...)`): answers inbound requests of `type`. `input`/`output`
// are optional Standard-Schema-ish validators (validated via the engine's coercer is overkill here —
// we use the same `~standard` validate the schemas already expose); `reply` is the answer's type.
interface Responder {
    handler: (payload: unknown) => unknown;
    input?: SchemaValidate;
    output?: SchemaValidate;
    reply: string;
}

// The minimal validate surface we need off a schema: a Standard Schema's `~standard.validate`. We
// accept anything exposing it (Zod ≥3.24 / Valibot / ArkType / a hand-rolled one) and treat a
// non-conforming value as a validation failure (drop). Pure structural — no validator dependency.
type SchemaValidate =
    | { '~standard': { validate: (v: unknown) => StandardResult } }
    | ((v: unknown) => boolean);

type StandardResult =
    | { value: unknown; issues?: undefined }
    | { issues: readonly unknown[] }
    | Promise<
          | { value: unknown; issues?: undefined }
          | { issues: readonly unknown[] }
      >;

// Run a schema against a value: `true` ⇒ it validates. A Standard Schema returns `{ issues }` on
// failure; a plain predicate returns a boolean. Async Standard Schemas are awaited. Anything that
// throws counts as a failure (fail-closed). No schema ⇒ always passes.
async function passes(
    schema: SchemaValidate | undefined,
    value: unknown,
): Promise<boolean> {
    if (schema === undefined) return true;
    try {
        if (typeof schema === 'function') return schema(value);
        const out = await schema['~standard'].validate(value);
        return (out as { issues?: readonly unknown[] }).issues === undefined;
    } catch {
        return false;
    }
}

// Mint a correlation id — a real UUID where `crypto.randomUUID` exists (every modern browser /
// Worker / Node ≥ 16.7), else a good-enough random fallback so the surface still works in a bare vm.
function freshId(): string {
    const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
    return (
        c?.randomUUID?.() ??
        `pm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    );
}

// ---------------------------------------------------------------------------
// per-method options
// ---------------------------------------------------------------------------
// Each verb's options extend the shared StitchConfig keys MINUS `kind` (the surface owns it) and
// `url` (synthesised as a `postmessage:<type>` pseudo-endpoint), plus the verb's own fields. The
// resilience chain (`retry`/`throttle`/`timeout`/`circuit`/`trace`/`signal`) all apply via the
// engine, exactly as for every other surface.

/** Options for {@link PostMessageChannel.request}. */
export type RequestOptions = Partial<Omit<StitchConfig, 'kind' | 'url'>> & {
    /** The message `type` posted to the peer. */
    type: string;
    /** The `type` the correlated reply must carry. Default `` `${type}-result` ``. */
    reply?: string;
    /** Schema validating the outbound `body` payload (the call argument). */
    input?: StitchConfig['input'];
    /** Schema validating the inbound reply payload (the result). */
    output?: StitchConfig['output'];
};

/** Options for {@link PostMessageChannel.emit}. */
export type EmitOptions = Partial<Omit<StitchConfig, 'kind' | 'url'>> & {
    /** The message `type` posted to the peer. */
    type: string;
    /** Schema validating the outbound `body` payload (the call argument). */
    input?: StitchConfig['input'];
};

/** Options for {@link PostMessageChannel.events}. */
export type EventsOptions = Partial<Omit<StitchConfig, 'kind' | 'url'>> & {
    /** The inbound event `type` to subscribe to. */
    type: string;
    /** Schema validating each inbound event payload (the collected/streamed value). */
    output?: StitchConfig['output'];
};

/**
 * The typed, validated, observable channel — the entry point this surface exposes. Built by
 * {@link channel} / {@link windowChannel} / {@link portChannel}; binds the transport + the allowed
 * origins ONCE, then mints stitches (`request`/`emit`/`events`) and responders (`respond`) that all
 * share its single demux listener and per-channel registry. `close()` tears the whole thing down.
 */
export interface PostMessageChannel {
    /**
     * A correlated request→response: post `{ type, id, payload }`, await the inbound
     * `{ type: reply, id }`. A BUFFERED surface (id `'postmessage'`). `reply` defaults to
     * `` `${type}-result` ``. The call argument is inferred from `opts.input`; the result tracks
     * `opts.output` (the reply payload schema). Timeout/abort reuse the engine's `timeout`/`signal`.
     */
    request<const C extends RequestOptions>(
        opts: C,
    ): Stitch<OutputOf<C>, InputOf<C>>;
    /**
     * Fire-and-forget send (no reply awaited): post `{ type, payload }` and resolve immediately. A
     * buffered surface (id `'postmessage'`); result `void`. The call argument is inferred from
     * `opts.input`.
     */
    emit<const C extends EmitOptions>(opts: C): Stitch<void, InputOf<C>>;
    /**
     * Subscribe to inbound events of `opts.type`. A STREAMING surface (id `'postmessage-event'`):
     * `await` resolves to the collected payload array, `.stream()` yields live deltas. `opts.output`
     * validates each payload (per-`delta`, ADR 0005 Addendum).
     */
    events<const C extends EventsOptions>(
        opts: C,
    ): Stitch<OutputOf<C>[], InputOf<C>>;
    /**
     * Register a handler that ANSWERS inbound requests of `type` (the receiving side — e.g. an
     * iframe answering a `focus` request). Origin-gated, validates the inbound payload against
     * `input`, runs `handler`, validates the result against `output`, posts
     * `{ type: reply, id, payload: result }`. Returns an unsubscribe fn. NOT a stitch.
     *
     * `TIn`/`TOut` are caller-supplied handler types (the payload it receives, the result it
     * returns) — author ergonomics, each intentionally appearing once, so the no-unnecessary-type-
     * parameters lint is waived here. `input`/`output` are BARE schemas validating the single
     * inbound payload / the single result (not slotted `InputSchemas` — a responder answers one
     * value, not a request with `body`/`query`/… slots).
     */
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
    respond<TIn = unknown, TOut = unknown>(
        type: string,
        handler: (payload: TIn) => TOut | Promise<TOut>,
        opts?: {
            input?: SchemaLike;
            output?: SchemaLike;
            reply?: string;
        },
    ): () => void;
    /** Detach the listener, reject every pending request, close every event stream. */
    close(): void;
}

// ---------------------------------------------------------------------------
// the surface identities (ADR 0005 Decision 11: only the `id` round-trips)
// ---------------------------------------------------------------------------

/**
 * The buffered postMessage surface — the identity `request` and `emit` carry. Its `execute` is bound
 * per-call (it closes over the channel + this `opts`), so the exported identity is just the redaction
 * anchor: `request`/`emit` stitches expose `kind: 'postmessage'` on `__config`, round-tripping as
 * JSON. The live per-call surface is built in {@link makeChannel}.
 */
export const postMessageSurface: Surface = { id: 'postmessage' };

/**
 * The streaming postMessage surface — the identity `events` carries. Its live `execute`/`stream` are
 * bound per-call (they close over the channel); this exported identity is the redaction/inspection
 * anchor (`kind: 'postmessage-event'` on `__config`). Its `contractValue` documents the validation
 * target — the envelope's `payload`, the sse `.data` precedent — for an inspector reading the
 * surface; the per-call `events` surface extracts that payload upstream (at enqueue) so the chunk it
 * yields IS the payload, validated directly.
 */
export const postMessageEventSurface: Surface = {
    id: 'postmessage-event',
    contractValue: (envelope) => (envelope as Envelope).payload,
};

// ---------------------------------------------------------------------------
// the channel builder
// ---------------------------------------------------------------------------

/**
 * Build a {@link PostMessageChannel} over ANY {@link MessageTransport} — the core builder the other
 * two delegate to (and what the tests drive with a fake transport). Attaches the single demux
 * listener at construction; binds `allowedOrigins` as the security policy.
 *
 * @param transport The raw channel (a Window / port / a fake pair in tests).
 * @param opts.allowedOrigins Origins inbound messages may come from. An origin-bearing transport
 *   (a Window) drops anything else BEFORE dispatch/validation; a `MessagePort` (origin `''`) skips
 *   the gate (a port is already private).
 */
export function channel(
    transport: MessageTransport,
    opts: { allowedOrigins: string[] },
): PostMessageChannel {
    return makeChannel(transport, opts.allowedOrigins);
}

/**
 * Build a {@link PostMessageChannel} over a `Window` (or an iframe's `contentWindow`, or a thunk
 * resolving one lazily — the natural shape when the frame mounts after the channel). `post` calls
 * `target.postMessage(msg, targetOrigin, transfer)`; `subscribe` adds a `'message'` listener on the
 * current global. `allowedOrigins` defaults to `[targetOrigin]`.
 *
 * RUNTIME-throws if `targetOrigin === '*'` (defense in depth beyond the {@link Origin} type): a
 * wildcard target posts the message to whatever document currently occupies the frame — a classic
 * postMessage data leak. The type forbids it; this catches a `as any` cast too.
 */
export function windowChannel(opts: {
    target: Window | (() => Window);
    targetOrigin: Origin;
    allowedOrigins?: string[];
}): PostMessageChannel {
    if ((opts.targetOrigin as string) === '*')
        throw new Error(
            "postmessage: targetOrigin '*' is forbidden — name the exact origin (e.g. 'https://app.example.com'). A wildcard posts to whatever document occupies the frame.",
        );
    const resolveTarget = (): Window =>
        typeof opts.target === 'function' ? opts.target() : opts.target;
    const transport: MessageTransport = {
        post: (message, transfer) => {
            resolveTarget().postMessage(
                message,
                opts.targetOrigin,
                transfer ?? [],
            );
        },
        subscribe: (handler) => {
            // Inbound messages arrive on the GLOBAL `'message'` event (the `window` that receives
            // the peer's `postMessage`). Where there is no DOM event target — SSR, a non-DOM worker
            // pass, a test in a bare node context — degrade to a no-op subscription so constructing
            // the channel never throws; a real browser wires the listener as expected.
            const g = globalThis as unknown as {
                addEventListener?: (
                    t: string,
                    l: (e: MessageEvent) => void,
                ) => void;
                removeEventListener?: (
                    t: string,
                    l: (e: MessageEvent) => void,
                ) => void;
            };
            if (typeof g.addEventListener !== 'function')
                return () => undefined;
            const listener = (e: MessageEvent): void => {
                handler(e.data, e.origin);
            };
            g.addEventListener('message', listener);
            return () => {
                g.removeEventListener?.('message', listener);
            };
        },
    };
    return makeChannel(transport, opts.allowedOrigins ?? [opts.targetOrigin]);
}

/**
 * Build a {@link PostMessageChannel} over a `MessagePort` (a `MessageChannel` end, or a port handed
 * across a `postMessage`). `post` is `port.postMessage`; `subscribe` adds a `'message'` listener and
 * `port.start()`s delivery. A port carries NO origin — it is already a private, capability-style
 * channel — so origin gating is BYPASSED (every message has origin `''`, which the gate skips).
 */
export function portChannel(
    port: MessagePort,
    opts?: { allowedOrigins?: string[] },
): PostMessageChannel {
    const transport: MessageTransport = {
        post: (message, transfer) => {
            port.postMessage(message, transfer ?? []);
        },
        subscribe: (handler) => {
            const listener = (e: MessageEvent): void => {
                handler(e.data, ''); // a port has no origin
            };
            port.addEventListener('message', listener);
            port.start();
            return () => {
                port.removeEventListener('message', listener);
            };
        },
    };
    // A port has no origin, so allowedOrigins is moot; carry whatever was passed for symmetry.
    return makeChannel(transport, opts?.allowedOrigins ?? []);
}

// The single implementation behind all three builders. Holds the per-channel registry (pending
// requests, responders, event subs), attaches the one demux listener, and wires the four verbs.
function makeChannel(
    transport: MessageTransport,
    allowedOrigins: string[],
): PostMessageChannel {
    const pending = new Map<string, Pending>();
    const responders = new Map<string, Responder>();
    const eventSubs = new Set<EventSub>();
    // Live event-stream controllers, so `close()` can end each stream GRACEFULLY (a pending
    // `await events(...)` then resolves to the payloads collected so far, rather than hanging).
    const liveStreams = new Set<() => void>();
    let closed = false;

    // Whether this transport carries origins at all. A Window delivers a real `origin`; a port
    // delivers `''`. We gate ONLY origin-bearing messages — a port message (origin `''`) is always
    // allowed (it is already a private channel). An empty `allowedOrigins` over a Window therefore
    // drops everything, which is the correct fail-closed default for a misconfigured channel.
    const originAllowed = (origin: string): boolean =>
        origin === '' || allowedOrigins.includes(origin);

    // The ONE inbound demux: origin-gate → shape-guard → reply-correlation → responder → events →
    // drop. Attached once here; `close()` detaches it.
    const detach = transport.subscribe((data, origin) => {
        // 1. Origin gate FIRST — before any dispatch or validation (the structural security bar).
        if (!originAllowed(origin)) return;
        // 2. Shape-guard: must be `{ type: string, ... }`.
        const env = asEnvelope(data);
        if (env === undefined) return;

        // 3. Reply correlation: a pending request whose `reply` matches this envelope's `type` AND
        //    whose minted id matches. Match on id AND type so an unrelated message of the same type
        //    can't resolve a request, and a stale id can't either.
        if (env.id !== undefined) {
            const p = pending.get(env.id);
            if (p?.reply === env.type) {
                pending.delete(env.id);
                p.resolve(env.payload);
                return;
            }
        }

        // 4. Responder: answer an inbound request of this `type`. Validate the inbound payload
        //    against `input` (DROP on failure — a malformed request is ignored, not error-replied,
        //    so a hostile peer learns nothing from the response shape), run the handler, validate
        //    the result against `output` (drop on failure — never post an off-contract reply), then
        //    post `{ type: reply, id, payload: result }`.
        const responder = responders.get(env.type);
        if (responder !== undefined) {
            void answer(responder, env);
            return;
        }

        // 5. Events: fan the full envelope out to every matching subscription (contractValue pulls
        //    the payload for validation). A type may have multiple subscribers.
        let delivered = false;
        for (const sub of eventSubs) {
            if (sub.type === env.type) {
                sub.enqueue(env);
                delivered = true;
            }
        }
        if (delivered) return;

        // 6. Unmatched: drop.
    });

    // Run a responder for one inbound request envelope (step 4 above), guarding both validation
    // boundaries. Async because schema validation + the handler may be async.
    async function answer(responder: Responder, env: Envelope): Promise<void> {
        if (!(await passes(responder.input, env.payload))) return; // bad inbound → drop
        let result: unknown;
        try {
            result = await responder.handler(env.payload);
        } catch {
            return; // a throwing handler does not reply (the requester times out)
        }
        if (!(await passes(responder.output, result))) return; // off-contract → never post
        if (closed) return;
        transport.post({
            type: responder.reply,
            ...(env.id !== undefined ? { id: env.id } : {}),
            payload: result,
        });
    }

    // ---- request: a buffered execute surface --------------------------------
    function request<const C extends RequestOptions>(
        opts: C,
    ): Stitch<OutputOf<C>, InputOf<C>> {
        const { type, reply, input, output, ...rest } = opts;
        const replyType = reply ?? `${type}-result`;
        const url = `postmessage:${type}`;
        // `execute` (ADR 0008) replaces the transport at the engine's adapter call site, INSIDE the
        // resilience chain — so `retry`/`throttle`/`circuit`/`timeout`/`signal`/`trace` all wrap it.
        // It mints an id, registers a pending entry, posts the request, and resolves on the
        // correlated reply. The engine's per-attempt `timeout` (and a caller's `signal`) reach us as
        // `req.signal`: aborting it rejects the pending request and removes it, so a request with no
        // matching reply rejects via the engine's `timeout`/`signal` (no separate timer is invented).
        const surface: Surface = {
            id: 'postmessage',
            buildRequest: (_cfg, callInput, base) => ({
                ...base,
                body: callInput.body,
            }),
            execute: (req: AdapterRequest): Promise<AdapterResponse> =>
                new Promise<AdapterResponse>((resolve, reject) => {
                    if (closed) {
                        reject(new Error('postmessage: channel is closed'));
                        return;
                    }
                    const id = freshId();
                    const settle = (payload: unknown): void => {
                        resolve({
                            status: 200,
                            headers: {},
                            body: payload,
                            url,
                        });
                    };
                    const onAbort = (): void => {
                        if (pending.delete(id)) {
                            req.signal?.removeEventListener('abort', onAbort);
                            const reason = (req.signal?.reason ?? undefined) as
                                | { name?: string }
                                | undefined;
                            const err = new Error(
                                reason?.name === 'TimeoutError'
                                    ? `postmessage: request '${type}' timed out`
                                    : `postmessage: request '${type}' aborted`,
                            );
                            err.name = reason?.name ?? 'AbortError';
                            reject(err);
                        }
                    };
                    pending.set(id, {
                        reply: replyType,
                        resolve: (payload) => {
                            req.signal?.removeEventListener('abort', onAbort);
                            settle(payload);
                        },
                        reject: (e: Error) => {
                            req.signal?.removeEventListener('abort', onAbort);
                            reject(e);
                        },
                    });
                    if (req.signal) {
                        if (req.signal.aborted) {
                            onAbort();
                            return;
                        }
                        req.signal.addEventListener('abort', onAbort, {
                            once: true,
                        });
                    }
                    transport.post({ type, id, payload: req.body });
                }),
        };
        // The assembled config is handed to `makeStitch` as the loose `Partial<StitchConfig>`
        // Fragment: a generic `const C` keeps each slot's literal optionality (`C['name']` is
        // `string | undefined`), which `exactOptionalPropertyTypes` rejects against `Fragment`'s
        // `name?: string` — so widen the spread with `as Partial<StitchConfig>` (the generic
        // optionality is sound at runtime), then retype the loose result back to the declared
        // `InputOf<C>` (the sse/stream/graphql `as unknown as` idiom).
        return makeStitch<OutputOf<C>>({
            ...rest,
            ...(input !== undefined ? { input } : {}),
            ...(output !== undefined ? { output } : {}),
            kind: surface,
            url,
        } as Partial<StitchConfig>) as unknown as Stitch<
            OutputOf<C>,
            InputOf<C>
        >;
    }

    // ---- emit: a buffered execute surface, no reply -------------------------
    function emit<const C extends EmitOptions>(
        opts: C,
    ): Stitch<void, InputOf<C>> {
        const { type, input, ...rest } = opts;
        const url = `postmessage:${type}`;
        const surface: Surface = {
            id: 'postmessage',
            buildRequest: (_cfg, callInput, base) => ({
                ...base,
                body: callInput.body,
            }),
            // Fire-and-forget: post `{ type, payload }` (no id) and resolve immediately with no body.
            execute: (req: AdapterRequest): Promise<AdapterResponse> => {
                if (closed)
                    return Promise.reject(
                        new Error('postmessage: channel is closed'),
                    );
                transport.post({ type, payload: req.body });
                return Promise.resolve({
                    status: 200,
                    headers: {},
                    body: undefined,
                    url,
                });
            },
        };
        // `makeStitch`'s generic can't be `void` (lint: void only valid as a return type) — build it
        // loose and cast the result to the `void`-typed Stitch (emit's call resolves to nothing).
        return makeStitch({
            ...rest,
            ...(input !== undefined ? { input } : {}),
            kind: surface,
            url,
        } as Partial<StitchConfig>) as unknown as Stitch<void, InputOf<C>>;
    }

    // ---- events: a streaming surface ----------------------------------------
    function events<const C extends EventsOptions>(
        opts: C,
    ): Stitch<OutputOf<C>[], InputOf<C>> {
        const { type, output, ...rest } = opts;
        const url = `postmessage:${type}`;
        // `execute` returns a live `ReadableStream` of PAYLOADS the channel feeds via an event
        // subscription (the inbound envelope's `payload` is extracted at enqueue), so a `delta` and
        // the collected await result are both the payload — matching this surface's `payload[]`
        // result type. `stream` reads the payload stream and yields each; the engine validates each
        // chunk against `output` directly (it IS the value — no `contractValue` needed). A caller's
        // `signal`, a stream `cancel()`, and the channel's `close()` all end the stream + unsubscribe.
        const surface: Surface = {
            id: 'postmessage-event',
            execute: (req: AdapterRequest): Promise<AdapterResponse> => {
                if (closed)
                    return Promise.reject(
                        new Error('postmessage: channel is closed'),
                    );
                let sub: EventSub | undefined;
                let onAbort: (() => void) | undefined;
                let endStream: (() => void) | undefined;
                const body = new ReadableStream<unknown>({
                    start: (controller) => {
                        sub = {
                            type,
                            // Extract the payload at enqueue: the delta + collected result are the
                            // payload, validated directly against `output`.
                            enqueue: (envelope) => {
                                controller.enqueue(envelope.payload);
                            },
                        };
                        eventSubs.add(sub);
                        // End the stream gracefully (resolving a pending await to what was collected)
                        // and unsubscribe. Used by `close()` and on abort.
                        endStream = () => {
                            if (sub) eventSubs.delete(sub);
                            liveStreams.delete(endStream as () => void);
                            try {
                                controller.close();
                            } catch {
                                /* already closed */
                            }
                        };
                        liveStreams.add(endStream);
                        // Caller abort (and the engine's per-attempt signal) ends the stream.
                        if (req.signal) {
                            onAbort = () => endStream?.();
                            if (req.signal.aborted) onAbort();
                            else
                                req.signal.addEventListener('abort', onAbort, {
                                    once: true,
                                });
                        }
                    },
                    cancel: () => {
                        if (sub) eventSubs.delete(sub);
                        if (endStream) liveStreams.delete(endStream);
                        if (onAbort && req.signal)
                            req.signal.removeEventListener('abort', onAbort);
                    },
                });
                return Promise.resolve({
                    status: 200,
                    headers: {},
                    body,
                    url,
                });
            },
            async *stream(res: AdapterResponse) {
                const stream = res.body;
                if (!(stream instanceof ReadableStream)) return;
                const reader = (stream as ReadableStream<unknown>).getReader();
                try {
                    for (;;) {
                        const r = await reader.read();
                        if (r.done) break;
                        yield r.value;
                    }
                } finally {
                    reader.releaseLock();
                }
            },
        };
        return makeStitch<OutputOf<C>[]>({
            ...rest,
            ...(output !== undefined ? { output } : {}),
            kind: surface,
            url,
        } as Partial<StitchConfig>) as unknown as Stitch<
            OutputOf<C>[],
            InputOf<C>
        >;
    }

    // ---- respond: register an inbound handler (NOT a stitch) -----------------
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
    function respond<TIn = unknown, TOut = unknown>(
        type: string,
        handler: (payload: TIn) => TOut | Promise<TOut>,
        opts?: {
            input?: SchemaLike;
            output?: SchemaLike;
            reply?: string;
        },
    ): () => void {
        const responder: Responder = {
            handler: handler as (payload: unknown) => unknown,
            reply: opts?.reply ?? `${type}-result`,
        };
        if (opts?.input !== undefined)
            responder.input = opts.input as SchemaValidate;
        if (opts?.output !== undefined)
            responder.output = opts.output as SchemaValidate;
        responders.set(type, responder);
        return () => {
            // Only delete if it is still THIS responder (a later respond(type, …) replaced it).
            if (responders.get(type) === responder) responders.delete(type);
        };
    }

    // ---- close: tear everything down ----------------------------------------
    function close(): void {
        if (closed) return;
        closed = true;
        detach();
        for (const [id, p] of pending) {
            pending.delete(id);
            p.reject(new Error('postmessage: channel closed'));
        }
        // End every live event stream GRACEFULLY (closes the ReadableStream → a pending await
        // resolves to the payloads collected so far; `.stream()` consumers see the iterator end).
        for (const end of [...liveStreams]) end();
        responders.clear();
        eventSubs.clear();
        liveStreams.clear();
    }

    return { request, emit, events, respond, close };
}

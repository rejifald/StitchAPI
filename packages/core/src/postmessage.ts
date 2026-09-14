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
//   • a channel's origin policy is ONE envelope — `origins: { to, from? }`, where `from` defaults
//     to `[to]` — because the two halves are one decision, not two neighbouring fields.
//   • {@link Origin} structurally forbids `'*'` (a template-literal type) — you cannot type a
//     wildcard origin; `assertOrigin` also RUNTIME-rejects `'*'`, every `*` pattern the template
//     literal still admits (`https://*.example.com`), and anything that is not the browser's own
//     normalised origin (a trailing slash, a default port, an upper-cased host) — all of which the
//     gate's literal `includes` would otherwise turn into "allow nothing", silently.
//   • the demux gates EVERY inbound message on its `origin` BEFORE any dispatch or validation:
//     an origin not in `origins.from` is dropped, never correlated/validated/delivered.
//   • `MessagePort` messages carry no origin (a port is already a private channel), so the gate is
//     bypassed for ports — documented, not silent.
//
// Browser-first + bundle-frugal + zero-dep: only `postMessage`/`MessageEvent`/`MessagePort`/
// `ReadableStream`/`URL`/`globalThis.crypto` — no `node:*`, no `Buffer`. Reached only through
// this subpath; `import { stitch }` pulls in none of it.
import { compact } from './compact';
import type { InputOf, OutputOf, SchemaLike } from './infer';
import { makeStitch } from './stitch';
import type { Surface } from './surface';
import type {
    AdapterRequest,
    AdapterResult,
    NoUnknownKeys,
    NoUnknownNestedKeys,
    Stitch,
    StitchConfig,
} from './types';
import { type Validator, toValidator } from './validator';

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
// are optional {@link Validator}s — `respond` runs the caller's schema through `toValidator` (the
// same coercion the rest of the surface uses), so EVERY schema flavour the library accepts (a
// Standard Schema, a Zod `{ safeParse }` — including Zod < 3.24 that predates `~standard` — a plain
// `{ validate }` Validator from `toValidator`, or a bare predicate) validates uniformly. Storing the
// raw schema and only handling `~standard` here silently dropped the others (their branch threw →
// caught → treated as a failure → every inbound request dropped). `reply` is the answer's type.
interface Responder {
    handler: (payload: unknown) => unknown;
    input?: Validator;
    output?: Validator;
    reply: string;
}

// Run a validator against a value: `true` ⇒ it validates (drop on `false`). Async validators are
// awaited. Anything that throws counts as a failure (fail-closed). No validator ⇒ always passes.
async function passes(
    validator: Validator | undefined,
    value: unknown,
): Promise<boolean> {
    if (validator === undefined) return true;
    try {
        return (await validator.validate(value)).ok;
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
// The message `type` is POSITIONAL on every verb (CONTRACT.md P15 — the one required address goes
// first, like `stitch(url)`); each verb's options extend the shared `PostMessageVerbConfig` keys
// (see its doc for the three StitchConfig slots this surface withholds), plus the verb's own
// fields. The resilience chain (`retry`/`throttle`/`timeout`/`circuit`/`trace`/`signal`) all
// applies via the engine, exactly as for every other surface.

/**
 * The {@link StitchConfig} keys every postMessage verb inherits — the ONE declaration the three
 * verb option types share, so they cannot drift apart:
 *
 * - `kind` is omitted because the surface owns it (`postmessage` / `postmessage-event`).
 * - `url` is omitted because it is synthesised as a `postmessage:<type>` pseudo-endpoint.
 * - `adapter` is omitted because every postMessage surface carries an `execute` hook, and the
 *   engine reads `cfg.kind.execute ?? rt.adapter` — so a caller's adapter is NEVER called here.
 *   Inheriting it let `channel.request(type, { adapter: myTransport })` typecheck while the
 *   transport sat inert: CONTRACT.md P24 carve-out (b)'s closing clause — a flat shape is never a
 *   licence to let inert config typecheck — which is the same defect #795 removed from
 *   {@link portChannel} in this file (the origin list it took "for symmetry"). Reach a
 *   different transport by building the channel over a different {@link MessageTransport},
 *   which is the real seam (P21).
 *
 * Everything else stays: the resilience chain (`retry`/`throttle`/`timeout`/`circuit`/`trace`/
 * `signal`) all applies via the engine, exactly as for every other surface.
 */
type PostMessageVerbConfig = Partial<
    Omit<StitchConfig, 'kind' | 'url' | 'adapter'>
>;

/** Options for {@link PostMessageChannel.request}. */
export type RequestOptions = PostMessageVerbConfig & {
    /** The `type` the correlated reply must carry. Default `` `${type}-result` ``. */
    reply?: string;
    /** Schema validating the outbound `body` payload (the call argument). */
    input?: StitchConfig['input'];
    /** Schema validating the inbound reply payload (the result). */
    output?: StitchConfig['output'];
};

/** Options for {@link PostMessageChannel.emit}. */
export type EmitOptions = PostMessageVerbConfig & {
    /** Schema validating the outbound `body` payload (the call argument). */
    input?: StitchConfig['input'];
};

/** Options for {@link PostMessageChannel.events}. */
export type EventsOptions = PostMessageVerbConfig & {
    /** Schema validating each inbound event payload (the collected/streamed value). */
    output?: StitchConfig['output'];
};

/** Options for {@link PostMessageChannel.respond}. `input`/`output` are BARE schemas validating
 *  the single inbound payload / the single result (not slotted `InputSchemas` — a responder
 *  answers one value, not a request with `body`/`query`/… slots). */
export interface RespondOptions {
    /** Schema validating the inbound request payload (a failure DROPS the request). */
    input?: SchemaLike;
    /** Schema validating the handler result (a failure suppresses the reply). */
    output?: SchemaLike;
    /** The `type` the answer is posted under. Default `` `${type}-result` ``. */
    reply?: string;
}

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
    request<const C extends RequestOptions = RequestOptions>(
        type: string,
        opts?: C &
            NoUnknownKeys<C, RequestOptions, 'RequestOptions'> &
            NoUnknownNestedKeys<C>,
    ): Stitch<OutputOf<C>, InputOf<C>>;
    /**
     * Fire-and-forget send (no reply awaited): post `{ type, payload }` and resolve immediately. A
     * buffered surface (id `'postmessage'`); result `void`. The call argument is inferred from
     * `opts.input`.
     *
     * Like every stitch the call returns a LAZY result — it posts only when the result is driven
     * (`await` / `.then` / `.catch` / `.finally`). For fire-and-forget, drive it explicitly:
     * `void send(input).catch(() => {})`. A bare `send(input)` whose result is never awaited sends
     * NOTHING.
     */
    emit<const C extends EmitOptions = EmitOptions>(
        type: string,
        opts?: C &
            NoUnknownKeys<C, EmitOptions, 'EmitOptions'> &
            NoUnknownNestedKeys<C>,
    ): Stitch<void, InputOf<C>>;
    /**
     * Subscribe to inbound events of `opts.type`. A STREAMING surface (id `'postmessage-event'`):
     * `.stream()` yields live deltas; `await` collects until the stream ends (so prefer `.stream()`
     * for an ongoing subscription). `opts.output` validates each payload (per-`delta`, ADR 0005
     * Addendum) — but note a violation TERMINATES the stream with a `drift` error (the sse/stream
     * contract: a bad value is loud, not silently dropped). For a discrete event bus where one
     * malformed message should NOT end the subscription, omit `output` and validate each payload in
     * the consumer — drop the bad one, keep listening (an `onInvalid: 'drop'` mode is future work).
     */
    events<const C extends EventsOptions = EventsOptions>(
        type: string,
        opts?: C &
            NoUnknownKeys<C, EventsOptions, 'EventsOptions'> &
            NoUnknownNestedKeys<C>,
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
        opts?: RespondOptions,
    ): () => void;
    /** Detach the listener, reject every pending request, close every event stream. */
    close(): Promise<void>;
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
 * The channel's origin policy: the one origin outbound messages are addressed **to**, and the
 * origins inbound messages may come **from**. One dimension, one envelope (CONTRACT.md P24) — and
 * `from` DEFAULTS to `[to]`, which is what makes the two halves facets of a single decision rather
 * than neighbours that happen to share a word.
 *
 * P12 scalar shorthand: `origins: X` is exactly `origins: { to: X, from: [X] }` — the parent↔iframe
 * case, where the frame you post to is the only frame you accept from.
 */
export interface OriginOptions {
    /** The concrete (non-wildcard) origin outbound messages are addressed to. */
    to: Origin;
    /** Origin(s) inbound messages may come from. Default `[to]`. */
    from?: Origin | Origin[];
}

// Reject anything that is not EXACTLY the string a browser puts on `MessageEvent.origin` — scheme
// + host + non-default port, nothing more. The {@link Origin} type forbids the bare `'*'` and
// nothing else: `'https://*.example.com'` (the CORS/CSP habit), `'https://app.example.com/'`,
// `'https://App.Example.com'` and `'https://app.example.com:443'` all satisfy the template literal,
// and every one of them fails the gate's literal `includes` — dropping EVERY inbound message, with
// no warning, while reading exactly like a working allow-list. So the type is the first line and
// this is the second, the same defense-in-depth the wildcard target has always had, extended to the
// half where the trap is actually reachable. `new URL(x).origin` is the browser's own normaliser:
// if the round-trip is not the identity, the authored string is not an origin.
function assertOrigin(value: unknown, slot: string): void {
    // Taken as `unknown`, not `Origin`: every caller below is typed, but the whole point of this
    // second line of defense is the call sites the TYPE never saw (an `as any`, a JS caller, a
    // stale `.d.ts`, options parsed from JSON). A non-string here — most often a `to` the caller
    // simply did not write — must name its slot, not die on `.includes` of undefined.
    if (typeof value !== 'string')
        throw new Error(
            `postmessage: \`${slot}\` must be a bare origin string (scheme://host[:port]), got ${value === undefined ? 'undefined' : JSON.stringify(value)}.`,
        );
    if (value.includes('*'))
        throw new Error(
            `postmessage: a wildcard origin is forbidden in \`${slot}\`, got '${value}' — name each exact origin (e.g. 'https://app.example.com'). Outbound a wildcard posts to whatever document occupies the frame; inbound the gate is a literal match, so a pattern matches nothing and silently drops everything.`,
        );
    let normalized: string | undefined;
    try {
        normalized = new URL(value).origin;
    } catch {
        normalized = undefined;
    }
    if (normalized === value) return;
    const hint =
        normalized !== undefined && normalized !== 'null'
            ? ` — did you mean '${normalized}'?`
            : '';
    throw new Error(
        `postmessage: \`${slot}\` must be a bare origin (scheme://host[:port]), got '${value}'${hint}`,
    );
}

// The shared `T | T[]` list normalisation (CONTRACT.md P7): one origin reads as itself. Validation
// rides the SAME helper rather than a second pass, so there is exactly one place an authored origin
// is turned into a gate entry, and exactly one place it is checked.
const originList = (v: Origin | Origin[], slot: string): string[] => {
    const list = Array.isArray(v) ? v : [v];
    for (const origin of list) assertOrigin(origin, slot);
    return list;
};

// `origins` is REQUIRED in the type, so no TypeScript call site can omit it — but a JS caller, an
// `as any`, a stale `.d.ts`, or channel options round-tripped through JSON can, and a call site
// still spelling the pre-envelope `targetOrigin` / `allowedOrigins` produces exactly that shape.
// Without this the missing value reaches `assertOrigin` as `undefined` and the caller gets
// `TypeError: Cannot read properties of undefined` — the one construction-time failure in a file
// whose thesis is that failing LOUD at construction replaces failing silent at the first message.
// Read through `unknown` so the guard survives the type that forbids the case it exists for.
function requireOrigins(value: unknown, hint: string): void {
    if (value === undefined || value === null)
        throw new Error(`postmessage: \`origins\` is required — ${hint}`);
}

/** Options for {@link channel}. */
export interface ChannelOptions {
    /**
     * Origin(s) inbound messages may come from — the same dimension {@link WindowChannelOptions}
     * spells `origins`, under the same name (CONTRACT.md P16). A raw {@link MessageTransport}
     * already knows where its `post` goes, so there is no outbound `to` half to name here and the
     * list IS the whole policy.
     *
     * An origin-bearing transport (a Window) drops anything else BEFORE dispatch/validation; a
     * `MessagePort` (origin `''`) skips the gate (a port is already private). `[]` allows nothing
     * — the correct fail-closed reading of a misconfigured channel.
     */
    origins: Origin | Origin[];
}

/**
 * Build a {@link PostMessageChannel} over ANY {@link MessageTransport} — the core builder the other
 * two delegate to (and what the tests drive with a fake transport). Attaches the single demux
 * listener at construction; binds `origins` as the security policy.
 *
 * @param transport The raw channel (a Window / port / a fake pair in tests).
 */
export function channel(
    transport: MessageTransport,
    opts: ChannelOptions,
): PostMessageChannel {
    requireOrigins(
        opts.origins,
        "name the origin(s) inbound messages may come from (e.g. origins: 'https://app.example.com'), or `[]` to allow none. It is the former `allowedOrigins`, renamed.",
    );
    return makeChannel(transport, originList(opts.origins, 'origins'));
}

/**
 * Build a {@link PostMessageChannel} over a `Window` (or an iframe's `contentWindow`, or a thunk
 * resolving one lazily — the natural shape when the frame mounts after the channel). `post` calls
 * `target.postMessage(msg, origins.to, transfer)`; `subscribe` adds a `'message'` listener on the
 * current global. `origins.from` defaults to `[origins.to]`, and the scalar shorthand
 * `origins: 'https://app.example.com'` names both halves at once.
 *
 * RUNTIME-throws on a wildcard or non-bare origin in either half (defense in depth beyond the
 * {@link Origin} type): a wildcard target posts the message to whatever document currently occupies
 * the frame — a classic postMessage data leak — and a wildcard on the inbound half matches nothing,
 * which fails silent instead of loud. The type forbids `'*'`; this catches an `as any` cast, and
 * the patterns the type cannot express.
 */
export interface WindowChannelOptions {
    /** The window to post to — or a thunk resolving it lazily (a frame that mounts late). */
    target: Window | (() => Window);
    /**
     * The channel's origin policy — where messages go and whom they may come from. A bare
     * {@link Origin} is the P12 shorthand for `{ to: X, from: [X] }`; the {@link OriginOptions}
     * form is for the asymmetric case (posting to one frame while accepting from several).
     *
     * An inbound origin outside `from` is dropped BEFORE dispatch or validation. A sandboxed frame
     * posts with the literal origin `'null'`, which is not an {@link Origin} and cannot be
     * allow-listed here — deliberately, since EVERY sandboxed frame from anywhere shares it. Hand
     * such a frame a `MessagePort` and use {@link portChannel} instead: a port is gated by who you
     * hand it to, which is the only gate that means anything when the origin is not unique.
     */
    origins: Origin | OriginOptions;
}

export function windowChannel(opts: WindowChannelOptions): PostMessageChannel {
    requireOrigins(
        opts.origins,
        "name the origin you post to (e.g. origins: 'https://app.example.com'), or the `{ to, from }` envelope when inbound is wider than outbound. It is the former `targetOrigin` / `allowedOrigins`, now one envelope.",
    );
    // The P12 shorthand normalises through the ONE envelope — `origins: X` IS `{ to: X, from: [X] }`
    // — so the wildcard/bare-origin guard below sees the same shape either way. The SLOT it reports
    // does not follow the normalisation, though: a shorthand caller wrote `origins`, never
    // `origins.to`, and an error naming a property path that is absent from their source sends them
    // looking for a key they would have to add to fix a value they already have.
    const shorthand = typeof opts.origins === 'string';
    const policy: OriginOptions = shorthand
        ? { to: opts.origins as Origin }
        : (opts.origins as OriginOptions);
    assertOrigin(policy.to, shorthand ? 'origins' : 'origins.to');
    const resolveTarget = (): Window =>
        typeof opts.target === 'function' ? opts.target() : opts.target;
    const transport: MessageTransport = {
        post: (message, transfer) => {
            resolveTarget().postMessage(message, policy.to, transfer ?? []);
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
    return makeChannel(
        transport,
        policy.from !== undefined
            ? originList(policy.from, 'origins.from')
            : [policy.to],
    );
}

/**
 * Build a {@link PostMessageChannel} over a `MessagePort` (a `MessageChannel` end, or a port handed
 * across a `postMessage`). `post` is `port.postMessage`; `subscribe` adds a `'message'` listener and
 * `port.start()`s delivery. A port carries NO origin — it is already a private, capability-style
 * channel — so origin gating is BYPASSED (every message has origin `''`, which the gate skips).
 *
 * It therefore takes NO `origins`, where {@link channel} and {@link windowChannel} both do.
 * It used to accept one "for symmetry" and thread it through, which was worse than asymmetry: the
 * gate short-circuits on `origin === ''` before consulting the list, so the option could never
 * change a single decision, while reading exactly like the security control it was not
 * (CONTRACT.md P24 carve-out (b) — a flat shape is never a licence to let inert config typecheck).
 * A port is gated by who you hand it to, not by an origin list — which also makes this the right
 * builder for a SANDBOXED frame, whose origin is the unallow-listable literal `'null'`.
 */
export function portChannel(port: MessagePort): PostMessageChannel {
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
    // No origin list: every message off a port arrives with origin `''`, which the gate lets
    // through by construction. An empty list is the honest argument, not a discarded one.
    return makeChannel(transport, []);
}

// The single implementation behind all three builders. Holds the per-channel registry (pending
// requests, responders, event subs), attaches the one demux listener, and wires the four verbs.
function makeChannel(
    transport: MessageTransport,
    allowedOrigins: string[],
): PostMessageChannel {
    // In-flight `request` correlations, keyed by minted id. An entry is removed when the reply
    // arrives, or when the engine's per-attempt `timeout` / caller `signal` aborts the request
    // (see `onAbort` in `request` below). There is DELIBERATELY no built-in default timeout — a
    // default could break a legitimately long-running responder — so a request whose reply NEVER
    // comes (a peer that silently drops it) leaks one `pending` entry until the channel closes.
    // A postMessage stitch should therefore set `timeout` (or pass a `signal`) to bound this map;
    // without one, the entry is only reclaimed by `close()`.
    const pending = new Map<string, Pending>();
    const responders = new Map<string, Responder>();
    const eventSubs = new Set<EventSub>();
    // Live event-stream controllers, so `close()` can end each stream GRACEFULLY (a pending
    // `await events(...)` then resolves to the payloads collected so far, rather than hanging).
    const liveStreams = new Set<() => void>();
    let closed = false;

    // Whether this transport carries origins at all. A Window delivers a real `origin`; a port
    // delivers `''`. We gate ONLY origin-bearing messages — a port message (origin `''`) is always
    // allowed (it is already a private channel). An empty `origins` over a Window therefore drops
    // everything, which is the correct fail-closed default for a misconfigured channel.
    //
    // Note what this short-circuit is NOT: it is not a reason the list's element type can be
    // narrowed. `''` never needs to be a member because it never reaches the `includes`, but the
    // list itself is still `string[]` at runtime — {@link Origin} is an authoring-side constraint
    // that makes a dynamic origin (`location.origin`, a config read) assert itself at the boundary.
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
        transport.post(
            compact({
                type: responder.reply,
                id: env.id,
                payload: result,
            }),
        );
    }

    // ---- request: a buffered execute surface --------------------------------
    function request<const C extends RequestOptions = RequestOptions>(
        type: string,
        opts?: C,
    ): Stitch<OutputOf<C>, InputOf<C>> {
        const { reply, input, output, ...rest } = (opts ??
            {}) as RequestOptions;
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
            execute: (req: AdapterRequest): Promise<AdapterResult> =>
                new Promise<AdapterResult>((resolve, reject) => {
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
                                { name?: string } | undefined;
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
        // `compact` drops the `undefined`-valued slots and yields an optional-keyed shape
        // (`name?: string`), so the generic `const C`'s `string | undefined` optionality —
        // which `exactOptionalPropertyTypes` would otherwise reject against `Fragment`'s
        // `name?: string` — no longer needs a widening `as Partial<StitchConfig>` cast. The
        // loose result is still retyped to the declared `InputOf<C>` (the sse/stream/graphql
        // `as unknown as` idiom).
        return makeStitch<OutputOf<C>>(
            compact({
                ...rest,
                input,
                output,
                kind: surface,
                url,
            }),
        ) as unknown as Stitch<OutputOf<C>, InputOf<C>>;
    }

    // ---- emit: a buffered execute surface, no reply -------------------------
    function emit<const C extends EmitOptions = EmitOptions>(
        type: string,
        opts?: C,
    ): Stitch<void, InputOf<C>> {
        const { input, ...rest } = (opts ?? {}) as EmitOptions;
        const url = `postmessage:${type}`;
        const surface: Surface = {
            id: 'postmessage',
            buildRequest: (_cfg, callInput, base) => ({
                ...base,
                body: callInput.body,
            }),
            // Fire-and-forget: post `{ type, payload }` (no id) and resolve immediately with no body.
            execute: (req: AdapterRequest): Promise<AdapterResult> => {
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
        return makeStitch(
            compact({
                ...rest,
                input,
                kind: surface,
                url,
            }) as Partial<StitchConfig>,
        ) as unknown as Stitch<void, InputOf<C>>;
    }

    // ---- events: a streaming surface ----------------------------------------
    function events<const C extends EventsOptions = EventsOptions>(
        type: string,
        opts?: C,
    ): Stitch<OutputOf<C>[], InputOf<C>> {
        const { output, ...rest } = (opts ?? {}) as EventsOptions;
        const url = `postmessage:${type}`;
        // `execute` returns a live `ReadableStream` of PAYLOADS the channel feeds via an event
        // subscription (the inbound envelope's `payload` is extracted at enqueue), so a `delta` and
        // the collected await result are both the payload — matching this surface's `payload[]`
        // result type. `stream` reads the payload stream and yields each; the engine validates each
        // chunk against `output` directly (it IS the value — no `contractValue` needed). A caller's
        // `signal`, a stream `cancel()`, and the channel's `close()` all end the stream + unsubscribe.
        const surface: Surface = {
            id: 'postmessage-event',
            execute: (req: AdapterRequest): Promise<AdapterResult> => {
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
            async *stream(res: AdapterResult) {
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
        return makeStitch<OutputOf<C>[]>(
            compact({
                ...rest,
                output,
                kind: surface,
                url,
            }),
        ) as unknown as Stitch<OutputOf<C>[], InputOf<C>>;
    }

    // ---- respond: register an inbound handler (NOT a stitch) -----------------
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
    function respond<TIn = unknown, TOut = unknown>(
        type: string,
        handler: (payload: TIn) => TOut | Promise<TOut>,
        opts?: RespondOptions,
    ): () => void {
        const responder: Responder = {
            handler: handler as (payload: unknown) => unknown,
            reply: opts?.reply ?? `${type}-result`,
        };
        // Coerce each schema to a Validator up front (the same path `stitch`'s `input`/`output`
        // take), so `passes` validates every flavour — Standard Schema, Zod, a `toValidator`
        // Validator, or a predicate — uniformly instead of only `~standard`.
        const input = toValidator(opts?.input);
        if (input !== undefined) responder.input = input;
        const output = toValidator(opts?.output);
        if (output !== undefined) responder.output = output;
        responders.set(type, responder);
        return () => {
            // Only delete if it is still THIS responder (a later respond(type, …) replaced it).
            if (responders.get(type) === responder) responders.delete(type);
        };
    }

    // ---- close: tear everything down ----------------------------------------
    // Promise-returning for interface symmetry with the other teardown verbs (`seam.close`);
    // the teardown itself is synchronous.
    function close(): Promise<void> {
        if (closed) return Promise.resolve();
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
        return Promise.resolve();
    }

    // The three guarded members are `as`-cast to their declared types — the `download.ts` binder
    // idiom. A generic impl whose parameter carries `NoUnknownKeys<C, …>` cannot be checked against
    // a member of that same shape: TypeScript instantiates the impl's `C` with the target's whole
    // intersection, so the two `InputOf<C>` return types stop matching. `respond`/`close` stay
    // unguarded and fully checked.
    return {
        request: request as PostMessageChannel['request'],
        emit: emit as PostMessageChannel['emit'],
        events: events as PostMessageChannel['events'],
        respond,
        close,
    };
}

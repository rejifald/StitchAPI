// The `stitchapi/postmessage` surface subpath (ADR 0009): a typed, validated, observable wrapper
// over browser `postMessage` RPC + events. The parent↔iframe channel is the most browser-native
// capability StitchAPI has — `Window` / iframe `contentWindow` / `MessagePort` — so it ships as a
// CORE subpath (not a peer package), reached only through `cfg.kind`, never the root entry.
//
// A `PostMessageChannel` binds the raw transport + the security policy (allowed origins) ONCE at
// construction — literally once: the origin list is COPIED there, so mutating the array you passed
// cannot retarget a live channel's gate (and cannot smuggle in an entry `assertOrigin` never saw).
// It is built through ONE namespace — `channel.window(opts)` for a Window/iframe,
// `channel.port(port)` for a MessagePort, `channel.over(transport, opts)` for any ORIGIN-BEARING
// transport, `channel.private(transport)` for one with no origin dimension (an IPC/worker bridge)
// — the `otlp`/`secrets` shape: one name per dimension, the role named at the call site. Whether a
// channel is origin-gated is therefore a property of WHICH BUILDER you called, decided in code at
// construction, never something the wire can assert. Its four verbs each ride an existing surface
// hook (ADR 0005/0008):
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
//   • a WINDOW channel's origin policy is ONE envelope — `origins: { to, from? }`, where `from`
//     defaults to `[to]` — because the two halves are one decision, not two neighbouring fields.
//     A raw-transport channel has no outbound half to name (the transport already knows where its
//     `post` goes), so it takes the inbound half alone, under that half's own name: `from`.
//   • {@link Origin} structurally forbids `'*'` (a template-literal type) — you cannot type a
//     wildcard origin; `assertOrigin` also RUNTIME-rejects `'*'`, every `*` pattern the template
//     literal still admits (`https://*.example.com`), and anything that is not the browser's own
//     normalised origin (a trailing slash, a default port, an upper-cased host) — all of which the
//     gate's literal `includes` would otherwise turn into "allow nothing", silently.
//   • the demux gates EVERY inbound message on its `origin` BEFORE any dispatch or validation:
//     an origin not in the `from` list is dropped, never correlated/validated/delivered.
//   • the "no origin dimension" exemption is OUT OF BAND and is a per-CHANNEL decision made in
//     CODE, never a value on the wire. A builder that declares no origin policy (`channel.port`,
//     `channel.private`) builds an UNGATED channel; its transport passes `origin: null`. Every
//     other builder is gated, and on a gated channel a `null` fails CLOSED. So `''` is an
//     ordinary untrusted string that no {@link Origin}-typed list can contain, and a same-realm
//     `new MessageEvent('message', …)` is dropped instead of waved through.
//     This was NOT always so: the gate used to read `origin === '' || allowed.includes(origin)`,
//     an IN-BAND sentinel — `''` is `MessageEvent.origin`'s own default, so any script sharing
//     the page's realm could `window.dispatchEvent(new MessageEvent('message', { data }))` and
//     land a forged envelope straight in reply-correlation and the responders. See ADR 0009.
//   • `channel.window` additionally drops an event whose `isTrusted` is `false`. The origin gate
//     alone cannot stop a same-realm forger, because `MessageEventInit.origin` is AUTHOR-SETTABLE
//     (`new MessageEvent('message', { origin: 'https://app.example.com' })` reports exactly
//     that) — so a third-party analytics/tag-manager script or an extension content script can
//     spell any allow-listed origin it likes. `isTrusted` is the only discriminator the page
//     cannot forge: the DOM marks it `[LegacyUnforgeable]` (an own, non-configurable property
//     that survives prototype patching) and it is `false` on every constructed event. That
//     closes impersonation of a CROSS-ORIGIN peer; a same-realm script cannot make the user
//     agent stamp a foreign origin on a trusted event.
//   • …and it requires the event's `source` to BE the channel's target, which is what closes the
//     SAME-ORIGIN case: the real `window.postMessage(forged, '*')` is delivered genuinely
//     trusted and stamped with the CALLING document's own origin, so where the peer shares the
//     page's origin — `origins: location.origin` — both checks above pass. `source` is the one
//     thing the forger cannot choose, and the channel already knows the window it talks to.
//     A window channel therefore accepts only from its own peer, in both directions.
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
    /**
     * Subscribe to inbound messages; returns an unsubscribe fn.
     *
     * Deliver only the PEER's messages. A transport listening on a shared bus — a `Window`'s
     * global `'message'` event, which every frame on the page posts into — must check that the
     * event's `source` IS the window it posts to, as `channel.window` does. The channel's origin
     * gate runs after this and cannot do that job: two same-origin frames carry the same origin.
     *
     * `origin` is `null` when THIS TRANSPORT DOES NOT ATTRIBUTE ORIGINS — a `MessagePort`, an
     * Electron IPC bridge, a worker bridge, a test fake. That is a claim only CODE can make: it
     * is produced by the transport, never carried in the data channel, so nothing a peer can put
     * on the wire can spell it (`MessageEvent.origin` is a `USVString` — `{ origin: null }`
     * coerces to the *string* `'null'`, `{ origin: undefined }` to `''`; no realm ever delivers a
     * JS `null`). It is honoured only by a builder that declares NO origin policy
     * (`channel.port`, `channel.private`); on a channel that has an allow-list, a `null` here
     * fails CLOSED — see the gate in `makeChannel`.
     *
     * EVERY string is an ordinary, untrusted origin that must be in the allow-list to pass — `''`
     * emphatically included. `''` is `MessageEvent.origin`'s own default, so it is what an
     * accidentally-constructed or synthesised event carries; it must therefore never be a trust
     * signal. It used to be exactly that here, and that was a bypass (ADR 0009, "the in-band
     * sentinel").
     */
    subscribe(
        handler: (data: unknown, origin: string | null) => void,
    ): () => void;
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
 *   `channel.port` in this file (the origin list it took "for symmetry"). Reach a
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
 * `channel.over` / `channel.window` / `channel.port`; binds the transport + the allowed
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
    /**
     * Origin(s) inbound messages may come from. Default `[to]`. Same name, same value-space as
     * {@link ChannelOptions.from} — the inbound half reads identically on both builders (P1/P16).
     */
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
    // COPY, never the caller's own array. A channel binds its policy ONCE at construction (this
    // file's first paragraph says so, and `PostMessageChannel` repeats it), and returning `v`
    // made that false for the array form: the gate closed over the caller's live array, so a
    // later `allowed.push('https://evil.example.com')` retargeted a running channel — and did it
    // past `assertOrigin`, which only ever sees the elements present HERE, so an entry added
    // afterwards is honoured by the gate even when the same string would have thrown at
    // construction. `allowed.length = 0` turned a working channel silently fail-closed the same
    // way. Not wire-reachable — it takes the app mutating its own config array, the realistic
    // shape being one `origins` array read from config and shared between channels — which is
    // exactly why it must be the construction that is airtight rather than the caller's
    // discipline.
    return [...list];
};

// The origin policy is REQUIRED in the type, so no TypeScript call site can omit it — but a JS
// caller, an `as any`, a stale `.d.ts`, or channel options round-tripped through JSON can, and a
// call site still spelling the pre-envelope `targetOrigin` / `allowedOrigins` produces exactly that
// shape. Without this the missing value reaches `assertOrigin` as `undefined` and the caller gets
// `TypeError: Cannot read properties of undefined` — the one construction-time failure in a file
// whose thesis is that failing LOUD at construction replaces failing silent at the first message.
// Read through `unknown` so the guard survives the type that forbids the case it exists for.
// The SLOT is a parameter because the two builders name the policy differently: `channel.window`
// takes the two-dimensional `origins` envelope, `channel` takes the inbound half as `from`. An
// error naming a key that is absent from the caller's own source is worse than no error at all.
function requireOrigins(value: unknown, slot: string, hint: string): void {
    if (value === undefined || value === null)
        throw new Error(`postmessage: \`${slot}\` is required — ${hint}`);
}

/** Options for `channel.over`. */
export interface ChannelOptions {
    /**
     * Origin(s) inbound messages may come from — the SAME name and the SAME value-space as
     * {@link OriginOptions.from}, the inbound half of {@link WindowChannelOptions}' envelope
     * (CONTRACT.md P1/P16). A raw {@link MessageTransport} already knows where its `post` goes, so
     * there is no outbound `to` half to name here and the inbound list IS the whole policy.
     *
     * It is spelled `from` rather than `origins` because `origins` on the two builders would be one
     * token over two INCOMPARABLE value-spaces: neither union is a superset of the other, so
     * `['https://a.test', 'https://b.test']` is valid here and a compile error on `channel.window`,
     * and the scalar shorthand would mean `{ to: X, from: [X] }` on one surface and `[X]` on the
     * other — the P1/P16 collision an envelope exists to avoid, not to create. P24 carve-out (b)'s
     * endpoint-slot record declined a `url` shorthand for exactly this reason. The differing
     * NESTING LEVEL is fine and has the same precedent: that slot's members "do not share a level"
     * either, with `baseUrl` as seam vocabulary beside per-endpoint `url`/`path`.
     *
     * `channel.over` is ALWAYS gated, so this list always decides. Anything not on it is dropped
     * BEFORE dispatch/validation, and that includes a transport that hands the demux `null`
     * ("I do not attribute origins"): a per-message claim cannot widen a channel the caller
     * gated, so a careless transport breaks its own channel LOUDLY (nothing is delivered) rather
     * than silently opening it. `[]` allows nothing — the correct fail-closed reading of a
     * misconfigured channel, and a list that genuinely cannot be overridden from the wire. Nor
     * from your own code after the fact: the array is COPIED at construction, so the channel's
     * policy is whatever you passed HERE, whatever the array does later.
     *
     * For a transport that legitimately has NO origin dimension — an Electron IPC bridge, a
     * worker bridge, a test fake — reach for {@link channel.private}, which takes no origin
     * policy at all, exactly as {@link channel.port} takes none. That structural ABSENCE is the
     * point (CONTRACT.md P24 carve-out (b)): an option shaped like a security control that cannot
     * change one decision is worse than an asymmetry, which is why passing `from` and having the
     * transport quietly exempt itself is not an option this builder offers.
     */
    from: Origin | Origin[];
}

/**
 * Transport half of {@link channel}; the namespace carries the contract. Internal — this module
 * is the published entry, so only the namespace is exported.
 *
 * Build a {@link PostMessageChannel} over ANY {@link MessageTransport} — the core builder the other
 * two delegate to (and what the tests drive with a fake transport). Attaches the single demux
 * listener at construction; binds `from` as the security policy.
 *
 * A raw transport carries no outbound address for us to name, so this builder takes the INBOUND
 * half alone, under the same name {@link OriginOptions} gives it. `origins` is reserved for
 * `channel.window`, where a second dimension (`to`) actually exists.
 *
 * @param transport The raw channel (a Window / port / a fake pair in tests).
 */
function channelOver(
    transport: MessageTransport,
    opts: ChannelOptions,
): PostMessageChannel {
    requireOrigins(
        opts.from,
        'from',
        "name the origin(s) inbound messages may come from (e.g. from: 'https://app.example.com'), or `[]` to allow none. It is the former `allowedOrigins`, renamed.",
    );
    return makeChannel(transport, originList(opts.from, 'from'));
}

/**
 * Window half of {@link channel}; the namespace carries the contract. Internal — this module is
 * the published entry, so only the namespace is exported.
 *
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
    /**
     * The window this channel talks to — or a thunk resolving it lazily (a frame that mounts
     * late). The channel is BOUND to it in both directions: it posts to it, and it accepts an
     * inbound message only when that message's `source` IS it, on top of the `origins` gate. So
     * build one channel per peer window — the frame's `contentWindow` on the host side,
     * `window.parent` on the frame side — and several channels on one page never hear each
     * other's frames, even when every frame shares one origin.
     *
     * The binding survives the frame navigating or reloading: that keeps the same `WindowProxy`.
     * A REMOUNT does not — a new `<iframe>` element is a new window — so pass a thunk over the
     * element (`() => frame.contentWindow!`) when it can be replaced. A thunk is resolved on
     * every post and every inbound message; while it resolves to nothing, nothing is accepted.
     */
    target: Window | (() => Window);
    /**
     * The channel's origin policy — where messages go and whom they may come from. A bare
     * {@link Origin} is the P12 shorthand for `{ to: X, from: [X] }`; the {@link OriginOptions}
     * form is for the asymmetric case — ONE peer window that may answer from more origins than
     * you address it at (a popup that finishes a sign-in hop on another origin). It widens the
     * origins accepted from `target`, never the set of windows: see `target`.
     *
     * An inbound origin outside `from` is dropped BEFORE dispatch or validation. A sandboxed frame
     * posts with the literal origin `'null'`, which is not an {@link Origin} and cannot be
     * allow-listed here — deliberately, since EVERY sandboxed frame from anywhere shares it. Hand
     * such a frame a `MessagePort` and use `channel.port` instead: a port is gated by who you
     * hand it to, which is the only gate that means anything when the origin is not unique.
     */
    origins: Origin | OriginOptions;
}

function windowChannel(opts: WindowChannelOptions): PostMessageChannel {
    requireOrigins(
        opts.origins,
        'origins',
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
                // Drop a SYNTHESISED event before the origin gate ever sees it. The gate cannot
                // do this job: `MessageEventInit.origin` is author-settable, so any script in
                // this page's realm — third-party analytics, a tag manager, an extension content
                // script — can `dispatchEvent(new MessageEvent('message', { data, origin: X }))`
                // naming an allow-listed X, and a literal `includes` matches it. `isTrusted` is
                // the one bit the page cannot spell: `[LegacyUnforgeable]` in the DOM (own,
                // non-configurable, survives prototype patching) and `false` on every constructed
                // event, `true` only on delivery by the user agent.
                //
                // `=== false`, never `!isTrusted`: the DOM lib types this `boolean`, but this
                // surface also runs where the property is simply ABSENT — a non-DOM global, an
                // SSR pass, a hand-rolled polyfill — and an environment that omits it must not be
                // silently gated out of its own channel. Read through a widened view so that
                // `undefined` third state is in the TYPE rather than only in this comment (which
                // is also why the comparison is not redundant). The escape hatch for a harness
                // that MUST synthesise events is `channel.over` with its own transport
                // (CONTRACT.md P21) — the seam that keeps this from being a straitjacket.
                const { isTrusted } = e as { isTrusted?: boolean };
                if (isTrusted === false) return;
                // …and then: the message must come from THIS channel's PEER, not merely from an
                // allow-listed origin. `isTrusted` closes only the SYNTHESISED-event vector. A
                // same-realm script can also call the REAL `window.postMessage(forged, '*')`,
                // which the user agent delivers as a genuinely trusted event stamped with the
                // CALLING document's own origin. Cross-origin that is harmless — the attacker's
                // origin is not on the list. But when the peer is SAME-ORIGIN (`origins:
                // location.origin`, the natural shorthand for a same-origin frame) the forged
                // origin IS allow-listed, `isTrusted` is really `true`, and both checks above
                // pass an envelope straight into reply-correlation, the responders and the event
                // fan-out. The actor this matters most for is the one ADR 0009 names: an
                // extension content script, which runs in an isolated world — it cannot call the
                // page's handlers directly — but whose `postMessage` is delivered with the page's
                // own origin and `isTrusted === true`.
                //
                // `source` is the discriminator the page cannot choose: the user agent sets it to
                // the posting window. The channel already knows the window it talks to, and the
                // comparison holds in BOTH directions — parent→frame (`iframe.contentWindow`) and
                // frame→parent (`window.parent`). It also stops cross-talk between two channels
                // on one page whose peers share an origin.
                //
                // THREE states, read the way the origin gate reads its own `null`:
                //   • ABSENT (`undefined`) — the property does not exist here: a non-DOM global,
                //     an SSR pass, a hand-rolled polyfill, a harness handing the listener an
                //     object literal. There is nothing to compare against, and an environment
                //     that omits it must not be gated out of its own channel — the same reason
                //     `isTrusted` is compared `=== false` rather than negated.
                //   • `null` — a REAL event whose source browsing context is gone, or a DOM
                //     implementation that does not attribute sources at all (jsdom is one; see
                //     the CHANGELOG migration note). It cannot BE this channel's peer, so it
                //     FAILS CLOSED.
                //   • a window — it must be the peer.
                // The thunk is resolved per inbound message, because the whole point of a thunk is
                // a frame that mounts late — or is REPLACED: a remounted `<iframe>` is a new
                // browsing context with a new `WindowProxy`, which a thunk over the element follows
                // and a `Window` passed directly does not. Navigation and reload are NOT that case:
                // they keep the same `WindowProxy`, so either form stays bound across them, and it
                // is the origin gate, not this check, that drops a frame navigated somewhere
                // foreign. A thunk that throws or hands back nothing (`ref.current?.contentWindow`
                // is `undefined` before mount; a detached iframe's `contentWindow` is `null`) has
                // no peer, so the message is dropped — never turned into an exception thrown from a
                // global listener that sees every message on the page. "Nothing" is checked on its
                // own because `source !== peer` alone lets a `null` source EQUAL a `null` peer and
                // deliver, which is the `null` state above failing open.
                const { source } = e as { source?: unknown };
                if (source !== undefined) {
                    let peer: unknown;
                    try {
                        peer = resolveTarget();
                    } catch {
                        return;
                    }
                    if (peer === null || peer === undefined || source !== peer)
                        return;
                }
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
 * Port half of {@link channel}; the namespace carries the contract. Internal — this module is the
 * published entry, so only the namespace is exported.
 *
 * Build a {@link PostMessageChannel} over a `MessagePort` (a `MessageChannel` end, or a port handed
 * across a `postMessage`). `post` is `port.postMessage`; `subscribe` adds a `'message'` listener and
 * `port.start()`s delivery. A port carries NO origin — it is already a private, capability-style
 * channel — so this builder declares NO origin policy, and the channel it returns has no origin
 * dimension to gate: its transport passes `origin: null` and `makeChannel` is handed `null` for
 * the allow-list. Both halves of that are CODE, decided here at construction; nothing a peer can
 * put on the wire spells either one.
 *
 * It therefore takes NO origin policy at all, where `channel.window` takes an `origins`
 * envelope and `channel.over` takes the inbound `from` half.
 * It used to accept one "for symmetry" and thread it through, which was worse than asymmetry: a
 * port could never change a single decision through it, while reading exactly like the security
 * control it was not
 * (CONTRACT.md P24 carve-out (b) — a flat shape is never a licence to let inert config typecheck).
 * That argument is UNCHANGED by the move off the old `''` sentinel — a port still cannot be
 * origin-gated — but its proof is now the structural absence above rather than a short-circuit
 * inside the gate.
 * A port is gated by who you hand it to, not by an origin list — which also makes this the right
 * builder for a SANDBOXED frame, whose origin is the unallow-listable literal `'null'`.
 */
function portChannel(port: MessagePort): PostMessageChannel {
    const transport: MessageTransport = {
        post: (message, transfer) => {
            port.postMessage(message, transfer ?? []);
        },
        subscribe: (handler) => {
            const listener = (e: MessageEvent): void => {
                // `null`, not `''`: the claim "this transport does not attribute origins" is made
                // by THIS LINE — code — so it cannot be forged from the data channel. `''` was
                // the old spelling and was exactly the wrong one: it is `MessageEvent.origin`'s
                // default, so the byte stream could assert it.
                handler(e.data, null);
            };
            port.addEventListener('message', listener);
            port.start();
            return () => {
                port.removeEventListener('message', listener);
            };
        },
    };
    // No origin list at all — `null`, not `[]`. A port has no origin dimension, so there is no
    // policy to hold; `[]` would mean "gated, and allow nothing", which is a different channel.
    return makeChannel(transport, null);
}

/**
 * Private half of {@link channel}; the namespace carries the contract. Internal — this module is
 * the published entry, so only the namespace is exported.
 *
 * Build a {@link PostMessageChannel} over a {@link MessageTransport} that has NO origin dimension
 * — an Electron `ipcRenderer` bridge, a Web Worker bridge, a native host bridge, a test fake.
 * Like {@link channel.port}, it takes no origin policy at all, and for the same reason: there is
 * no origin to gate, so an allow-list here could never change one decision, and an option shaped
 * like a security control that cannot change a decision is worse than an asymmetry (CONTRACT.md
 * P24 carve-out (b)). `channel.port` is this builder with the `MessagePort` wiring supplied.
 *
 * This is the DELIBERATE, NAMED way to say "no origins", and it is why {@link channel.over} does
 * not have to honour a transport that says so per-message. The trust decision is made once, here,
 * by the caller, in code — the same out-of-band rule the `null` origin follows on the transport
 * seam. Reach for it only when the transport is genuinely private (you decide who holds the other
 * end); a transport that CAN attribute origins should pass them and be gated by `channel.over`.
 *
 * The transport's `subscribe` may pass `null` (the honest value) or any string; on an ungated
 * channel neither is consulted.
 *
 * @param transport The raw channel (an IPC bridge, a worker bridge, a fake in tests).
 */
function privateChannel(transport: MessageTransport): PostMessageChannel {
    return makeChannel(transport, null);
}

/**
 * The four ways to build a {@link PostMessageChannel} — one namespace over one subject. The shape
 * is `otlp`'s and `secrets`': one name per dimension, the ROLE named at the call site, rather than
 * three names on the barrel repeating the subject noun and varying only the role word. That is
 * exactly what `channel`/`windowChannel`/`portChannel` were, the same cluster
 * `otlpSink`/`otlpHttpExporter`/`toOtlpJson` replaced.
 *
 * Pick by what you are handed — the transport IS the choice, and the four are mutually exclusive
 * peers rather than layers. The first question each answers is the SAME one, which is why they
 * are peers: does this transport attribute origins, and if so who is allowed?
 *
 * - `channel.window(opts)` is the ordinary parent↔iframe case: a `Window`, an iframe's
 *   `contentWindow`, or a thunk resolving one lazily, plus the `origins` policy envelope. GATED,
 *   and additionally drops any event whose `isTrusted` is `false` (a same-realm forgery).
 * - `channel.port(port)` is the `MessagePort` case — a private, capability-style channel, gated by
 *   who you hand the port to rather than by an origin list, and the right builder for a SANDBOXED
 *   frame whose origin is the unallow-listable literal `'null'`. UNGATED, by construction.
 * - `channel.over(transport, opts)` is the generic GATED seam: any {@link MessageTransport} that
 *   attributes origins, with the inbound `from` list deciding. This is how the tests drive the
 *   whole surface over an in-memory fake pair with no DOM, and how a host wraps an origin-bearing
 *   primitive core does not ship.
 * - `channel.private(transport)` is the generic UNGATED seam — the same transport interface, for
 *   a primitive that has no origin dimension at all: an Electron IPC bridge, a worker bridge, a
 *   native host bridge. It is `channel.port` without the `MessagePort` wiring, and it exists so
 *   that "no origins" is a NAMED, deliberate choice at construction rather than something a
 *   transport can assert per-message to a channel the caller believed was gated.
 *
 * NOT itself callable, deliberately. CONTRACT.md P12 reserves a bare call for the DOMINANT case,
 * and here the generic builder is the RARE one — its only in-repo callers are tests, while the
 * README and every doc reach for the window builder. Making the rare member bare and the common
 * one a property would invert that hierarchy, so all four are peers on a plain object, the shape
 * `otlp` and `secrets` already have.
 *
 * BUNDLE COST, stated rather than glossed: a namespace pins all members for anyone who uses any
 * one of them, because esbuild will not split an object literal to drop a dead half — the same
 * effect `scripts/bundle-size.mjs` already records for the `duration` facade.
 *
 * THE METHOD, so a future author can reproduce rather than trust: each scenario bundles from
 * `packages/core/src` with the settings `scripts/bundle-size.mjs` uses (esbuild `bundle`, `minify`,
 * `treeShaking`, `format: 'esm'`, `platform: 'neutral'`), gzip level 9, from an entry importing
 * exactly what that consumer imports (`export const x = channel.port;` and so on). All figures
 * below are ONE re-measurement on ONE tree; the earlier prose quoted two different baselines for
 * the same quantity, and the numbers only mean anything as a chain.
 *
 * Measured against the three separate exports the namespace replaced: port-only 23551 → 24281 B
 * (+730), transport-only 23939 → 24281 (+342), window-only 24122 → 24281 (+159), all three
 * 24261 → 24286 (+25). The "after" column is ONE number for any single builder, which is the
 * shape of the trade: a flat floor, no longer varying by which builder you reached for. (The
 * all-three row reads 24286 rather than 24281 for a reason that is not library cost: its ENTRY
 * names three symbols instead of one, and the entry is in the bundle too.) The port-only consumer
 * pays most and pays it for something it cannot use — it now carries the origin-validation
 * apparatus (`assertOrigin`, `new URL()`, the global `'message'` listener) that builder
 * deliberately has none of, per #795.
 *
 * The whole origin-sentinel fix then moves that floor 24281 → 24363 (+82 B gzip): `private` is
 * +25 of it (a two-line delegation to `makeChannel` — a name and an object property, not
 * machinery), and the rest is the widened gate plus `channel.window`'s two listener checks
 * (`isTrusted`, and the `source`-is-the-peer comparison). The `postmessage` subpath is not
 * budgeted by `scripts/bundle-size.mjs` (its scenarios are the root entry, `import { stitch }`,
 * and `stitchapi/auth`), so no gate moves. The trade was made knowingly: NAMES freeze at the
 * stable tag, BYTES stay recoverable afterwards — split the subpath, or add a
 * `stitchapi/postmessage/port` entry — so the reversible cost is the one to pay.
 */
export const channel = {
    over: channelOver,
    window: windowChannel,
    port: portChannel,
    private: privateChannel,
} as const;

// The single implementation behind all four builders. Holds the per-channel registry (pending
// requests, responders, event subs), attaches the one demux listener, and wires the four verbs.
function makeChannel(
    transport: MessageTransport,
    // `null` = this CHANNEL has no origin dimension (`channel.port` / `channel.private`); an array
    // = this channel is gated and the array is the whole policy (`[]` allows nothing). The two are
    // different channels, not two spellings of one.
    allowedOrigins: string[] | null,
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

    // SECURITY — the exemption is OUT OF BAND, and it is the CHANNEL's, not the message's.
    //
    // This gate used to read `origin === '' || allowedOrigins.includes(origin)`. That `''` was an
    // IN-BAND sentinel: the byte stream asserting a property of the transport that only the
    // transport can know. It was not a safe one, because `''` is `MessageEvent.origin`'s DEFAULT
    // value — `new MessageEvent('message', { data }).origin === ''` — so any script sharing the
    // page's realm could `window.dispatchEvent(...)` a forged envelope past the allow-list and
    // straight into reply-correlation, the responders and the event fan-out, with `from` never
    // consulted. See ADR 0009 ("the in-band sentinel") for the full argument; do not reinstate it.
    //
    // The replacement asks the two questions in the right order and from the right sources:
    //   1. Does this CHANNEL have an origin dimension? `allowedOrigins === null` says no, and that
    //      is decided once, at construction, by a builder that takes no origin policy at all
    //      (`channel.port`, `channel.private`). Code, not data.
    //   2. If it does, is this message's origin on the list? A `null` origin — a transport saying
    //      "I do not attribute origins" — cannot answer that, so it FAILS CLOSED. A per-message
    //      claim never widens a channel the caller gated: a careless `channel.over` transport
    //      breaks its own channel loudly (nothing is delivered) instead of silently opening it.
    //
    // `=== null`, never `== null` or `??`: if `undefined` also meant "no origin dimension", a
    // transport that simply FORGOT the second argument would re-open the exact hole being closed.
    // House precedent for a strict `null` sentinel guarded by a presence check rather than `??` is
    // CONTRACT.md §6's `SchemaFingerprint.token` ABSTAIN value.
    //
    // Note what this is NOT: it is not a reason the list's element type can be narrowed. The list
    // is still `string[]` at runtime — {@link Origin} is an authoring-side constraint that makes a
    // dynamic origin (`location.origin`, a config read) assert itself at the boundary. And `''` is
    // now simply an ordinary untrusted string: no `Origin`-typed list can contain it, so it is
    // dropped, which is the whole fix.
    const originAllowed = (origin: string | null): boolean =>
        allowedOrigins === null
            ? true
            : origin !== null && allowedOrigins.includes(origin);

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

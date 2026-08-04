// Surfaces — the pluggable request-style model (ADR 0005 Decisions 1–3, 10, 11). A surface is a
// small unit (a stable string `id` + behaviour hooks) that the engine asks "how is this call
// shaped / interpreted / streamed" instead of branching on a closed `kind` union. `http` is the
// default surface; `graphql` (and later `sse`/`stream`/`download`) are peers on the same engine.
//
// Stage 3 introduces the MODEL and carries each surface's identity through `kind` (redacted to the
// `id` string in `__config` so it round-trips as JSON — Decision 11). The behaviour hooks below
// are the contract later stages fill in (Stage 4 moves graphql's shaping/interpretation here;
// Stage 5 the streaming `stream` hook). Until then the engine keys its built-in graphql handling
// on `kind.id`.
import { acceptsStatus } from './resilience';
import type {
    Adapter,
    AdapterRequest,
    AdapterResponse,
    DriftFinding,
    ResolvedStitchConfig,
    StitchInput,
} from './types';
import { getPath } from './util';

/**
 * The result a surface's {@link Surface.interpret} produces from a buffered response. The success
 * arm carries `data` (CONTRACT.md P5).
 *
 * The middle arm is the BODY-AWARE RETRY (ADR 0022 Decision 5, issue #529): a surface that has read
 * the body can ask for another attempt — a `200` carrying `{ status: 'PENDING' }`, an in-payload
 * rate limit, a `{ ok: false, code: 'TRY_AGAIN' }` envelope. It is expressible only because
 * `interpret` now runs INSIDE the attempt loop (Decision 1); before that there was no loop left to
 * re-enter. It shares the `retry.attempts` budget, and `after` (ms) is honoured the way
 * `Retry-After` is. Exhausting the budget surfaces the outcome as an ordinary failure.
 */
export type SurfaceOutcome<T = unknown> =
    | { ok: true; data: T }
    | { ok: false; retry: true; message: string; after?: number }
    | { ok: false; message: string; status?: number };

/**
 * A pluggable request style. `TInput` is the call-argument type a typed surface narrows to;
 * `TResult` the value it yields. Both default to the http surface's (loose `StitchInput`, `unknown`)
 * and are recovered by `stitch<S>` / the per-surface helpers for surfaces that specialise them
 * (e.g. `download` → `{ blob, filename }`).
 */
export interface Surface<TInput = StitchInput, TResult = unknown> {
    /** Stable identifier — the only part that round-trips into `__config` (Decision 11). */
    readonly id: string;
    /**
     * Shape the outgoing request: receives the engine's default http-built request and returns a
     * (possibly patched) one. Omitted = the http identity. (Wired for graphql in Stage 4.)
     */
    readonly buildRequest?: (
        cfg: ResolvedStitchConfig,
        input: StitchInput,
        base: AdapterRequest,
    ) => AdapterRequest;
    /**
     * Interpret a buffered response into a result or a failure — e.g. graphql's
     * "200-with-`errors` is an error". Omitted = the engine default (the body is the value).
     */
    readonly interpret?: (
        res: AdapterResponse,
        cfg: ResolvedStitchConfig,
    ) => SurfaceOutcome<TResult>;
    /**
     * Decode a live response body into `delta` chunks. Its presence marks a surface as
     * **streaming** (ADR 0005 Decision 12). Omitted = a buffered surface. (Wired in Stage 5.)
     */
    readonly stream?: (
        res: AdapterResponse,
        cfg: ResolvedStitchConfig,
    ) => AsyncIterable<unknown>;
    /**
     * Map an emitted `delta` to the value the `output` contract validates (per-`delta`
     * validation — ADR 0005 Addendum). Omitted ⇒ the delta itself. Affects ONLY what is
     * validated, never what is emitted or collected: the `delta` event and the result array
     * still carry the full value. `sse` returns the event's `data` payload, so a contract
     * describes the payload rather than the `{ event, data, id, retry }` envelope.
     */
    readonly contractValue?: (chunk: unknown) => unknown;
    /**
     * Read the resume token off an emitted `delta` chunk (issue #71). Its presence — together with
     * {@link Surface.applyResume} — marks a streaming surface as **resumable**: the engine tracks the
     * latest token across `delta`s and, when the body drops and the stitch opted into `reconnect`,
     * replays it via {@link Surface.applyResume} on the reopened request. `sse` returns the event's
     * `id` (the SSE last-event id). Omitted ⇒ the surface cannot resume (the engine never reconnects).
     */
    readonly resumeToken?: (chunk: unknown) => string | undefined;
    /**
     * Read the server-suggested reconnect backoff (ms) off an emitted `delta` chunk (issue #71). The
     * engine tracks the latest value and uses it as the reconnect delay, falling back to the
     * stitch's `reconnect.backoff` / `retry` policy when no value was seen on the dropped
     * connection. `sse` returns the event's `retry` field. Omitted ⇒ always use the fallback backoff.
     */
    readonly resumeRetry?: (chunk: unknown) => number | undefined;
    /**
     * Inject a resume token into the NEXT request before it is reopened (issue #71) — mutates `req`
     * in place. `sse` sets the `Last-Event-ID` header. Paired with {@link Surface.resumeToken}; both
     * must be present for the engine to treat the surface as resumable.
     */
    readonly applyResume?: (req: AdapterRequest, token: string) => void;
    /**
     * Replace the transport (ADR 0008): when present, the engine calls this INSTEAD of the HTTP
     * adapter, at the same site inside the resilience chain — so `retry` / `throttle` / `circuit` /
     * per-attempt `timeout` + `signal` / `trace` / `auth` / `hooks` all wrap it unchanged. A
     * non-HTTP surface (`shell`, a custom transport) shapes its request in {@link Surface.buildRequest}
     * (e.g. packing argv into `req.body`, the `graphql` precedent), runs it here, and returns an
     * {@link AdapterResponse} that {@link Surface.interpret} maps to a value. It is the surface's own
     * transport, bound to its identity — distinct from `StitchConfig.adapter` (the user's BYO HTTP
     * client); a surface with `execute` ignores `adapter`. Omitted = an ordinary HTTP surface.
     */
    readonly execute?: Adapter;
    /** Phantom carrier so `stitch<S>` can recover a surface's call-argument type. Never read. */
    readonly __input?: (input: TInput) => void;
}

/**
 * The STATUS VERDICT alone (ADR 0022 Decision 2): the failure a response's status implies, or
 * `undefined` when the status is acceptable — a 2xx/3xx, or a status the caller declared NORMAL via
 * `verdict.accept` (issue #155, CONTRACT.md P7).
 *
 * It deliberately says nothing about the SUCCESS value, because that is not knowable from a status:
 * `http` yields the raw body, `download` a `{ blob, filename }`, `llm` the provider's parsed
 * completion. Only the failure arm is universal — every surface agrees a `500` is a `500` — so only
 * the failure arm lives here. A surface composes it in front of its own body rules and never has to
 * build, then discard, a success value it does not mean:
 *
 * ```ts
 * interpret: (res, cfg) => httpFailure(res, cfg) ?? { ok: true, data: myOwnValue(res) };
 * ```
 *
 * Exported because a surface author needs it: an `interpret` hook REPLACES the default rather than
 * layering on it, so a surface with its own body rules must compose this to keep the status verdict.
 * The built-in `graphql` and `download` hooks adopt it in ADR 0022 step 2; today they are still
 * shielded by the engine's guarantee that a non-2xx never reaches them, which step 3 removes.
 */
export const httpFailure = (
    res: AdapterResponse,
    cfg: ResolvedStitchConfig,
): Extract<SurfaceOutcome, { ok: false }> | undefined => {
    if (res.status >= 400 && !acceptsStatus(cfg.verdict?.accept)(res.status))
        return { ok: false, message: `HTTP ${res.status}`, status: res.status };
    // `verdict.flag` — a body flag that is EXPLICITLY falsy on failure. Three-state and only one
    // state is a verdict: `undefined` (absent) and `null` are SILENCE, so the status verdict above
    // stands and an `info` drift finding records that the flag was not there. Only a present, falsy
    // value fails the call. `accept` can only turn a failure into a success; `flag` only a success
    // into a failure — neither invents a verdict from absence.
    const path = cfg.verdict?.flag;
    if (path !== undefined) {
        const value = getPath(res.body, path);
        if (value !== undefined && value !== null && isFalsy(value))
            return {
                ok: false,
                message: `verdict.flag \`${path}\` is ${JSON.stringify(value)}`,
                status: res.status,
            };
    }
    return undefined;
};

// Read falsiness off an `unknown` WITHOUT letting the narrowing eat it. After `!== undefined &&
// !== null` TypeScript narrows `unknown` to `{}`, whose type-level truthiness is always true — so an
// inline `!value` is reported as dead code even though `false` / `0` / `''` / `NaN` all reach it at
// runtime. Taking the value back as `unknown` here keeps the check honest and the intent legible.
const isFalsy = (value: unknown): boolean => !value;

/**
 * The `info` drift finding for a `verdict.flag` that resolved to nothing (ADR 0022 Decision 3).
 *
 * A silently inert `flag` — a typo, or an API that quietly dropped its envelope — must not fail the
 * call, but it must not be invisible either. This is what makes that trade honest: the diagnostic
 * shows up in `.inspect()` and the drift report while the call resolves. Findings are diagnostic,
 * never control flow (ADR 0015/0016), which is exactly the property being relied on here.
 *
 * It reuses the `undeclared` change kind rather than minting one: the condition IS "the response did
 * not declare this path", and a new kind would widen `SoftDriftChange`, the per-kind severity map
 * and its documented defaults for a diagnostic that reads the same either way.
 */
export const flagFinding = (
    res: AdapterResponse,
    cfg: ResolvedStitchConfig,
): DriftFinding | undefined => {
    const path = cfg.verdict?.flag;
    if (path === undefined) return undefined;
    const value = getPath(res.body, path);
    if (value !== undefined && value !== null) return undefined;
    return {
        level: 'info',
        path,
        change: 'undeclared',
        detail:
            `verdict.flag \`${path}\` is ${value === null ? 'null' : 'absent'} — no signal, so the ` +
            `status verdict stands. Check the path, or declare the field in \`output\` if it is guaranteed.`,
    };
};

/**
 * The http surface's `interpret` (ADR 0022 Decision 2) — the status verdict, then "the body is the
 * value". That second half is the HTTP SURFACE'S OWN choice of result, not a shared assumption:
 * a surface that means something else composes {@link httpFailure} instead of this.
 */
export const httpInterpret = (
    res: AdapterResponse,
    cfg: ResolvedStitchConfig,
): SurfaceOutcome => httpFailure(res, cfg) ?? { ok: true, data: res.body };

/**
 * The default surface: a plain JSON-over-HTTP call. Selected whenever `kind` is omitted — `compose`
 * resolves the slot to this, so it is a real selection rather than an engine branch (ADR 0022
 * Decision 2).
 */
export const httpSurface: Surface = { id: 'http', interpret: httpInterpret };

/**
 * The interpretation a surface actually runs: its own hook, or the http surface's when it declares
 * none (`sse`, `stream`, `postmessage`, `shell` — surfaces whose job is transport or decoding, not
 * deciding what a response means).
 *
 * That inheritance rule lives HERE, in the surface model, rather than as a `??` in the engine. The
 * engine asking "does this surface interpret? if not, here is what I think a response means" is the
 * exact shape ADR 0022 set out to remove: it put the http default in the one place that is not a
 * surface, which is why it had no name and its config slot had no stage.
 */
export const interpretOf = (kind: Surface): NonNullable<Surface['interpret']> =>
    kind.interpret ?? httpInterpret;

/**
 * GraphQL-over-HTTP. Its behaviour lives entirely in these hooks (ADR 0005 Stage 4): `buildRequest`
 * packs the `document` as the wire body's `query` field (`{ query, variables, operationName? }`,
 * the GraphQL-over-HTTP protocol shape) as JSON and forces POST; `interpret` treats a 200 carrying
 * `errors` as a failure. The `data` pick is a plain config key the `graphql(...)` helper /
 * `seam.graphql()` set (the engine applies it after `interpret`), as is the `/graphql` default
 * path.
 *
 * `operationName` is derived the way graphql clients (e.g. graphql-request) do: the name token of
 * the first named operation. The keyword must be on a `\b` word boundary and followed by whitespace
 * and a name (`\w+`), so a field/type that merely starts with a keyword can't match; anonymous
 * documents (`{ ... }`, or `query ($id: ID) { ... }` with no name) yield no key. Set
 * `cfg.operationName` to override (a multi-operation document, or `''` to suppress).
 *
 * The body encoding is the surface's, not the caller's: the `AdapterRequest`'s flat `bodyType` is
 * FIXED at `'json'` below (the transport spelling — P22), and `NoWireBodyOnGraphql` makes authoring
 * the config-level `wire.body` a compile error so the override is never silent. A GraphQL file
 * upload is therefore out of reach today — it needs the `operations`/`map`/file-part envelope of
 * the GraphQL multipart request spec, not this JSON body multipart-encoded, so it would be a new
 * shape for `buildRequest` to learn rather than an encoding a caller can pass.
 */
// The `id` is pinned to its literal rather than widened to `Surface`'s `string`, so
// `GraphqlOnlyOnGraphqlSurface` and `WireBodyFixedByGraphql` can tell at the type level whether a
// config selected this surface. Widening it would make `document`/`operationName` unguardable, and
// `wire.body` unrejectable, on the generic `stitch({ kind })` spelling.
export const graphqlSurface: Surface & { readonly id: 'graphql' } = {
    id: 'graphql',
    buildRequest: (cfg, input, base) => {
        const document = cfg.document ?? '';
        const operationName =
            cfg.operationName ??
            /\b(?:query|mutation|subscription)\s+(\w+)/.exec(document)?.[1];
        return {
            ...base,
            method: (cfg.method ?? 'POST').toUpperCase(),
            bodyType: 'json',
            body: {
                // `query` is the GraphQL-over-HTTP wire field for the document — protocol shape,
                // not the config spelling.
                query: document,
                variables: input.variables ?? input.body ?? {},
                // Only carry the key when a name is known — anonymous documents omit it, matching
                // graphql-request and keeping the body clean. `cfg.operationName: ''` suppresses it.
                ...(operationName ? { operationName } : {}),
            },
        };
    },
    // A 500 is a failure BEFORE it is a graphql payload (ADR 0022 Decision 4). This hook used to be
    // correct only because the engine guaranteed it never saw a non-2xx; step 3 removes that
    // guarantee, and without the composed verdict an error page would be read for `errors`, found
    // to have none, and returned as a successful GraphQL response.
    interpret: (res, cfg) => {
        const failure = httpFailure(res, cfg);
        if (failure) return failure;
        const errs = (
            res.body as { errors?: { message?: string }[] } | null | undefined
        )?.errors;
        if (errs?.length)
            return {
                ok: false,
                message: `GraphQL: ${errs.map((e) => e.message ?? 'error').join('; ')}`,
                status: res.status,
            };
        return { ok: true, data: res.body };
    },
};

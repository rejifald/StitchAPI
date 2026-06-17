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
import type {
    Adapter,
    AdapterRequest,
    AdapterResponse,
    StitchConfig,
    StitchInput,
} from './types';

/** The result a surface's {@link Surface.interpret} produces from a buffered response. */
export type SurfaceOutcome<T = unknown> =
    | { ok: true; value: T }
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
        cfg: StitchConfig,
        input: StitchInput,
        base: AdapterRequest,
    ) => AdapterRequest;
    /**
     * Interpret a buffered response into a result or a failure — e.g. graphql's
     * "200-with-`errors` is an error". Omitted = the engine default (the body is the value).
     */
    readonly interpret?: (
        res: AdapterResponse,
        cfg: StitchConfig,
    ) => SurfaceOutcome<TResult>;
    /**
     * Decode a live response body into `delta` chunks. Its presence marks a surface as
     * **streaming** (ADR 0005 Decision 12). Omitted = a buffered surface. (Wired in Stage 5.)
     */
    readonly stream?: (
        res: AdapterResponse,
        cfg: StitchConfig,
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
     * stitch's `reconnect.backoffMs` / `retry` policy when no value was seen on the dropped
     * connection. `sse` returns the event's `retry` field. Omitted ⇒ always use the fallback backoff.
     */
    readonly resumeRetryMs?: (chunk: unknown) => number | undefined;
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

/** The default surface: a plain JSON-over-HTTP call. Selected whenever `kind` is omitted. */
export const httpSurface: Surface = { id: 'http' };

/**
 * GraphQL-over-HTTP. Its behaviour lives entirely in these hooks (ADR 0005 Stage 4): `buildRequest`
 * packs `{ query, variables }` as JSON and forces POST; `interpret` treats a 200 carrying `errors`
 * as a failure. The `data` unwrap is a plain config key the `graphql(...)` helper / `seam.graphql()`
 * set (the engine applies it after `interpret`), as is the `/graphql` default path.
 */
export const graphqlSurface: Surface = {
    id: 'graphql',
    buildRequest: (cfg, input, base) => ({
        ...base,
        method: (cfg.method ?? 'POST').toUpperCase(),
        bodyType: 'json',
        body: {
            query: cfg.query ?? '',
            variables: input.variables ?? input.body ?? {},
        },
    }),
    interpret: (res) => {
        const errs = (
            res.body as { errors?: { message?: string }[] } | null | undefined
        )?.errors;
        if (errs?.length)
            return {
                ok: false,
                message: `GraphQL: ${errs.map((e) => e.message ?? 'error').join('; ')}`,
                status: res.status,
            };
        return { ok: true, value: res.body };
    },
};

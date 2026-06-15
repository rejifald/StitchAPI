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

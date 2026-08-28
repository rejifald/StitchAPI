import { emitShimNotice } from './shims/notices';

import { createTrace as coreCreateTrace } from 'stitchapi';
import type { TraceSink } from 'stitchapi';

/**
 * Browser-targeted `stitch` build entry — B1 (Tier-3).
 *
 * This is the docs-side entry the R1 Worker runner injects as the snippet scope's
 * stitch API. It re-exports the BROWSER-SAFE surface of `stitchapi` and wires
 * the shims for the Node-only surfaces, per the spike's recommended shape
 * (B1-SPIKE §6 — a thin entry + bundler alias/define, NO fork of packages/core).
 *
 * `packages/core` is browser-isomorphic (GAP-AUDIT §1.5): no static `node:*` imports
 * and no bare `process`, so this entry needs no node:* or process bundler shims — only
 * the `stitchapi` alias that resolves core's source without a build (see
 * build-stitch-browser.mjs and B1-README.md). This file deals only with the API
 * SURFACE: re-export the browser-safe core exports, shim the Node-only ones.
 *
 * This re-export list must COVER core's runtime barrel: the snippet scope is the
 * spread of whatever this module exports (worker-main.ts), so a core export
 * missing here is simply not a binding, and a snippet naming it dies with
 * `X is not defined`. That is not hypothetical — the auth strategies hit it
 * (#545, see below) and ten more names were found already shipped that way
 * (`StitchError` in nine doc snippets, `xhrAdapter` in five, …). The coverage is
 * now enforced: docs/sandbox/tests/playground-surface-coverage.test.ts fails when
 * core grows an export this file has not considered.
 *
 * Surface map (SANDBOX §3 table):
 *   Browser-safe (re-exported verbatim from core):
 *     stitch, seam, drift, graphql,
 *     validate, compile,
 *     fetchAdapter, memoryStore, multiplex,
 *     StitchError, RateLimitError,
 *     isStitch, isSeam, verdictOf,
 *     httpSurface, graphqlSurface,
 *     xhrAdapter, axiosAdapter,
 *     duration, size, rate, compact, secrets,
 *     loggerSink, systemClock, + all types
 *   Browser-safe, from the `stitchapi/auth` entry (ADR 0021):
 *     bearer, apiKey, basic, oauth2
 *   Node-only, runs SHIMMED here (with a RunNotice):
 *     env                      → ./shims/node-surfaces  (demo values)
 *     cookieSession            → ./shims/node-surfaces  (in-memory jar)
 *     createTrace              → shimmed below          (JSONL is a no-op)
 *     consoleSink, fileSink    → shimmed below          (routed through createTrace)
 *     otlp (sink/exporter shimmed, json verbatim)
 *                              → ./shims/otlp-browser (no-op exporter, no egress)
 *   Server-tier only, THROWS here:
 *     cli, serve, mcp          → ./shims/server-tier-stubs
 */

/* ---- Browser-safe core surface (call API a Tier-1 snippet uses) ---------- */
export {
    stitch,
    seam,
    drift,
    graphql,
    // `validate`/`compile` are pure schema-normalisation (validator.ts);
    // no Node touch-points — safe to re-export verbatim. Needed so the blog's
    // runtime-schema snippets (`compile(JsonSchema.adapt(...))`) run in the playground.
    validate,
    compile,
    fetchAdapter,
    memoryStore,
    // `multiplex` is pure JS (B1-SPIKE §5) — safe to re-export verbatim.
    multiplex,
    // Error classes. A snippet that does `catch (e) { if (e instanceof StitchError) }`
    // — the shape the errors docs teach — needs these bound or it throws
    // `StitchError is not defined`. Pure classes, no Node.
    StitchError,
    RateLimitError,
    // Type guards and the verdict reader. Pure predicates over plain objects.
    isStitch,
    isSeam,
    verdictOf,
    // Surface descriptors. Plain objects describing a protocol, no transport.
    httpSurface,
    graphqlSurface,
    // Adapters. `xhrAdapter` is BROWSER-only by construction (XMLHttpRequest), so
    // it belongs here more than anywhere; `axiosAdapter` takes a caller-supplied
    // axios instance (core is zero-dependency and never imports axios), so it is a
    // pure wrapper — a snippet supplies the client via the module registry.
    xhrAdapter,
    axiosAdapter,
    // Token grammars and the secret registry. `duration`/`size`/`rate` are the
    // parse/format namespace pairs (#753, formerly parseDuration/parseBytes/
    // parseRate) — plain objects, no Node; `secrets` is the redaction namespace
    // (register/has/redact) the trace-privacy snippets reach for.
    duration,
    size,
    rate,
    compact,
    secrets,
    // `loggerSink` writes to a CALLER-supplied logger — unlike `consoleSink` it
    // never re-enables core's own console path, so it is safe verbatim (see the
    // shimmed pair below).
    loggerSink,
    // Injectable clock — pure, and what the testing snippets pass to `stitch`.
    systemClock,
} from 'stitchapi';

/* ---- Browser-safe auth surface (its own entry since ADR 0021) ------------ */
// The four credential strategies are pure header/query builders — no Node
// touch-points, safe to re-export verbatim. They live in `stitchapi/auth`, NOT
// the main barrel (#545); re-exporting them from 'stitchapi' made them resolve
// to nothing, so `bearer('…')` in a snippet threw `bearer is not defined`.
// (`env`/`cookieSession` come from the same entry but are shimmed — below.)
export { bearer, apiKey, basic, oauth2 } from 'stitchapi/auth';

// All public types — none carry runtime Node weight. Core's barrel re-exports
// `./types` via `export *`, so every public type is reachable from the main entry.
export type {
    SpanExporter,
    OtelSpan,
    OtelSpanEvent,
    SpanAttributes,
    OtlpOptions,
} from 'stitchapi';
export type * from 'stitchapi';

/* ---- Node-only surfaces, shimmed (emit a RunNotice) ---------------------- */
export { env, cookieSession } from './shims/node-surfaces';
// The OTLP namespace is replaced WHOLESALE (core folded the three names into one
// object, so there is no per-name override any more): `otlp.sink`/`otlp.exporter`
// are neutered to guarantee no egress, while `otlp.json` is core's real serializer
// passed through verbatim — it is pure and was browser-safe before the fold. See
// shims/otlp-browser.ts for why every member has to be listed explicitly.
export { otlp, noopOtlpExporter } from './shims/otlp-browser';

/**
 * Browser `createTrace`: core's JSONL/console sink, neutered for the browser.
 *
 * Two Node touch-points are handled here so the sink can't trip in a Worker:
 *   - JSONL `file` writes are already no-ops via the `node:fs` alias, but a path
 *     does nothing — surface a notice (the trace is delivered via StitchTraceEntry,
 *     SANDBOX §5.7).
 *   - core defaults `console` to TRUE; that branch probes `globalThis.process?.stderr`
 *     and falls back to `console.error` when absent (a Worker has no `process`, so it
 *     never crashes). To keep trace OUT of the captured `console.*` stream — it is
 *     surfaced via StitchTraceEntry instead (SANDBOX §5.7) — we FORCE `console: false`
 *     here. (R1 must-know: do not re-enable core console trace in the browser.)
 */
export function createTrace(
    opts?: Parameters<typeof coreCreateTrace>[0],
): TraceSink {
    if (opts && opts.file) {
        emitShimNotice(
            'createTrace',
            'JSONL trace files are a no-op in the browser sandbox — the trace is ' +
                'surfaced via StitchTraceEntry instead (SANDBOX §5.7).',
        );
    }
    // Force console off: core's console path would otherwise `console.error` each line
    // (no process.stderr in a Worker); trace is surfaced via StitchTraceEntry instead.
    return coreCreateTrace({ ...(opts ?? {}), console: false });
}

/**
 * `consoleSink` / `fileSink`: core's two convenience sinks, routed through the
 * browser `createTrace` above rather than re-exported verbatim.
 *
 * Neither is Node-unsafe — core is browser-isomorphic and its `node:fs` lookup is
 * guarded — but re-exporting them raw would defeat the policy `createTrace`
 * enforces two functions up:
 *   - `consoleSink()` is literally `createTrace({ console: true, file: false })`
 *     (trace.ts), i.e. it turns core's console path back ON. That is the exact
 *     thing the R1 must-know forbids in the browser: trace belongs in
 *     StitchTraceEntry, not in the captured `console.*` stream.
 *   - `fileSink(path)` is `createTrace({ console: false, file: path })`, which in
 *     a Worker resolves no `node:fs` and silently writes nowhere. Silent is the
 *     problem: a snippet from the trace-sinks guide would look like it worked.
 *
 * Both therefore delegate to the local `createTrace` — same neutered sink — and
 * say so via a RunNotice, matching how `env` / `cookieSession` / the OTLP pair
 * already behave.
 */
export function consoleSink(): TraceSink {
    emitShimNotice(
        'consoleSink',
        'Console trace is disabled in the browser sandbox — trace events are ' +
            'surfaced via StitchTraceEntry (the run panel) instead of the ' +
            'captured console stream (SANDBOX §5.7).',
    );
    return createTrace({ console: false, file: false });
}

export function fileSink(
    path?: string,
    opts?: Omit<
        Parameters<typeof coreCreateTrace>[0] & object,
        'console' | 'file'
    >,
): TraceSink {
    emitShimNotice(
        'fileSink',
        `JSONL trace files are a no-op in the browser sandbox${
            path ? ` (${path} is not written)` : ''
        } — the trace is surfaced via StitchTraceEntry instead (SANDBOX §5.7). ` +
            'Run on the server tier to write a real file.',
    );
    return createTrace({ ...(opts ?? {}), console: false, file: false });
}

/* ---- Server-tier surfaces, throwing stubs -------------------------------- */
export { cli, serve, mcp } from './shims/server-tier-stubs';

/* ---- Notice channel (R1 drains this after each run) ---------------------- */
export { drainNotices, peekNotices, emitNotice } from './shims/notices';
export type { RunNotice } from './shims/notices';

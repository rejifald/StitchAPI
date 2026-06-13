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
 * How the Node-built-in entanglement is handled (B1-SPIKE §1-§4) is OUT of this
 * file: the bundler aliases `node:crypto`/`node:fs`/`node:path` to ./shims/* and
 * `define`s `process` to ./shims/process. See build-stitch-browser.mjs and
 * B1-README.md. This file only deals with the API SURFACE.
 *
 * Surface map (SANDBOX §3 table):
 *   Browser-safe (re-exported verbatim from core):
 *     stitch, seam, preset, drift, graphql,
 *     bearer, apiKey, basic, oauth2,
 *     fetchAdapter, toValidator, memoryStore, multiplex, toOtlpJson, + all types
 *   Node-only, runs SHIMMED here (with a RunNotice):
 *     keychain, env            → ./shims/node-surfaces  (demo values)
 *     cookieSession            → ./shims/node-surfaces  (in-memory jar)
 *     createTrace              → shimmed below          (JSONL is a no-op)
 *     otlpTrace, otlpHttpExporter → ./shims/otlp-browser (no-op exporter, no egress)
 *   Server-tier only, THROWS here:
 *     cli, serve, mcp          → ./shims/server-tier-stubs
 */

/* ---- Browser-safe core surface (call API a Tier-1 snippet uses) ---------- */
export {
    stitch,
    seam,
    preset,
    drift,
    graphql,
    bearer,
    apiKey,
    basic,
    oauth2,
    fetchAdapter,
    toValidator,
    memoryStore,
    // `multiplex` is pure JS (B1-SPIKE §5) — safe to re-export verbatim.
    multiplex,
    // `toOtlpJson` is a pure span→JSON mapper (no Node) — safe verbatim.
    toOtlpJson,
} from 'stitchapi';

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
export { keychain, env, cookieSession } from './shims/node-surfaces';
export {
    otlpTrace,
    otlpHttpExporter,
    noopOtlpExporter,
} from './shims/otlp-browser';

/**
 * Browser `createTrace`: core's JSONL/console sink, neutered for the browser.
 *
 * Two Node touch-points are handled here so the sink can't trip in a Worker:
 *   - JSONL `file` writes are already no-ops via the `node:fs` alias, but a path
 *     does nothing — surface a notice (the trace is delivered via StitchTraceEntry,
 *     SANDBOX §5.7).
 *   - core defaults `console` to TRUE, and that branch calls `process.stderr.write`
 *     — which does NOT exist under the `process` define (a JSON literal can't carry
 *     a function). So we FORCE `console: false` in the browser. A snippet that wants
 *     console-style trace output uses `console.*` directly. (R1 must-know: do not
 *     re-enable core console trace in the browser — see B1-README.)
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
    // Force console off: core's console path writes to process.stderr (absent here).
    return coreCreateTrace({ ...(opts ?? {}), console: false });
}

/* ---- Server-tier surfaces, throwing stubs -------------------------------- */
export { cli, serve, mcp } from './shims/server-tier-stubs';

/* ---- Notice channel (R1 drains this after each run) ---------------------- */
export { drainNotices, peekNotices, emitNotice } from './shims/notices';
export type { RunNotice } from './shims/notices';

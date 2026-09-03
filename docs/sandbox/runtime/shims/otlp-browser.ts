/**
 * No-op browser OTLP exporter — B1 (browser `stitch` build).
 *
 * The default `otlp.exporter()` does a real `fetch` to an OTLP collector
 * (otlp.ts:384). Under the sandbox CSP (`connect-src 'self'`) that fails silently,
 * but the spike was explicit: don't rely on CSP alone (B1-SPIKE §7 / SANDBOX §7) —
 * make the browser build's default OTLP exporter a no-op.
 *
 * `otlp` is NODE_ONLY_SURFACES, so a snippet that names it routes to the server
 * tier when it exists; pre-server it runs shimmed.
 *
 * ─── Why this file rebuilds the whole namespace ────────────────────────────
 * Core folded the three OTLP names into ONE `otlp` namespace, so there is no
 * longer a per-name re-export to override. Overriding is now all-or-nothing: the
 * browser entry re-exports THIS `otlp` object IN PLACE OF core's, which means
 * anything this object omits is simply gone from the playground scope — a
 * `otlp.json is not a function` at snippet runtime, with nothing in the build to
 * catch it (playground-surface.ts explains why esbuild can't).
 *
 * So all THREE members are reconstructed explicitly, each with its own reason:
 *   - `sink`     → core's real sink, defaulted to the no-op exporter below so no
 *                  egress is ever attempted, + a shim notice.
 *   - `exporter` → a no-op SpanExporter (no network), + a shim notice.
 *   - `json`     → core's real serializer, VERBATIM. It is a pure span→JSON
 *                  mapper with no Node touch-points and no network of its own,
 *                  so shimming it would only make the playground lie about the
 *                  wire shape. It was re-exported verbatim from the browser entry
 *                  before the fold (as `toOtlpJson`) and keeps exactly that
 *                  behaviour here.
 *
 * The `node:crypto` alias already covers the sink's `randomBytes` span ids, so
 * the trace mapping itself still works — it just exports nowhere.
 */
import { emitShimNotice } from './notices';

import { otlp as coreOtlp } from 'stitchapi';
import type { OtelSpan, OtlpOptions, SpanExporter, TraceSink } from 'stitchapi';

const OTLP_NOTICE =
    'OTLP export is simulated in the browser sandbox — spans are built but not ' +
    'sent (no network egress). Run on the server tier for real OTLP.';

/** A SpanExporter that accepts spans and discards them — zero network. */
export function noopOtlpExporter(): SpanExporter {
    return {
        async export(_spans: OtelSpan[]): Promise<void> {
            /* no-op: real OTLP egress is server-tier only */
        },
    };
}

/** Drop-in for core `otlp.exporter` — never reaches the network. */
function browserOtlpExporter(
    _opts: { endpoint?: string; headers?: Record<string, string> } = {},
): SpanExporter {
    emitShimNotice('otlp.exporter', OTLP_NOTICE);
    return noopOtlpExporter();
}

/** Drop-in for core `otlp.sink` — builds spans, exports to the no-op exporter. */
function browserOtlpSink(opts: OtlpOptions = {}): TraceSink {
    emitShimNotice('otlp.sink', OTLP_NOTICE);
    return coreOtlp.sink({
        ...opts,
        exporter: opts.exporter ?? noopOtlpExporter(),
    });
}

/**
 * The browser `otlp` namespace, re-exported by stitch-browser.ts in place of
 * core's. Same three members, same call shapes — two neutered, `json` verbatim.
 */
export const otlp = {
    sink: browserOtlpSink,
    exporter: browserOtlpExporter,
    json: coreOtlp.json,
} as const;

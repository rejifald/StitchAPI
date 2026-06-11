/**
 * No-op browser OTLP exporter — B1 (browser `stitch` build).
 *
 * The default `otlpHttpExporter` does a real `fetch` to an OTLP collector
 * (otlp.ts:249). Under the sandbox CSP (`connect-src 'self'`) that fails silently,
 * but the spike was explicit: don't rely on CSP alone (B1-SPIKE §7 / SANDBOX §7) —
 * make the browser build's default OTLP exporter a no-op.
 *
 * `otlpTrace()` and `otlpHttpExporter()` are NODE_ONLY_SURFACES, so a snippet that
 * names them routes to the server tier when it exists; pre-server it runs shimmed.
 * The browser entry re-exports THESE in place of core's versions:
 *   - `otlpHttpExporter()` → a no-op SpanExporter (no network), + a shim notice.
 *   - `otlpTrace()`        → core's real otlpTrace, but defaulted to this no-op
 *     exporter so no egress is ever attempted, + a shim notice.
 *
 * The `node:crypto` alias already covers `otlpTrace`'s `randomBytes` span ids, so
 * the trace mapping itself still works — it just exports nowhere.
 */
import { emitShimNotice } from './notices';

import { otlpTrace as coreOtlpTrace } from 'stitchapi';
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

/** Drop-in for core `otlpHttpExporter` — never reaches the network. */
export function otlpHttpExporter(
    _opts: { endpoint?: string; headers?: Record<string, string> } = {},
): SpanExporter {
    emitShimNotice('otlpHttpExporter', OTLP_NOTICE);
    return noopOtlpExporter();
}

/** Drop-in for core `otlpTrace` — builds spans, exports to the no-op exporter. */
export function otlpTrace(opts: OtlpOptions = {}): TraceSink {
    emitShimNotice('otlpTrace', OTLP_NOTICE);
    return coreOtlpTrace({
        ...opts,
        exporter: opts.exporter ?? noopOtlpExporter(),
    });
}

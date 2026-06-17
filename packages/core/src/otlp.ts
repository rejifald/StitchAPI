// Opt-in OpenTelemetry/OTLP trace sink: maps a stitch's event stream to one CLIENT span per
// logical call, using OTel HTTP semantic-convention attributes, and hands finished spans to a
// SpanExporter. The default exporter POSTs OTLP/JSON to a collector; tests inject a stub
// exporter (no running collector). It is a normal TraceSink, so it tees alongside console/JSONL.
import type { StitchEvent, TraceContext, TraceSink } from './types';
import { hex, readEnv, scrubUrl, stripTrailingSlashes } from './util';

export type SpanAttributes = Record<string, string | number | boolean>;

export interface OtelSpanEvent {
    name: string;
    timeUnixMs: number;
    attributes?: SpanAttributes;
}

export interface OtelSpan {
    name: string;
    kind: 'CLIENT';
    traceId: string; // 32 hex chars
    spanId: string; // 16 hex chars
    parentSpanId?: string; // 16 hex chars — the spawning run's spanId (ADR 0007), absent for a root
    startUnixMs: number;
    endUnixMs: number;
    attributes: SpanAttributes;
    status: { code: 'UNSET' | 'OK' | 'ERROR'; message?: string };
    events: OtelSpanEvent[];
}

/** Receives finished spans. Implement this to ship spans anywhere; the default POSTs OTLP/JSON. */
export interface SpanExporter {
    export(spans: OtelSpan[]): void | Promise<void>;
}

export interface OtlpOptions {
    exporter?: SpanExporter; // override the destination (e.g. a stub in tests)
    endpoint?: string; // OTLP/HTTP base URL (default: env OTEL_EXPORTER_OTLP_ENDPOINT or localhost:4318)
    headers?: Record<string, string>; // extra headers for the OTLP POST (e.g. auth)
}

function serverAddress(url: string): string | undefined {
    try {
        return new URL(url).hostname;
    } catch {
        return undefined;
    }
}

// Build the FLAT per-iteration CHILD spans of a finished run span (ADR 0007, piece 3) — what makes
// the OTLP waterfall show "how each retry/page performed". Derived from the run's own span events
// (the engine's `request`/`paginate`/`retry` progress markers): a paginated run yields one `page N`
// child per completed page; a non-paginated run that retried yields one `attempt N` child per
// request (the non-final ones marked ERROR with the retry reason). A single clean request yields
// none — the run span IS the one operation. Children are flat (same traceId, parentSpanId = the run
// span), per the review's "flat, context-appropriate" choice: a paginated run shows pages, and a
// per-page retry stays a span event on the run, not a nested span.
function buildChildSpans(run: OtelSpan): OtelSpan[] {
    const child = (
        name: string,
        startUnixMs: number,
        endUnixMs: number,
        attributes: SpanAttributes,
        status: OtelSpan['status'],
    ): OtelSpan => ({
        name,
        kind: 'CLIENT',
        traceId: run.traceId,
        spanId: hex(8),
        parentSpanId: run.spanId,
        startUnixMs,
        endUnixMs,
        attributes,
        status,
        events: [],
    });

    const pages = run.events.filter((e) => e.name === 'paginate');
    if (pages.length > 0) {
        let prev = run.startUnixMs;
        return pages.map((p, i) => {
            const span = child(
                `page ${i + 1}`,
                prev,
                p.timeUnixMs,
                { 'stitch.page': i + 1 },
                { code: 'OK' }, // a page that emitted a paginate marker completed
            );
            prev = p.timeUnixMs;
            return span;
        });
    }

    const reqs = run.events.filter((e) => e.name === 'request');
    if (reqs.length > 1) {
        return reqs.map((r, i) => {
            const next = reqs[i + 1];
            const attempt = Number(r.attributes?.['stitch.attempt'] ?? i + 1);
            // A non-final attempt was followed by another request → it failed and was retried;
            // carry the retry reason. The final attempt's outcome IS the run's.
            const retry = run.events.find(
                (e) =>
                    e.name === 'retry' &&
                    e.timeUnixMs >= r.timeUnixMs &&
                    (next === undefined || e.timeUnixMs <= next.timeUnixMs),
            );
            const detail = retry?.attributes?.['stitch.detail'];
            const status: OtelSpan['status'] = next
                ? {
                      code: 'ERROR',
                      ...(detail !== undefined
                          ? { message: String(detail) }
                          : {}),
                  }
                : run.status;
            return child(
                `attempt ${attempt}`,
                r.timeUnixMs,
                next ? next.timeUnixMs : run.endUnixMs,
                { 'stitch.attempt': attempt },
                status,
            );
        });
    }
    return [];
}

/**
 * A TraceSink that turns each stitch call's events (start → … → done) into a single OTel CLIENT
 * span, exported on `done`. Attributes follow the OTel HTTP semantic conventions
 * (`http.request.method`, `url.full`, `server.address`, `http.response.status_code`,
 * `error.type`); a future LLM-kind stitch would map to the gen_ai.* conventions the same way.
 * Spans are correlated by the run id on the {@link TraceContext} ctx (ADR 0007) — a real
 * `traceId`/`spanId`/`parentSpanId` tree — falling back to the stitch name (a tolerant stack) only
 * when a sink is fed events by hand without ids (e.g. synthetic test events).
 */
export function otlpTrace(opts: OtlpOptions = {}): TraceSink {
    const exporter =
        opts.exporter ??
        otlpHttpExporter({
            ...(opts.endpoint !== undefined ? { endpoint: opts.endpoint } : {}),
            ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
        });
    const open = new Map<string, OtelSpan[]>();
    const push = (name: string, span: OtelSpan): void => {
        const stack = open.get(name) ?? [];
        stack.push(span);
        open.set(name, stack);
    };
    const top = (name: string): OtelSpan | undefined => {
        const stack = open.get(name);
        return stack?.[stack.length - 1];
    };

    const emit = (spans: OtelSpan[]): void => {
        try {
            const r = exporter.export(spans) as unknown;
            if (r instanceof Promise)
                r.catch(() => {
                    /* swallow: an export failure must never break the stream */
                });
        } catch {
            /* an exporter failure must never break the event stream */
        }
    };

    return {
        handle(event: StitchEvent, ctx: TraceContext): void {
            const name = ctx.name;
            // Correlate by run id (ADR 0007) — each run is unique, so no name-stack is needed;
            // fall back to the name when a sink is fed events by hand without ids.
            const key = ctx.runId ?? name;
            switch (event.type) {
                case 'start': {
                    // url.full is OTLP's only secret-bearing attribute (it never exports
                    // headers/bodies): scrub userinfo + secret query values before export.
                    const attributes: SpanAttributes = {
                        'http.request.method': event.method,
                        'url.full': scrubUrl(event.url),
                    };
                    const host = serverAddress(event.url);
                    if (host) attributes['server.address'] = host;
                    push(key, {
                        name: `${event.method} ${name}`,
                        kind: 'CLIENT',
                        // Read the engine-minted ids off the ctx (real trace tree); fall back to
                        // freshly-minted ids for a hand-fed sink with no run identity.
                        traceId: ctx.traceId ?? hex(16),
                        spanId: ctx.runId ?? hex(8),
                        ...(ctx.parentId !== undefined
                            ? { parentSpanId: ctx.parentId }
                            : {}),
                        startUnixMs: event.at,
                        endUnixMs: event.at,
                        attributes,
                        status: { code: 'UNSET' },
                        events: [],
                    });
                    break;
                }
                case 'progress': {
                    top(key)?.events.push({
                        name: event.phase,
                        timeUnixMs: event.at,
                        attributes: {
                            'stitch.attempt': event.attempt,
                            ...(event.detail
                                ? { 'stitch.detail': event.detail }
                                : {}),
                            ...(event.waitedMs != null
                                ? { 'stitch.waited_ms': event.waitedMs }
                                : {}),
                        },
                    });
                    break;
                }
                case 'info': {
                    top(key)?.events.push({
                        name: `info:${event.topic}`,
                        timeUnixMs: event.at,
                        attributes: {
                            'stitch.info.topic': event.topic,
                            ...(event.detail
                                ? { 'stitch.info.detail': event.detail }
                                : {}),
                        },
                    });
                    break;
                }
                case 'drift': {
                    top(key)?.events.push({
                        name: 'drift',
                        timeUnixMs: event.at,
                        attributes: {
                            'stitch.drift.level': event.finding.level,
                            'stitch.drift.path': event.finding.path,
                            'stitch.drift.change': event.finding.change,
                        },
                    });
                    break;
                }
                case 'result': {
                    const span = top(key);
                    if (span) {
                        span.attributes['http.response.status_code'] =
                            event.status;
                        if (span.status.code === 'UNSET')
                            span.status = { code: 'OK' };
                    }
                    break;
                }
                case 'error': {
                    const span = top(key);
                    if (span) {
                        if (event.status != null)
                            span.attributes['http.response.status_code'] =
                                event.status;
                        span.attributes['error.type'] =
                            event.status != null
                                ? String(event.status)
                                : 'error';
                        span.status = { code: 'ERROR', message: event.message };
                    }
                    break;
                }
                case 'done': {
                    const span = open.get(key)?.pop();
                    if (span) {
                        span.endUnixMs = event.at;
                        // Export the run span PLUS its flat per-iteration child spans (attempts /
                        // pages) so the operator's waterfall shows how each performed (ADR 0007).
                        emit([span, ...buildChildSpans(span)]);
                    }
                    break;
                }
            }
        },
        flush(): void {
            /* spans are exported eagerly on 'done'; nothing is buffered */
        },
    };
}

const OTLP_STATUS = { UNSET: 0, OK: 1, ERROR: 2 } as const;
const SPAN_KIND_CLIENT = 3;
const toNano = (ms: number): string => String(Math.round(ms * 1e6));

function toOtlpAttributes(attrs: SpanAttributes): unknown[] {
    return Object.entries(attrs).map(([key, v]) => ({
        key,
        value:
            typeof v === 'number'
                ? Number.isInteger(v)
                    ? { intValue: String(v) }
                    : { doubleValue: v }
                : typeof v === 'boolean'
                  ? { boolValue: v }
                  : { stringValue: v },
    }));
}

/** Serialize spans to the OTLP/JSON `ResourceSpans` shape a collector accepts on `/v1/traces`. */
export function toOtlpJson(spans: OtelSpan[]): unknown {
    return {
        resourceSpans: [
            {
                resource: {
                    attributes: toOtlpAttributes({
                        'service.name': 'stitchapi',
                    }),
                },
                scopeSpans: [
                    {
                        scope: { name: 'stitchapi' },
                        spans: spans.map((s) => ({
                            traceId: s.traceId,
                            spanId: s.spanId,
                            ...(s.parentSpanId
                                ? { parentSpanId: s.parentSpanId }
                                : {}),
                            name: s.name,
                            kind: SPAN_KIND_CLIENT,
                            startTimeUnixNano: toNano(s.startUnixMs),
                            endTimeUnixNano: toNano(s.endUnixMs),
                            attributes: toOtlpAttributes(s.attributes),
                            status: {
                                code: OTLP_STATUS[s.status.code],
                                ...(s.status.message
                                    ? { message: s.status.message }
                                    : {}),
                            },
                            events: s.events.map((e) => ({
                                name: e.name,
                                timeUnixNano: toNano(e.timeUnixMs),
                                attributes: toOtlpAttributes(
                                    e.attributes ?? {},
                                ),
                            })),
                        })),
                    },
                ],
            },
        ],
    };
}

/**
 * Default exporter: POST spans as OTLP/JSON to `${endpoint}/v1/traces` (endpoint defaults to
 * `OTEL_EXPORTER_OTLP_ENDPOINT` or `http://localhost:4318`). Fire-and-forget — failures are
 * swallowed so a missing collector never breaks a stitch call.
 */
export function otlpHttpExporter(
    opts: { endpoint?: string; headers?: Record<string, string> } = {},
): SpanExporter {
    const base =
        opts.endpoint ??
        readEnv('OTEL_EXPORTER_OTLP_ENDPOINT') ??
        'http://localhost:4318';
    const url = stripTrailingSlashes(base) + '/v1/traces';
    return {
        async export(spans: OtelSpan[]): Promise<void> {
            try {
                await fetch(url, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        ...(opts.headers ?? {}),
                    },
                    body: JSON.stringify(toOtlpJson(spans)),
                });
            } catch {
                /* no collector / network error — drop the batch, never throw */
            }
        },
    };
}

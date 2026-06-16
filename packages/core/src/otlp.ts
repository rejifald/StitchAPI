// Opt-in OpenTelemetry/OTLP trace sink: maps a stitch's event stream to one CLIENT span per
// logical call, using OTel HTTP semantic-convention attributes, and hands finished spans to a
// SpanExporter. The default exporter POSTs OTLP/JSON to a collector; tests inject a stub
// exporter (no running collector). It is a normal TraceSink, so it tees alongside console/JSONL.
import type { StitchEvent, TraceSink } from './types';
import { readEnv, scrubUrl } from './util';

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

// Browser-safe random hex ids: crypto.getRandomValues where available, else Math.random
// (ids only need to be unique-ish, not secret).
function hex(bytes: number): string {
    const buf = new Uint8Array(bytes);
    const c = globalThis.crypto as Crypto | undefined;
    if (c?.getRandomValues) c.getRandomValues(buf);
    else
        for (let i = 0; i < buf.length; i++)
            buf[i] = Math.floor(Math.random() * 256);
    return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

function serverAddress(url: string): string | undefined {
    try {
        return new URL(url).hostname;
    } catch {
        return undefined;
    }
}

/**
 * A TraceSink that turns each stitch call's events (start → … → done) into a single OTel CLIENT
 * span, exported on `done`. Attributes follow the OTel HTTP semantic conventions
 * (`http.request.method`, `url.full`, `server.address`, `http.response.status_code`,
 * `error.type`); a future LLM-kind stitch would map to the gen_ai.* conventions the same way.
 * Spans are correlated per stitch name (sequential calls keep 0–1 open; a stack tolerates nesting).
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

    const emit = (span: OtelSpan): void => {
        try {
            const r = exporter.export([span]) as unknown;
            if (r instanceof Promise)
                r.catch(() => {
                    /* swallow: an export failure must never break the stream */
                });
        } catch {
            /* an exporter failure must never break the event stream */
        }
    };

    return {
        handle(event: StitchEvent, ctx: { name: string }): void {
            const name = ctx.name;
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
                    push(name, {
                        name: `${event.method} ${name}`,
                        kind: 'CLIENT',
                        traceId: hex(16),
                        spanId: hex(8),
                        startUnixMs: event.at,
                        endUnixMs: event.at,
                        attributes,
                        status: { code: 'UNSET' },
                        events: [],
                    });
                    break;
                }
                case 'progress': {
                    top(name)?.events.push({
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
                    top(name)?.events.push({
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
                    top(name)?.events.push({
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
                    const span = top(name);
                    if (span) {
                        span.attributes['http.response.status_code'] =
                            event.status;
                        if (span.status.code === 'UNSET')
                            span.status = { code: 'OK' };
                    }
                    break;
                }
                case 'error': {
                    const span = top(name);
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
                    const span = open.get(name)?.pop();
                    if (span) {
                        span.endUnixMs = event.at;
                        emit(span);
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
    const url = base.replace(/\/+$/, '') + '/v1/traces';
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

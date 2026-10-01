// `stitchapi/otlp` — the opt-in OpenTelemetry/OTLP trace pipeline. It is a subpath of its own (the
// ADR 0021 move, for the same bundle reason as `cache` and `auth`): the root barrel does not export
// it and nothing on the core path imports it statically. `STITCH_EXPORT=otlp` reaches it through a
// lazy `import('./otlp')` in stitch.ts; a host that wires `trace: otlp.sink()` by hand imports it.
//
// The sink maps each stitch call's event stream to a span TREE (ADR
// 0017 D6) — one INTERNAL run span, a page span per page when paginating, and one attempt span per
// physical request (CLIENT with the OTel HTTP semantic-convention attributes, or INTERNAL for a
// surface that replaces the HTTP transport) — and hands finished spans to a SpanExporter. The
// default exporter POSTs OTLP/JSON to a collector; tests inject a stub exporter (no running
// collector). It is a normal TraceSink, so it tees alongside console/JSONL.
import { compact } from './compact';
import type { StitchEvent, TraceContext, TraceSink } from './types';
import { hex, readEnv, scrubUrl, stripTrailingSlashes } from './util';

/** OTel attribute values: a scalar, or a homogeneous array of one. */
export type SpanAttributes = Record<
    string,
    string | number | boolean | string[] | number[] | boolean[]
>;

export interface OtelSpanEvent {
    name: string;
    timeUnixMs: number;
    attributes?: SpanAttributes;
}

export interface OtelSpan {
    name: string;
    /**
     * The OTLP span kind. The sink emits `INTERNAL` (the run, a page, a non-HTTP attempt) and
     * `CLIENT` (an HTTP attempt); the rest of the OTLP set is here for exporters that relay
     * spans from elsewhere.
     */
    kind: 'INTERNAL' | 'SERVER' | 'CLIENT' | 'PRODUCER' | 'CONSUMER';
    traceId: string; // 32 hex chars
    spanId: string; // 16 hex chars
    parentSpanId?: string; // 16 hex chars — the run's parent (ADR 0007), or the run/page above a child span
    startUnixMs: number;
    endUnixMs: number;
    attributes: SpanAttributes;
    status: { code: 'UNSET' | 'OK' | 'ERROR'; message?: string };
    events: OtelSpanEvent[];
}

/** Receives finished spans. Implement this to ship spans anywhere; the default POSTs OTLP/JSON. */
export interface SpanExporter {
    /**
     * `resource` is the sink's resolved resource (`service.name`, `telemetry.sdk.*`, the
     * `OTEL_RESOURCE_ATTRIBUTES` entries, `OtlpOptions.resource`) — pass it to `otlp.json` so a
     * custom transport ships the same resource the default exporter does.
     */
    export(spans: OtelSpan[], resource?: SpanAttributes): void | Promise<void>;
}

export interface OtlpOptions {
    exporter?: SpanExporter; // override the destination (e.g. a stub in tests)
    /**
     * OTLP/HTTP base URL; spans POST to `${endpoint}/v1/traces`. Default: `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
     * (a full URL, used as-is), else `OTEL_EXPORTER_OTLP_ENDPOINT` + `/v1/traces`, else
     * `http://localhost:4318`.
     */
    endpoint?: string;
    /**
     * Extra headers for the OTLP POST (e.g. auth), merged over `OTEL_EXPORTER_OTLP_HEADERS` and
     * `OTEL_EXPORTER_OTLP_TRACES_HEADERS` (`key=value,…` pairs, percent-encoded values): an
     * explicit header wins over the environment's.
     */
    headers?: Record<string, string>;
    /**
     * Resource attributes describing the process that emits the spans — set `service.name` here.
     * Merged over the environment, which is read once when the sink is built: `service.name`
     * defaults to `OTEL_SERVICE_NAME`, else `unknown_service`; `OTEL_RESOURCE_ATTRIBUTES`
     * (`key=value,…`, percent-encoded) adds the rest; `telemetry.sdk.*` names this SDK.
     */
    resource?: SpanAttributes;
}

/** The semantic-conventions version the exported attributes follow (`schemaUrl` on the batch). */
const SCHEMA_URL = 'https://opentelemetry.io/schemas/1.44.0';

// The package version, from the build-time `define` (src/version.d.ts). `typeof` rather than a bare
// read because a workspace package's tests alias `stitchapi` to this source without the define, and
// a bare read of an undefined global throws at import; the bundle folds the guard away.
//
// Declared here as well, module-scoped (esbuild erases it, so the `define` still applies): those same
// workspace packages typecheck this file through a `paths` alias and never load version.d.ts, so
// without it every one of them fails with `Cannot find name '__PKG_VERSION__'`.
declare const __PKG_VERSION__: string | undefined;
const VERSION = typeof __PKG_VERSION__ === 'string' ? __PKG_VERSION__ : '0.0.0';

// An OTel `key=value,key=value` environment list (the W3C Baggage shape `OTEL_RESOURCE_ATTRIBUTES`
// and `OTEL_EXPORTER_OTLP_HEADERS` share): split on the FIRST `=`, so a value may carry one itself
// (base64 padding), trim, percent-decode both sides, skip an entry with no key. A variable with a
// value that fails to decode is discarded whole (the OTel resource SDK spec), never thrown.
function envPairs(name: string): Record<string, string> {
    try {
        return Object.fromEntries(
            (readEnv(name) ?? '').split(',').flatMap((pair) => {
                const eq = pair.indexOf('=');
                return eq > 0
                    ? [
                          [
                              decodeURIComponent(pair.slice(0, eq).trim()),
                              decodeURIComponent(pair.slice(eq + 1).trim()),
                          ],
                      ]
                    : [];
            }),
        );
    } catch {
        return {};
    }
}

// An empty variable is an unset one (OTel SDK environment spec): `||`, not `??`.
// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
const envOf = (name: string): string | undefined => readEnv(name) || undefined;

/**
 * Resolve the resource for a sink: the SDK's own attributes, then the environment
 * (`OTEL_RESOURCE_ATTRIBUTES`, then `OTEL_SERVICE_NAME`, which wins over the former's
 * `service.name`), then the caller's `resource`, each overriding the last.
 */
function otlpResource(resource?: SpanAttributes): SpanAttributes {
    const env = envPairs('OTEL_RESOURCE_ATTRIBUTES');
    return {
        'telemetry.sdk.name': 'stitchapi',
        'telemetry.sdk.language': (
            globalThis as { process?: { versions?: { node?: string } } }
        ).process?.versions?.node
            ? 'nodejs'
            : 'webjs',
        'telemetry.sdk.version': VERSION,
        ...env,
        'service.name':
            envOf('OTEL_SERVICE_NAME') ??
            env['service.name'] ??
            'unknown_service',
        ...resource,
    };
}

// One run's spans while its events stream in. Children are pushed as they OPEN (parent before
// child) and mutated as they close; all of them export with the run on `done`.
interface OpenRun {
    span: OtelSpan; // the run span
    http: boolean; // attempts go out over HTTP (CLIENT + http.*), not a surface's own transport
    name: string; // an attempt span's name: the method (HTTP) or the transport's id
    base: SpanAttributes; // what every attempt carries (method, url.full, server.*)
    kids: OtelSpan[];
    attempt?: OtelSpan | undefined; // the attempt in flight
    page?: OtelSpan | undefined; // the page in flight
    pages: number; // pages completed
    last: number; // when the previous page ended — the next page span starts there
    sent: number; // requests sent in the current page (or the run) → `http.request.resend_count`
}

const span = (
    name: string,
    kind: OtelSpan['kind'],
    traceId: string,
    spanId: string,
    parentSpanId: string | undefined,
    at: number,
    attributes: SpanAttributes,
): OtelSpan =>
    compact({
        name,
        kind,
        traceId,
        spanId,
        parentSpanId,
        startUnixMs: at,
        endUnixMs: at,
        attributes,
        status: { code: 'UNSET' },
        // `compact`'s `const` generic would freeze `[]` to `readonly []`; pin the element type.
        events: [] as OtelSpanEvent[],
    });

// Settle a span as failed: ERROR with the message, and a low-cardinality `error.type` — the error's
// class when the engine named one, else (over HTTP) the status as a string, else semconv's `_OTHER`.
function fail(
    s: OtelSpan,
    http: boolean,
    status?: number,
    type?: string,
    message?: string,
): void {
    s.status = compact({ code: 'ERROR', message });
    s.attributes['error.type'] =
        type ?? (http && (status ?? 0) >= 400 ? String(status) : '_OTHER');
}

// Close the attempt in flight at `at`. A received status becomes `http.response.status_code`. `ok`
// says the attempt delivered the call's outcome; one that was resent (retry, auth refresh,
// reconnect) or threw is an ERROR, and so — per HTTP semconv for a CLIENT span — is a 4xx/5xx.
function endAttempt(
    r: OpenRun,
    at: number,
    ok: boolean,
    status?: number,
    type?: string,
    message?: string,
): void {
    const a = r.attempt;
    if (!a) return;
    r.attempt = undefined;
    a.endUnixMs = at;
    if (r.http && status !== undefined)
        a.attributes['http.response.status_code'] = status;
    if (!ok || (r.http && (status ?? 0) >= 400))
        fail(a, r.http, status, type, message);
}

// Close the page in flight at `at`; a run that failed inside it (`failed`) fails the page too.
function endPage(r: OpenRun, at: number, failed?: string): void {
    const p = r.page;
    if (!p) return;
    r.page = undefined;
    p.endUnixMs = r.last = at;
    r.pages++;
    if (failed !== undefined) fail(p, false, undefined, undefined, failed);
}

/**
 * Sink layer of {@link otlp}; the namespace carries the contract. Internal — the module
 * exports the namespace, not this.
 *
 * A TraceSink that turns each stitch call's events (start → … → done) into a span tree, exported
 * on `done` (ADR 0017 D6):
 *
 * - the **run** span — INTERNAL, named for the stitch, carrying `stitch.name`/`stitch.surface`,
 *   the progress/info/drift span events, and the run's status (UNSET on success, ERROR on
 *   failure); never an `http.*` attribute;
 * - a **page** span per page of a paginated run — INTERNAL, a child of the run;
 * - an **attempt** span per physical request, always (a single clean request included) — a child
 *   of its page, else of the run. Over HTTP it is a CLIENT span named `{method}` with the OTel HTTP
 *   semantic-convention attributes (`http.request.method`, `url.full`, `server.address`,
 *   `server.port`, `http.response.status_code`, `http.request.resend_count` on a resend,
 *   `error.type`); for a surface that replaces the transport (`shell`, `postmessage`) it is an
 *   INTERNAL span with none of them.
 *
 * Span ids come from the engine: the run's off the {@link TraceContext} ctx (ADR 0007), an attempt's
 * and a page's off the `progress` events that open and close them. A sink fed events by hand
 * without ids mints its own and correlates by stitch name (a tolerant stack).
 */
function otlpSink(opts: OtlpOptions = {}): TraceSink {
    const exporter =
        opts.exporter ??
        otlpHttpExporter(
            compact({
                endpoint: opts.endpoint,
                headers: opts.headers,
            }),
        );
    const resource = otlpResource(opts.resource);
    const runs = new Map<string, OpenRun[]>();

    const emit = (spans: OtelSpan[]): void => {
        try {
            const r = exporter.export(spans, resource) as unknown;
            if (r instanceof Promise)
                r.catch(() => {
                    /* swallow: an export failure must never break the stream */
                });
        } catch {
            /* an exporter failure must never break the event stream */
        }
    };

    const sink: TraceSink = {
        handle(event: StitchEvent, ctx: TraceContext): void {
            // Correlate by run id (ADR 0007) — each run is unique, so no name-stack is needed;
            // fall back to the name when a sink is fed events by hand without ids.
            const key = ctx.spanId ?? ctx.name;
            const stack = runs.get(key) ?? [];
            if (event.type === 'start') {
                const http = (event.transport ?? 'http') === 'http';
                // `url.full` is OTLP's only secret-bearing attribute (it never exports headers or
                // bodies): scrub userinfo + secret query values before export. Parsed once — every
                // attempt of the run targets this URL.
                let u: URL | undefined;
                try {
                    u = new URL(event.url);
                } catch {
                    /* relative or opaque — no server.* attributes */
                }
                stack.push({
                    // Read the engine-minted ids off the ctx (real trace tree), else off the
                    // `start` event (a `.stream()` tap fed in by hand); mint fresh ones only for
                    // events with no run identity at all.
                    span: span(
                        ctx.name,
                        'INTERNAL',
                        ctx.traceId ?? event.traceId ?? hex(16),
                        ctx.spanId ?? event.spanId ?? hex(8),
                        ctx.parentSpanId ?? event.parentSpanId,
                        event.at,
                        compact({
                            'stitch.name': ctx.name,
                            'stitch.surface': event.surface,
                        }),
                    ),
                    http,
                    name: http ? event.method : String(event.transport),
                    base: http
                        ? compact({
                              'http.request.method': event.method,
                              'url.full': scrubUrl(event.url),
                              'server.address': u?.hostname,
                              'server.port': u
                                  ? Number(u.port) ||
                                    (u.protocol === 'https:' ? 443 : 80)
                                  : undefined,
                          })
                        : {},
                    kids: [],
                    pages: 0,
                    last: event.at,
                    sent: 0,
                });
                runs.set(key, stack);
                return;
            }
            const r = stack[stack.length - 1];
            if (!r) return;
            const run = r.span;
            const { at } = event;
            switch (event.type) {
                case 'progress': {
                    const { phase } = event;
                    run.events.push({
                        name: phase,
                        timeUnixMs: at,
                        attributes: compact({
                            'stitch.attempt': event.attempt,
                            'stitch.detail': event.detail,
                            'stitch.waited': event.waited,
                        }),
                    });
                    if (phase === 'request') {
                        // A request while one is still in flight means that one was resent.
                        endAttempt(r, at, false);
                        // An attempt parented to anything but the run lives in a page: the first
                        // request under a new parent opens that page span, at the previous
                        // page's end, and restarts the resend count.
                        const parent = event.parentSpanId ?? run.spanId;
                        if (
                            parent !== run.spanId &&
                            r.page?.spanId !== parent
                        ) {
                            r.kids.push(
                                (r.page = span(
                                    `page ${r.pages + 1}`,
                                    'INTERNAL',
                                    run.traceId,
                                    parent,
                                    run.spanId,
                                    r.last,
                                    { 'stitch.page': r.pages + 1 },
                                )),
                            );
                            r.sent = 0;
                        }
                        r.kids.push(
                            (r.attempt = span(
                                r.name,
                                r.http ? 'CLIENT' : 'INTERNAL',
                                run.traceId,
                                event.spanId ?? hex(8),
                                parent,
                                at,
                                compact({
                                    ...r.base,
                                    'http.request.resend_count':
                                        (r.http && r.sent) || undefined,
                                    'stitch.attempt': event.attempt,
                                }),
                            )),
                        );
                        r.sent++;
                    } else if (
                        phase === 'retry' ||
                        phase === 'auth' ||
                        phase === 'reconnect'
                    ) {
                        // The attempt in flight is about to be resent: it ended here, failed.
                        endAttempt(
                            r,
                            at,
                            false,
                            event.status,
                            event.errorType,
                            event.detail,
                        );
                    } else if (phase === 'paginate') {
                        endAttempt(r, at, true, event.status);
                        endPage(r, at);
                    }
                    break;
                }
                case 'info': {
                    run.events.push({
                        name: `info:${event.topic}`,
                        timeUnixMs: at,
                        attributes: compact({
                            'stitch.info.topic': event.topic,
                            'stitch.info.detail': event.detail,
                        }),
                    });
                    break;
                }
                case 'drift': {
                    run.events.push({
                        name: 'drift',
                        timeUnixMs: at,
                        attributes: {
                            'stitch.drift.level': event.finding.level,
                            'stitch.drift.path': event.finding.path,
                            'stitch.drift.change': event.finding.change,
                        },
                    });
                    break;
                }
                case 'result': {
                    // Success leaves the run UNSET (semconv); the attempt records the response.
                    endAttempt(r, at, true, event.status);
                    break;
                }
                case 'error': {
                    const { status, errorType, message } = event;
                    // The attempt failed only if its exchange did: no response (a throw) or an
                    // error status. A response the run rejected afterwards (a contract violation,
                    // a surface's verdict) leaves the attempt's HTTP exchange successful.
                    endAttempt(
                        r,
                        at,
                        (status ?? 500) < 400,
                        status,
                        errorType,
                        message,
                    );
                    endPage(r, at, message);
                    fail(run, r.http, status, errorType, message);
                    break;
                }
                case 'done': {
                    stack.pop();
                    // Drop the Map entry once its stack empties so `runs` doesn't grow one entry
                    // per unique run/span key over long uptime (each run id is seen once).
                    if (!stack.length) runs.delete(key);
                    endAttempt(r, at, event.ok);
                    endPage(r, at);
                    run.endUnixMs = at;
                    emit([run, ...r.kids]);
                    break;
                }
            }
        },
        flush(): void {
            /* spans are exported eagerly on 'done'; nothing is buffered */
        },
    };
    // Non-enumerable test probe for the internal run map: lets the resource-leak suite assert the
    // map drains to empty after a completed run without exposing it on the public TraceSink type
    // (non-enumerable → never serialized into a trace, never part of the contract). The key is a
    // registered symbol — `Symbol.for('stitch.otlp.openSpans')` — so the suite reads it without
    // this module exporting an internal.
    Object.defineProperty(sink, Symbol.for('stitch.otlp.openSpans'), {
        value: runs,
        enumerable: false,
    });
    return sink;
}

const OTLP_STATUS = { UNSET: 0, OK: 1, ERROR: 2 } as const;
// OTLP's SpanKind enum, in wire order (SPAN_KIND_INTERNAL = 1 … SPAN_KIND_CONSUMER = 5).
const KINDS = ['INTERNAL', 'SERVER', 'CLIENT', 'PRODUCER', 'CONSUMER'];
const toNano = (ms: number): string => String(Math.round(ms * 1e6));

// One attribute value as an OTLP `AnyValue`; an array becomes an `arrayValue` of them.
const anyValue = (v: SpanAttributes[string]): unknown =>
    Array.isArray(v)
        ? { arrayValue: { values: v.map(anyValue) } }
        : typeof v === 'number'
          ? Number.isInteger(v)
              ? { intValue: String(v) }
              : { doubleValue: v }
          : typeof v === 'boolean'
            ? { boolValue: v }
            : { stringValue: v };

function toOtlpAttributes(attrs: SpanAttributes): unknown[] {
    return Object.entries(attrs).map(([key, v]) => ({
        key,
        value: anyValue(v),
    }));
}

/**
 * Serializer layer of {@link otlp}; the namespace carries the contract. Internal — the module
 * exports the namespace, not this.
 *
 * Serialize spans to the OTLP/JSON `ResourceSpans` shape a collector accepts on `/v1/traces`.
 * `resource` defaults to the one an `otlp.sink()` with no options would resolve from the
 * environment; the scope is `stitchapi` at its package version, and both carry the `schemaUrl`
 * of the semantic-conventions version the attributes follow.
 */
function toOtlpJson(
    spans: OtelSpan[],
    resource: SpanAttributes = otlpResource(),
): unknown {
    return {
        resourceSpans: [
            {
                resource: { attributes: toOtlpAttributes(resource) },
                scopeSpans: [
                    {
                        scope: { name: 'stitchapi', version: VERSION },
                        spans: spans.map((s) => ({
                            traceId: s.traceId,
                            spanId: s.spanId,
                            ...(s.parentSpanId
                                ? { parentSpanId: s.parentSpanId }
                                : {}),
                            name: s.name,
                            kind: KINDS.indexOf(s.kind) + 1,
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
                        schemaUrl: SCHEMA_URL,
                    },
                ],
                schemaUrl: SCHEMA_URL,
            },
        ],
    };
}

/**
 * Options for `otlp.exporter` — {@link OtlpOptions} minus the exporter it builds and the
 * `resource`, which the sink resolves and hands to `export` with every batch.
 */
export type OtlpExporterOptions = Omit<OtlpOptions, 'exporter' | 'resource'>;

// HTTP header names are case-insensitive: fold them so an explicit `Authorization` replaces an
// environment `authorization` instead of riding beside it as a second value.
const lowerKeys = (h: Record<string, string> = {}): Record<string, string> =>
    Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

/**
 * Exporter layer of {@link otlp}; the namespace carries the contract. Internal — the module
 * exports the namespace, not this.
 *
 * Default exporter: POST spans as OTLP/JSON, with the resource the sink hands it. Where it posts
 * follows the OTel exporter spec: `opts.endpoint` (a base URL, `/v1/traces` appended), else
 * `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (the full URL, used as-is), else `OTEL_EXPORTER_OTLP_ENDPOINT`
 * (a base URL, `/v1/traces` appended), else `http://localhost:4318`. Headers are
 * `OTEL_EXPORTER_OTLP_HEADERS`, then `OTEL_EXPORTER_OTLP_TRACES_HEADERS`, then `opts.headers`,
 * each overriding the last. Fire-and-forget — failures are swallowed so a missing collector never
 * breaks a stitch call.
 */
function otlpHttpExporter(opts: OtlpExporterOptions = {}): SpanExporter {
    const url =
        (opts.endpoint === undefined
            ? envOf('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT')
            : undefined) ??
        stripTrailingSlashes(
            opts.endpoint ??
                envOf('OTEL_EXPORTER_OTLP_ENDPOINT') ??
                'http://localhost:4318',
        ) + '/v1/traces';
    const headers = {
        'content-type': 'application/json',
        ...lowerKeys(envPairs('OTEL_EXPORTER_OTLP_HEADERS')),
        ...lowerKeys(envPairs('OTEL_EXPORTER_OTLP_TRACES_HEADERS')),
        ...lowerKeys(opts.headers),
    };
    return {
        async export(spans, resource): Promise<void> {
            try {
                await fetch(url, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(toOtlpJson(spans, resource)),
                });
            } catch {
                /* no collector / network error — drop the batch, never throw */
            }
        },
    };
}

/**
 * The OTLP trace pipeline — one namespace for one export path (ADR 0007 correlates the spans
 * it builds), imported from `stitchapi/otlp`. The shape is the token grammars’ and `secrets`’: one
 * name per dimension, the role named at the call site, rather than three names repeating the
 * subject noun.
 *
 * The three are layers of a single pipeline, not independent helpers, which is why they read
 * better as one name — each is the input to the next:
 *
 * - `otlp.sink(opts?)` is the {@link TraceSink} you pass to `trace`. It maps each stitch call's
 *   events (start → … → done) to a span tree — an INTERNAL run span, page spans, and a CLIENT span
 *   per HTTP request with OTel HTTP semantic-convention attributes (ADR 0017 D6) — and hands
 *   finished spans to an exporter — `opts.exporter`, or `otlp.exporter()` by default — together
 *   with the resource it resolved (`opts.resource` over `OTEL_SERVICE_NAME` /
 *   `OTEL_RESOURCE_ATTRIBUTES`).
 * - `otlp.exporter(opts?)` is that default {@link SpanExporter}: it POSTs to
 *   `${endpoint}/v1/traces`, fire-and-forget, so a missing collector never breaks a call.
 * - `otlp.json(spans, resource?)` is the serializer underneath both — the OTLP/JSON
 *   `ResourceSpans` shape a collector ingests. Public because it is the seam for a transport core
 *   does not ship: build your own exporter around gRPC, a queue, or a file, and serialize with the
 *   same mapper the HTTP one uses rather than re-deriving the wire shape and drifting from it.
 *
 * Reach for the layer you actually need: `otlp.sink()` alone for the common case, `otlp.exporter`
 * to point a sink at a second collector, `otlp.json` only when you are writing a transport.
 */
export const otlp = {
    sink: otlpSink,
    exporter: otlpHttpExporter,
    json: toOtlpJson,
} as const;

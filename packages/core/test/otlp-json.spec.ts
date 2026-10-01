// Direct tests for toOtlpJson (src/otlp.ts) — the OTLP/JSON `ResourceSpans` serializer a collector
// ingests on /v1/traces. otlp-export.spec.ts asserts the SPAN objects (OtelSpan) an otlp.sink sink
// produces; run-identity.spec.ts checks only that parentSpanId is serialized. The wire-shape itself
// — the resource/scope envelope, attribute value TYPING (int vs double vs bool vs string), the
// nanosecond timestamps, the status-code mapping, and event serialization — was unpinned. A drift
// here silently breaks collector ingestion, so it deserves a contract test.
import { toOtlpJson } from '../src/otlp';
import type { OtelSpan } from '../src/otlp';

interface OtlpAttr {
    key: string;
    value: Record<string, unknown>;
}
interface OtlpSpan {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    name: string;
    kind: number;
    startTimeUnixNano: string;
    endTimeUnixNano: string;
    attributes: OtlpAttr[];
    status: { code: number; message?: string };
    events: { name: string; timeUnixNano: string; attributes: OtlpAttr[] }[];
}
interface OtlpDoc {
    resourceSpans: {
        resource: { attributes: OtlpAttr[] };
        schemaUrl: string;
        scopeSpans: {
            scope: { name: string; version: string };
            schemaUrl: string;
            spans: OtlpSpan[];
        }[];
    }[];
}

const baseSpan = (over: Partial<OtelSpan> = {}): OtelSpan => ({
    name: 'GET /things',
    kind: 'CLIENT',
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    startUnixMs: 1000,
    endUnixMs: 1002.5,
    attributes: {},
    status: { code: 'UNSET' },
    events: [],
    ...over,
});

const firstSpan = (spans: OtelSpan[]): OtlpSpan => {
    const doc = toOtlpJson(spans) as OtlpDoc;
    return doc.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
};

const attr = (attrs: OtlpAttr[], key: string): Record<string, unknown> =>
    attrs.find((a) => a.key === key)!.value;

describe('toOtlpJson', () => {
    it('wraps spans in the ResourceSpans envelope (resource + versioned scope + schemaUrl)', () => {
        const doc = toOtlpJson([baseSpan()], {
            'service.name': 'checkout',
        }) as OtlpDoc;
        const rs = doc.resourceSpans[0]!;
        expect(rs.resource.attributes).toEqual([
            { key: 'service.name', value: { stringValue: 'checkout' } },
        ]);
        const schema = /^https:\/\/opentelemetry\.io\/schemas\/\d+\.\d+\.\d+$/;
        expect(rs.schemaUrl).toMatch(schema);
        expect(rs.scopeSpans[0]!.schemaUrl).toBe(rs.schemaUrl);
        expect(rs.scopeSpans[0]!.scope).toEqual({
            name: 'stitchapi',
            version: __PKG_VERSION__,
        });
    });

    it('defaults the resource to the environment: OTEL_SERVICE_NAME, else unknown_service', () => {
        vi.stubEnv('OTEL_SERVICE_NAME', '');
        vi.stubEnv('OTEL_RESOURCE_ATTRIBUTES', '');
        try {
            const rs = (toOtlpJson([baseSpan()]) as OtlpDoc).resourceSpans[0]!;
            expect(attr(rs.resource.attributes, 'service.name')).toEqual({
                stringValue: 'unknown_service',
            });
            expect(attr(rs.resource.attributes, 'telemetry.sdk.name')).toEqual({
                stringValue: 'stitchapi',
            });
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('maps every span kind to its OTLP enum value', () => {
        const kinds = [
            'INTERNAL',
            'SERVER',
            'CLIENT',
            'PRODUCER',
            'CONSUMER',
        ] as const;
        expect(
            kinds.map((kind) => firstSpan([baseSpan({ kind })]).kind),
        ).toEqual([1, 2, 3, 4, 5]);
    });

    it('serializes an array attribute as an arrayValue of typed values', () => {
        const span = firstSpan([
            baseSpan({
                attributes: { 'stitch.tags': ['a', 'b'], codes: [1, 2.5] },
            }),
        ]);
        expect(attr(span.attributes, 'stitch.tags')).toEqual({
            arrayValue: {
                values: [{ stringValue: 'a' }, { stringValue: 'b' }],
            },
        });
        expect(attr(span.attributes, 'codes')).toEqual({
            arrayValue: { values: [{ intValue: '1' }, { doubleValue: 2.5 }] },
        });
    });

    it('types attribute values as int / double / bool / string', () => {
        const span = firstSpan([
            baseSpan({
                attributes: {
                    'http.response.status_code': 200, // integer
                    'http.client.duration': 1.5, // float
                    'stitch.cached': true, // boolean
                    'http.request.method': 'GET', // string
                },
            }),
        ]);
        expect(attr(span.attributes, 'http.response.status_code')).toEqual({
            intValue: '200',
        });
        expect(attr(span.attributes, 'http.client.duration')).toEqual({
            doubleValue: 1.5,
        });
        expect(attr(span.attributes, 'stitch.cached')).toEqual({
            boolValue: true,
        });
        expect(attr(span.attributes, 'http.request.method')).toEqual({
            stringValue: 'GET',
        });
    });

    it('converts millisecond timestamps to nanosecond strings', () => {
        const span = firstSpan([
            baseSpan({ startUnixMs: 1000, endUnixMs: 1002.5 }),
        ]);
        expect(span.startTimeUnixNano).toBe('1000000000'); // 1000 ms × 1e6
        expect(span.endTimeUnixNano).toBe('1002500000'); // 1002.5 ms × 1e6
    });

    it('maps status codes UNSET/OK/ERROR → 0/1/2', () => {
        expect(
            firstSpan([baseSpan({ status: { code: 'UNSET' } })]).status,
        ).toEqual({
            code: 0,
        });
        expect(
            firstSpan([baseSpan({ status: { code: 'OK' } })]).status,
        ).toEqual({
            code: 1,
        });
    });

    it('includes a status message only when present', () => {
        expect(
            firstSpan([
                baseSpan({ status: { code: 'ERROR', message: 'boom' } }),
            ]).status,
        ).toEqual({ code: 2, message: 'boom' });
    });

    it('serializes span events with nanosecond time and typed attributes', () => {
        const span = firstSpan([
            baseSpan({
                events: [
                    {
                        name: 'retry',
                        timeUnixMs: 1001,
                        attributes: { attempt: 2 },
                    },
                ],
            }),
        ]);
        expect(span.events).toHaveLength(1);
        expect(span.events[0]!.name).toBe('retry');
        expect(span.events[0]!.timeUnixNano).toBe('1001000000');
        expect(attr(span.events[0]!.attributes, 'attempt')).toEqual({
            intValue: '2',
        });
    });

    it('emits an empty attribute list for an event with no attributes', () => {
        const span = firstSpan([
            baseSpan({ events: [{ name: 'tick', timeUnixMs: 1001 }] }),
        ]);
        expect(span.events[0]!.attributes).toEqual([]);
    });
});

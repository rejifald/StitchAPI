// The default OTLP exporter follows the OTel exporter environment spec: where it POSTs
// (`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` used as-is over `OTEL_EXPORTER_OTLP_ENDPOINT` + `/v1/traces`)
// and which headers it sends (`OTEL_EXPORTER_OTLP_HEADERS`, `key=value` pairs with percent-encoded
// values, under any explicit `headers` option). Each case stubs `fetch`, builds an exporter, ships
// one empty batch and reads what the request carried — no collector, no network.
import { otlp } from '../src/otlp';

const ENV = [
    'OTEL_EXPORTER_OTLP_ENDPOINT',
    'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
    'OTEL_EXPORTER_OTLP_HEADERS',
    'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
    'OTEL_RESOURCE_ATTRIBUTES',
    'OTEL_SERVICE_NAME',
] as const;

interface Posted {
    url: string;
    headers: Record<string, string>;
}

let posts: Posted[];

beforeEach(() => {
    posts = [];
    // Start every case from an unset environment, whatever the host shell exports.
    for (const name of ENV) vi.stubEnv(name, undefined);
    vi.stubGlobal(
        'fetch',
        (url: string, init: { headers: Record<string, string> }) => {
            posts.push({ url, headers: init.headers });
            return Promise.resolve({ ok: true, status: 200 });
        },
    );
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
});

// Build the default exporter with `opts`, ship an empty batch, return the one request it made.
async function post(
    opts: Parameters<typeof otlp.exporter>[0] = {},
): Promise<Posted> {
    await otlp.exporter(opts).export([]);
    expect(posts).toHaveLength(1);
    return posts[0]!;
}

describe('endpoint', () => {
    it('defaults to the local collector', async () => {
        expect((await post()).url).toBe('http://localhost:4318/v1/traces');
    });

    it('OTEL_EXPORTER_OTLP_ENDPOINT is a base URL: /v1/traces is appended', async () => {
        vi.stubEnv(
            'OTEL_EXPORTER_OTLP_ENDPOINT',
            'http://collector.test:4318/',
        );
        expect((await post()).url).toBe('http://collector.test:4318/v1/traces');
    });

    it('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is a full URL, used as-is', async () => {
        vi.stubEnv(
            'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
            'http://traces.test/custom/ingest',
        );
        expect((await post()).url).toBe('http://traces.test/custom/ingest');
    });

    it('the traces-specific URL wins over the generic base URL', async () => {
        vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://generic.test');
        vi.stubEnv(
            'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
            'http://traces.test/v1/spans',
        );
        expect((await post()).url).toBe('http://traces.test/v1/spans');
    });

    it('an explicit endpoint option beats both variables, and stays a base URL', async () => {
        vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://generic.test');
        vi.stubEnv(
            'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
            'http://traces.test/v1/spans',
        );
        expect((await post({ endpoint: 'http://explicit.test/' })).url).toBe(
            'http://explicit.test/v1/traces',
        );
    });

    it('an empty variable is an unset one', async () => {
        vi.stubEnv('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', '');
        vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '');
        expect((await post()).url).toBe('http://localhost:4318/v1/traces');
    });
});

describe('headers', () => {
    it('sends only the content type by default', async () => {
        expect((await post()).headers).toEqual({
            'content-type': 'application/json',
        });
    });

    it('OTEL_EXPORTER_OTLP_HEADERS: key=value pairs, values percent-decoded, split on the first =', async () => {
        vi.stubEnv(
            'OTEL_EXPORTER_OTLP_HEADERS',
            // a decoded space, a value carrying `=` (base64 padding), whitespace around the
            // pair, and an entry with no `=` that is skipped
            'x-team=pay%20ments, authorization = Basic%20dXNlcjpwYXNz== ,orphan',
        );
        expect((await post()).headers).toEqual({
            'content-type': 'application/json',
            'x-team': 'pay ments',
            authorization: 'Basic dXNlcjpwYXNz==',
        });
    });

    it('an explicit header wins over the environment, whatever the case of its name', async () => {
        vi.stubEnv(
            'OTEL_EXPORTER_OTLP_HEADERS',
            'authorization=from-env,x-env-only=1',
        );
        expect(
            (await post({ headers: { Authorization: 'from-option' } })).headers,
        ).toEqual({
            'content-type': 'application/json',
            authorization: 'from-option',
            'x-env-only': '1',
        });
    });

    it('OTEL_EXPORTER_OTLP_TRACES_HEADERS overrides the generic variable per header', async () => {
        vi.stubEnv('OTEL_EXPORTER_OTLP_HEADERS', 'a=generic,b=generic');
        vi.stubEnv('OTEL_EXPORTER_OTLP_TRACES_HEADERS', 'b=traces,c=traces');
        expect((await post()).headers).toEqual({
            'content-type': 'application/json',
            a: 'generic',
            b: 'traces',
            c: 'traces',
        });
    });

    it('a value that fails to decode discards that variable whole, and never throws', async () => {
        vi.stubEnv('OTEL_EXPORTER_OTLP_HEADERS', 'x-ok=1,x-broken=%E0%A4%A');
        expect((await post()).headers).toEqual({
            'content-type': 'application/json',
        });
    });
});

describe('OTEL_RESOURCE_ATTRIBUTES shares the parser', () => {
    // The resource list and the headers list are one grammar, so a raw `=` inside a value must
    // survive here too: it used to be truncated at the second `=`.
    it('keeps a value that contains =', () => {
        vi.stubEnv(
            'OTEL_RESOURCE_ATTRIBUTES',
            'deployment.token=abc==,team=pay',
        );
        const doc = otlp.json([]) as {
            resourceSpans: [
                {
                    resource: {
                        attributes: {
                            key: string;
                            value: { stringValue: string };
                        }[];
                    };
                },
            ];
        };
        const attrs = Object.fromEntries(
            doc.resourceSpans[0].resource.attributes.map((a) => [
                a.key,
                a.value.stringValue,
            ]),
        );
        expect(attrs['deployment.token']).toBe('abc==');
        expect(attrs['team']).toBe('pay');
    });
});

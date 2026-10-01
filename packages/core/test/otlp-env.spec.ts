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
    vi.restoreAllMocks();
});

// The exporter warns once per process, so a case that reads the warning starts it afresh.
const warned = (): { done: boolean } =>
    (globalThis as Record<symbol, { done: boolean }>)[
        Symbol.for('stitchapi.otlp.warned')
    ]!;

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

    it('an entry whose name is empty or only whitespace is skipped (fetch rejects an empty header name)', async () => {
        vi.stubEnv(
            'OTEL_EXPORTER_OTLP_HEADERS',
            // an empty name, a whitespace-only name, an encoded-whitespace name, and one good pair
            '=v1, =v2,%20%20=v3,x-ok=1',
        );
        expect((await post()).headers).toEqual({
            'content-type': 'application/json',
            'x-ok': '1',
        });
    });
});

describe('a send that fails is reported once', () => {
    beforeEach(() => {
        warned().done = false;
    });

    const send = (): Promise<void> =>
        otlp.exporter().export([]) as Promise<void>;

    it('a network error warns once, naming the endpoint and the reason, and never throws', async () => {
        vi.stubEnv(
            'OTEL_EXPORTER_OTLP_ENDPOINT',
            'http://u:hunter2@collector.test',
        );
        const warn = vi
            .spyOn(console, 'warn')
            .mockImplementation(() => undefined);
        vi.stubGlobal('fetch', () =>
            Promise.reject(new TypeError('fetch failed')),
        );

        await expect(send()).resolves.toBeUndefined();
        await expect(send()).resolves.toBeUndefined();

        expect(warn).toHaveBeenCalledTimes(1); // the second failure is not reported
        const message = String(warn.mock.calls[0]![0]);
        expect(message).toContain('collector.test/v1/traces');
        expect(message).toContain('fetch failed');
        expect(message).not.toContain('hunter2'); // userinfo is scrubbed from the endpoint
    });

    it('a refused POST (a non-2xx answer) warns with its status', async () => {
        const warn = vi
            .spyOn(console, 'warn')
            .mockImplementation(() => undefined);
        vi.stubGlobal('fetch', () =>
            Promise.resolve({ ok: false, status: 401 }),
        );

        await send();

        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]![0])).toContain('HTTP 401');
    });

    it('a header fetch refuses is reported rather than silently dropping every batch', async () => {
        const warn = vi
            .spyOn(console, 'warn')
            .mockImplementation(() => undefined);
        vi.stubGlobal('fetch', () => {
            throw new TypeError('invalid header value');
        });

        await send();

        expect(String(warn.mock.calls[0]![0])).toContain(
            'invalid header value',
        );
    });

    it('a throwing custom exporter is reported once too', () => {
        const warn = vi
            .spyOn(console, 'warn')
            .mockImplementation(() => undefined);
        const sink = otlp.sink({
            exporter: {
                export: () => {
                    throw new Error('queue full');
                },
            },
        });
        const run = (name: string): void => {
            for (const event of [
                {
                    type: 'start',
                    name,
                    method: 'GET',
                    url: 'http://x.test/',
                    input: {},
                    at: 1,
                },
                { type: 'done', ok: true, elapsed: 1, attempts: 1, at: 2 },
            ] as const)
                sink.handle(event, { name });
        };

        run('a');
        run('b');

        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]![0])).toContain('queue full');
    });

    it('a successful send says nothing', async () => {
        const warn = vi
            .spyOn(console, 'warn')
            .mockImplementation(() => undefined);

        await send();

        expect(warn).not.toHaveBeenCalled();
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

    const resourceOf = (): Record<string, string> => {
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
        return Object.fromEntries(
            doc.resourceSpans[0].resource.attributes.map((a) => [
                a.key,
                a.value.stringValue,
            ]),
        );
    };

    it('skips an entry whose name is empty or only whitespace', () => {
        vi.stubEnv('OTEL_RESOURCE_ATTRIBUTES', '=v1, =v2,%20=v3,team=pay');
        const attrs = resourceOf();
        expect(attrs['team']).toBe('pay');
        expect(Object.keys(attrs).filter((k) => k.trim() === '')).toEqual([]);
    });

    it('an empty service.name is no name: it falls back to unknown_service', () => {
        vi.stubEnv('OTEL_RESOURCE_ATTRIBUTES', 'service.name=');
        expect(resourceOf()['service.name']).toBe('unknown_service');
    });

    it('an empty OTEL_SERVICE_NAME falls through to the one in OTEL_RESOURCE_ATTRIBUTES', () => {
        vi.stubEnv('OTEL_SERVICE_NAME', '');
        vi.stubEnv('OTEL_RESOURCE_ATTRIBUTES', 'service.name=checkout');
        expect(resourceOf()['service.name']).toBe('checkout');
    });
});

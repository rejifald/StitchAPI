// GOLDEN: the exported OTLP span tree (ADR 0017 D6, issues #871/#872). Dashboards and alerts key on
// span kind, span names and which span carries which attribute, so the tree a stitch exports is a
// contract — these snapshots freeze it. A change here is a dashboard-breaking change: it needs a
// `!` commit and a CHANGELOG migration line, not a snapshot update in passing.
//
// Real stitch calls against the mock server feed `otlp.sink` through the ordinary `trace` tee. Each
// tree is normalized for the snapshot: span ids/timestamps dropped (the invariants they must hold
// are asserted structurally instead), the mock server's random port masked, and the package
// version masked so a release doesn't churn the golden.
import { stitch } from '../src';
import type { Adapter, Surface } from '../src';
import { otlp } from '../src/otlp';
import type { OtelSpan, SpanAttributes, SpanExporter } from '../src/otlp';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

interface Capture {
    exporter: SpanExporter;
    spans: OtelSpan[];
    resources: (SpanAttributes | undefined)[];
}

function capture(): Capture {
    const c: Capture = {
        spans: [],
        resources: [],
        exporter: {
            export(batch, resource) {
                c.spans.push(...batch);
                c.resources.push(resource);
            },
        },
    };
    return c;
}

interface Node {
    name: string;
    kind: OtelSpan['kind'];
    status: OtelSpan['status'];
    attributes: SpanAttributes;
    events?: string[];
    children?: Node[];
}

let server: MockServer;
beforeAll(async () => {
    server = await startMockServer();
});
afterAll(async () => {
    await server.close();
});
beforeEach(() => {
    server.reset();
});

const port = (): number => Number(new URL(server.url).port);

// Mask what varies run to run: the mock server's port (in `url.full` and `server.port`).
function mask(attributes: SpanAttributes): SpanAttributes {
    return Object.fromEntries<SpanAttributes[string]>(
        Object.entries(attributes).map(([k, v]) => [
            k,
            k === 'server.port' && v === port()
                ? '<port>'
                : typeof v === 'string'
                  ? v.replace(`:${port()}/`, ':<port>/')
                  : v,
        ]),
    );
}

// Check the invariants the ids and timestamps must hold, then fold the flat export into a tree.
function tree(spans: OtelSpan[]): Node {
    const roots = spans.filter((s) => s.parentSpanId === undefined);
    expect(roots).toHaveLength(1);
    const root = roots[0]!;
    const ids = new Set(spans.map((s) => s.spanId));
    expect(ids.size).toBe(spans.length); // every span has its own id
    for (const s of spans) {
        expect(s.traceId).toBe(root.traceId); // one trace
        expect(s.spanId).toMatch(/^[0-9a-f]{16}$/);
        expect(s.endUnixMs).toBeGreaterThanOrEqual(s.startUnixMs);
        if (s === root) continue;
        const parent = spans.find((p) => p.spanId === s.parentSpanId);
        expect(parent).toBeDefined(); // every parent is exported in the same batch
        expect(s.startUnixMs).toBeGreaterThanOrEqual(parent!.startUnixMs);
        expect(s.endUnixMs).toBeLessThanOrEqual(parent!.endUnixMs);
    }
    const fold = (s: OtelSpan): Node => {
        const children = spans
            .filter((c) => c.parentSpanId === s.spanId)
            .map(fold);
        return {
            name: s.name,
            kind: s.kind,
            status: s.status,
            attributes: mask(s.attributes),
            ...(s.events.length ? { events: s.events.map((e) => e.name) } : {}),
            ...(children.length ? { children } : {}),
        };
    };
    return fold(root);
}

test('a clean call: an INTERNAL run span over one CLIENT attempt span', async () => {
    const c = capture();
    server.route('GET', '/ping', { body: { ok: true } });
    const ping = stitch({
        name: 'ping',
        baseUrl: server.url,
        path: '/ping',
        trace: otlp.sink({ exporter: c.exporter }),
    });

    await ping();

    expect(tree(c.spans)).toMatchInlineSnapshot(`
      {
        "attributes": {
          "stitch.name": "ping",
          "stitch.surface": "http",
        },
        "children": [
          {
            "attributes": {
              "http.request.method": "GET",
              "http.response.status_code": 200,
              "server.address": "127.0.0.1",
              "server.port": "<port>",
              "stitch.attempt": 1,
              "url.full": "http://127.0.0.1:<port>/ping",
              "url.template": "/ping",
            },
            "kind": "CLIENT",
            "name": "GET /ping",
            "status": {
              "code": "UNSET",
            },
          },
        ],
        "events": [
          "request",
        ],
        "kind": "INTERNAL",
        "name": "ping",
        "status": {
          "code": "UNSET",
        },
      }
    `);
});

// The attempt-span naming rule (#900): `{method} {url.template}` (OTel HTTP client semconv), the
// template being the stitch's unexpanded RFC 6570 PATH template — never the expanded URL, a query,
// a secret or an instance id — and the bare method when none is known. Dashboards group by these
// names, so each shape of config below is a contract; the derivation table is `url-template.spec.ts`.
const attemptOf = (c: Capture): OtelSpan =>
    c.spans.find((s) => s.kind === 'CLIENT')!;

test('a templated path: the attempt is named {method} {template}, url.template the unexpanded path', async () => {
    const c = capture();
    server.route('GET', '/users/42', { body: { id: 42 } });
    const getUser = stitch({
        name: 'getUser',
        baseUrl: server.url,
        path: '/users/{id}',
        trace: otlp.sink({ exporter: c.exporter }),
    });

    await getUser({ params: { id: 42 } });

    expect(tree(c.spans)).toMatchInlineSnapshot(`
      {
        "attributes": {
          "stitch.name": "getUser",
          "stitch.surface": "http",
        },
        "children": [
          {
            "attributes": {
              "http.request.method": "GET",
              "http.response.status_code": 200,
              "server.address": "127.0.0.1",
              "server.port": "<port>",
              "stitch.attempt": 1,
              "url.full": "http://127.0.0.1:<port>/users/42",
              "url.template": "/users/{id}",
            },
            "kind": "CLIENT",
            "name": "GET /users/{id}",
            "status": {
              "code": "UNSET",
            },
          },
        ],
        "events": [
          "request",
        ],
        "kind": "INTERNAL",
        "name": "getUser",
        "status": {
          "code": "UNSET",
        },
      }
    `);
});

test('a templated query segment {?q} never reaches the name or url.template', async () => {
    const c = capture();
    server.route('GET', '/search', { body: [] });
    const search = stitch({
        name: 'search',
        baseUrl: server.url,
        path: '/search{?q}',
        trace: otlp.sink({ exporter: c.exporter }),
    });

    await search({ params: { q: 'needle' } });

    const a = attemptOf(c);
    expect(a.name).toBe('GET /search');
    expect(a.attributes['url.template']).toBe('/search');
    // The query is on the wire (`url.full`), not in the low-cardinality name.
    expect(String(a.attributes['url.full'])).toContain('?q=needle');
    expect(JSON.stringify([a.name, a.attributes['url.template']])).not.toMatch(
        /[?&]|needle/,
    );
});

test('an absolute templated url: scheme, authority and the literal query are stripped', async () => {
    const c = capture();
    server.route('GET', '/orgs/acme/members', { body: [] });
    const members = stitch({
        name: 'members',
        url: `${server.url}/orgs/{org}/members?api_key=hunter2`,
        trace: otlp.sink({ exporter: c.exporter }),
    });

    await members({ params: { org: 'acme' } });

    const a = attemptOf(c);
    expect(a.name).toBe('GET /orgs/{org}/members');
    expect(a.attributes['url.template']).toBe('/orgs/{org}/members');
    // The secret is scrubbed from `url.full` and absent from every name and from the template.
    expect(String(a.attributes['url.full'])).toContain('api_key=REDACTED');
    expect(
        JSON.stringify([
            c.spans.map((s) => s.name),
            a.attributes['url.template'],
        ]),
    ).not.toContain('hunter2');
});

test('a function url has no low-cardinality template: the name falls back to the method', async () => {
    const c = capture();
    server.route('GET', '/dyn/7', { body: {} });
    const dyn = stitch({
        name: 'dyn',
        // Even a function that returns a `{…}` template is computed per call: it names nothing.
        url: () => `${server.url}/dyn/{id}`,
        trace: otlp.sink({ exporter: c.exporter }),
    });

    await dyn({ params: { id: 7 } });

    const a = attemptOf(c);
    expect(a.name).toBe('GET');
    expect(a.attributes).not.toHaveProperty('url.template');
});

test('a function baseUrl leaves the path prefix unknown: the name falls back to the method', async () => {
    const c = capture();
    server.route('GET', '/users/42', { body: {} });
    const getUser = stitch({
        name: 'getUser',
        baseUrl: () => server.url,
        path: '/users/{id}',
        trace: otlp.sink({ exporter: c.exporter }),
    });

    await getUser({ params: { id: 42 } });

    const a = attemptOf(c);
    expect(a.name).toBe('GET');
    expect(a.attributes).not.toHaveProperty('url.template');
});

test('an absolute literal url may embed an id or a secret: the name falls back to the method', async () => {
    const c = capture();
    server.route('GET', '/orgs/acme/hooks/s3cr3t', { body: {} });
    const hook = stitch({
        name: 'hook',
        url: `${server.url}/orgs/acme/hooks/s3cr3t`,
        trace: otlp.sink({ exporter: c.exporter }),
    });

    await hook();

    const a = attemptOf(c);
    expect(a.name).toBe('GET');
    expect(a.attributes).not.toHaveProperty('url.template');
    // The span still says where it went — `url.full` is the scrubbed, high-cardinality field.
    expect(String(a.attributes['url.full'])).toContain('/orgs/acme/hooks/');
});

test('a retried call: one attempt span per request, the resend carrying its count', async () => {
    const c = capture();
    server.route('GET', '/flaky', { statuses: [503, 200], body: { ok: true } });
    const flaky = stitch({
        name: 'flaky',
        baseUrl: server.url,
        path: '/flaky',
        retry: { attempts: 3, on: [503], backoff: { curve: 'fixed', base: 1 } },
        trace: otlp.sink({ exporter: c.exporter }),
    });

    await flaky();

    expect(tree(c.spans)).toMatchInlineSnapshot(`
      {
        "attributes": {
          "stitch.name": "flaky",
          "stitch.surface": "http",
        },
        "children": [
          {
            "attributes": {
              "error.type": "503",
              "http.request.method": "GET",
              "http.response.status_code": 503,
              "server.address": "127.0.0.1",
              "server.port": "<port>",
              "stitch.attempt": 1,
              "url.full": "http://127.0.0.1:<port>/flaky",
              "url.template": "/flaky",
            },
            "kind": "CLIENT",
            "name": "GET /flaky",
            "status": {
              "code": "ERROR",
              "message": "status 503",
            },
          },
          {
            "attributes": {
              "http.request.method": "GET",
              "http.request.resend_count": 1,
              "http.response.status_code": 200,
              "server.address": "127.0.0.1",
              "server.port": "<port>",
              "stitch.attempt": 2,
              "url.full": "http://127.0.0.1:<port>/flaky",
              "url.template": "/flaky",
            },
            "kind": "CLIENT",
            "name": "GET /flaky",
            "status": {
              "code": "UNSET",
            },
          },
        ],
        "events": [
          "request",
          "retry",
          "request",
        ],
        "kind": "INTERNAL",
        "name": "flaky",
        "status": {
          "code": "UNSET",
        },
      }
    `);
});

test('a paginated call: attempts nest under their page, the resend count restarts per page', async () => {
    const c = capture();
    // Page 2's first request draws the 503 and is resent; pages 1 and 3 go through first time.
    server.route('GET', '/list', {
        statuses: [200, 503, 200, 200],
        body: [1, 2],
    });
    const list = stitch({
        name: 'list',
        baseUrl: server.url,
        path: '/list',
        retry: { attempts: 2, on: [503], backoff: { curve: 'fixed', base: 1 } },
        paginate: {
            next: (_body, page) =>
                page < 3 ? { query: { page: page + 1 } } : undefined,
        },
        trace: otlp.sink({ exporter: c.exporter }),
    });

    await list();

    expect(tree(c.spans)).toMatchInlineSnapshot(`
      {
        "attributes": {
          "stitch.name": "list",
          "stitch.surface": "http",
        },
        "children": [
          {
            "attributes": {
              "stitch.page": 1,
            },
            "children": [
              {
                "attributes": {
                  "http.request.method": "GET",
                  "http.response.status_code": 200,
                  "server.address": "127.0.0.1",
                  "server.port": "<port>",
                  "stitch.attempt": 1,
                  "url.full": "http://127.0.0.1:<port>/list",
                  "url.template": "/list",
                },
                "kind": "CLIENT",
                "name": "GET /list",
                "status": {
                  "code": "UNSET",
                },
              },
            ],
            "kind": "INTERNAL",
            "name": "page 1",
            "status": {
              "code": "UNSET",
            },
          },
          {
            "attributes": {
              "stitch.page": 2,
            },
            "children": [
              {
                "attributes": {
                  "error.type": "503",
                  "http.request.method": "GET",
                  "http.response.status_code": 503,
                  "server.address": "127.0.0.1",
                  "server.port": "<port>",
                  "stitch.attempt": 1,
                  "url.full": "http://127.0.0.1:<port>/list",
                  "url.template": "/list",
                },
                "kind": "CLIENT",
                "name": "GET /list",
                "status": {
                  "code": "ERROR",
                  "message": "status 503",
                },
              },
              {
                "attributes": {
                  "http.request.method": "GET",
                  "http.request.resend_count": 1,
                  "http.response.status_code": 200,
                  "server.address": "127.0.0.1",
                  "server.port": "<port>",
                  "stitch.attempt": 2,
                  "url.full": "http://127.0.0.1:<port>/list",
                  "url.template": "/list",
                },
                "kind": "CLIENT",
                "name": "GET /list",
                "status": {
                  "code": "UNSET",
                },
              },
            ],
            "kind": "INTERNAL",
            "name": "page 2",
            "status": {
              "code": "UNSET",
            },
          },
          {
            "attributes": {
              "stitch.page": 3,
            },
            "children": [
              {
                "attributes": {
                  "http.request.method": "GET",
                  "http.response.status_code": 200,
                  "server.address": "127.0.0.1",
                  "server.port": "<port>",
                  "stitch.attempt": 1,
                  "url.full": "http://127.0.0.1:<port>/list",
                  "url.template": "/list",
                },
                "kind": "CLIENT",
                "name": "GET /list",
                "status": {
                  "code": "UNSET",
                },
              },
            ],
            "kind": "INTERNAL",
            "name": "page 3",
            "status": {
              "code": "UNSET",
            },
          },
        ],
        "events": [
          "request",
          "paginate",
          "request",
          "retry",
          "request",
          "paginate",
          "request",
          "paginate",
        ],
        "kind": "INTERNAL",
        "name": "list",
        "status": {
          "code": "UNSET",
        },
      }
    `);
});

test('a failed call: ERROR on the attempt and the run, error.type the status', async () => {
    const c = capture();
    server.route('POST', '/things', { statuses: [500], body: { error: 'x' } });
    const create = stitch({
        name: 'createThing',
        method: 'POST',
        baseUrl: server.url,
        path: '/things',
        trace: otlp.sink({ exporter: c.exporter }),
    });

    await expect(create({ body: { a: 1 } })).rejects.toThrow();

    expect(tree(c.spans)).toMatchInlineSnapshot(`
      {
        "attributes": {
          "error.type": "500",
          "stitch.name": "createThing",
          "stitch.surface": "http",
        },
        "children": [
          {
            "attributes": {
              "error.type": "500",
              "http.request.method": "POST",
              "http.response.status_code": 500,
              "server.address": "127.0.0.1",
              "server.port": "<port>",
              "stitch.attempt": 1,
              "url.full": "http://127.0.0.1:<port>/things",
              "url.template": "/things",
            },
            "kind": "CLIENT",
            "name": "POST /things",
            "status": {
              "code": "ERROR",
              "message": "HTTP 500",
            },
          },
        ],
        "events": [
          "request",
        ],
        "kind": "INTERNAL",
        "name": "createThing",
        "status": {
          "code": "ERROR",
          "message": "HTTP 500",
        },
      }
    `);
});

test('a call that throws: error.type is the error class, no status code', async () => {
    const c = capture();
    server.route('GET', '/slow', { delay: 500, body: { ok: true } });
    const slow = stitch({
        name: 'slow',
        baseUrl: server.url,
        path: '/slow',
        timeout: { each: 20 },
        trace: otlp.sink({ exporter: c.exporter }),
    });

    await expect(slow()).rejects.toThrow();

    expect(tree(c.spans)).toMatchInlineSnapshot(`
      {
        "attributes": {
          "error.type": "TimeoutError",
          "stitch.name": "slow",
          "stitch.surface": "http",
        },
        "children": [
          {
            "attributes": {
              "error.type": "TimeoutError",
              "http.request.method": "GET",
              "server.address": "127.0.0.1",
              "server.port": "<port>",
              "stitch.attempt": 1,
              "url.full": "http://127.0.0.1:<port>/slow",
              "url.template": "/slow",
            },
            "kind": "CLIENT",
            "name": "GET /slow",
            "status": {
              "code": "ERROR",
              "message": "timed out after 20ms",
            },
          },
        ],
        "events": [
          "request",
        ],
        "kind": "INTERNAL",
        "name": "slow",
        "status": {
          "code": "ERROR",
          "message": "timed out after 20ms",
        },
      }
    `);
});

test('a shell-surface call: the attempt is INTERNAL with no http.* attributes', async () => {
    const c = capture();
    // A surface whose `execute` replaces the HTTP transport, shaped like @stitchapi/shell's: a
    // `shell:` pseudo-endpoint, stdout as the body.
    const execute: Adapter = async (req) => ({
        status: 200,
        headers: {},
        body: 'clean',
        url: req.url,
    });
    const shell: Surface = { id: 'shell', execute };
    const gitStatus = stitch({
        name: 'gitStatus',
        url: 'shell:git',
        kind: shell,
        trace: otlp.sink({ exporter: c.exporter }),
    });

    await gitStatus();

    expect(tree(c.spans)).toMatchInlineSnapshot(`
      {
        "attributes": {
          "stitch.name": "gitStatus",
          "stitch.surface": "shell",
        },
        "children": [
          {
            "attributes": {
              "stitch.attempt": 1,
            },
            "kind": "INTERNAL",
            "name": "shell",
            "status": {
              "code": "UNSET",
            },
          },
        ],
        "events": [
          "request",
        ],
        "kind": "INTERNAL",
        "name": "gitStatus",
        "status": {
          "code": "UNSET",
        },
      }
    `);
});

describe('the resource', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    // The scope and resource of one exported batch, with the package version masked.
    async function envelope(
        resource?: SpanAttributes,
    ): Promise<{ batch: unknown; resource: SpanAttributes | undefined }> {
        const c = capture();
        server.route('GET', '/ping', { body: { ok: true } });
        const ping = stitch({
            name: 'ping',
            baseUrl: server.url,
            path: '/ping',
            trace: otlp.sink(
                resource
                    ? { exporter: c.exporter, resource }
                    : { exporter: c.exporter },
            ),
        });
        await ping();
        const doc = otlp.json(c.spans, c.resources[0]) as {
            resourceSpans: {
                resource: unknown;
                schemaUrl: string;
                scopeSpans: { scope: unknown; schemaUrl: string }[];
            }[];
        };
        const rs = doc.resourceSpans[0]!;
        const batch = JSON.parse(
            JSON.stringify({
                resource: rs.resource,
                schemaUrl: rs.schemaUrl,
                scope: rs.scopeSpans[0]!.scope,
                scopeSchemaUrl: rs.scopeSpans[0]!.schemaUrl,
            }).replaceAll(__PKG_VERSION__, '<version>'),
        ) as unknown;
        return { batch, resource: c.resources[0] };
    }

    test('comes from OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES', async () => {
        vi.stubEnv('OTEL_SERVICE_NAME', 'checkout');
        // `service.name` here loses to OTEL_SERVICE_NAME; `,` and `=` inside a value are
        // percent-encoded (OTel resource SDK spec).
        vi.stubEnv(
            'OTEL_RESOURCE_ATTRIBUTES',
            'deployment.environment.name=prod, service.name=ignored,team=pay%2Cments',
        );

        expect((await envelope()).batch).toMatchInlineSnapshot(`
          {
            "resource": {
              "attributes": [
                {
                  "key": "telemetry.sdk.name",
                  "value": {
                    "stringValue": "stitchapi",
                  },
                },
                {
                  "key": "telemetry.sdk.language",
                  "value": {
                    "stringValue": "nodejs",
                  },
                },
                {
                  "key": "telemetry.sdk.version",
                  "value": {
                    "stringValue": "<version>",
                  },
                },
                {
                  "key": "deployment.environment.name",
                  "value": {
                    "stringValue": "prod",
                  },
                },
                {
                  "key": "service.name",
                  "value": {
                    "stringValue": "checkout",
                  },
                },
                {
                  "key": "team",
                  "value": {
                    "stringValue": "pay,ments",
                  },
                },
              ],
            },
            "schemaUrl": "https://opentelemetry.io/schemas/1.44.0",
            "scope": {
              "name": "stitchapi",
              "version": "<version>",
            },
            "scopeSchemaUrl": "https://opentelemetry.io/schemas/1.44.0",
          }
        `);
    });

    test('defaults service.name to unknown_service, and the resource option wins over env', async () => {
        vi.stubEnv('OTEL_SERVICE_NAME', '');
        vi.stubEnv('OTEL_RESOURCE_ATTRIBUTES', 'team=payments');
        expect((await envelope()).resource).toMatchObject({
            'service.name': 'unknown_service',
            team: 'payments',
        });

        vi.stubEnv('OTEL_SERVICE_NAME', 'checkout');
        expect(
            (await envelope({ 'service.name': 'billing', team: 'core' }))
                .resource,
        ).toMatchObject({ 'service.name': 'billing', team: 'core' });
    });

    test('a malformed OTEL_RESOURCE_ATTRIBUTES is discarded whole', async () => {
        vi.stubEnv('OTEL_SERVICE_NAME', '');
        vi.stubEnv('OTEL_RESOURCE_ATTRIBUTES', 'team=payments,broken=%E0%A4%A');
        const { resource } = await envelope();
        expect(resource).not.toHaveProperty('team');
        expect(resource?.['service.name']).toBe('unknown_service');
    });
});

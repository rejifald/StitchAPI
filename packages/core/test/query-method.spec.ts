// QUERY as a first-class method (issue #462 part 1).
//
// QUERY is the safe, idempotent, *cacheable* method that carries a request body
// (draft-ietf-httpbis-safe-method-w-body) — "a GET whose filter is too big or too structured for a
// URL". It worked here by accident: the engine's notion of a safe method was hard-coded to
// GET/HEAD in four places, so a QUERY was treated as a write everywhere except the one branch that
// happened to let its body through.
//
// The three method tests in the transport LOOK alike and ask different questions; this suite pins
// each one separately, because conflating them is exactly how a QUERY loses its body:
//   • `isSafeMethod` — "is this a read?" → no Idempotency-Key, and the construction nudge that
//     mirrors that drop. GET/HEAD/OPTIONS/TRACE/QUERY.
//   • `encodeRequestBody` — "may this method carry a body on the wire?" → GET/HEAD only (a
//     transport constraint: `fetch` throws on a GET with a body). QUERY keeps its body.
//   • `followRedirects` — "does a 301/302 downgrade this to a bodyless GET?" → the historical POST
//     exception, which the draft says explicitly does NOT apply to QUERY. GET/HEAD/QUERY exempt.
//
// Every GET/HEAD/POST assertion below is a regression guard on unchanged behaviour, not new
// behaviour.
import { fetchAdapter, stitch } from '../src';
import { encodeRequestBody } from '../src/http-adapter';
import { mockAdapter } from '../src/testing';
import type { Adapter, AdapterRequest } from '../src/types';
import { isSafeMethod } from '../src/util';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Keep this suite's trace sink out of the console (matches the other transport specs).
process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-query-method-${process.pid}.jsonl`,
);

const req = (over: Partial<AdapterRequest> = {}): AdapterRequest => ({
    url: 'https://api.test/search',
    method: 'QUERY',
    headers: {},
    ...over,
});

// Pull a header case-insensitively from a recorded request.
const hdr = (h: Record<string, string>, name: string): string | undefined => {
    const k = Object.keys(h).find(
        (x) => x.toLowerCase() === name.toLowerCase(),
    );
    return k ? h[k] : undefined;
};

// A scripted fetch that answers a redirect chain and records the method/body/url of every hop, so
// a test can assert what the redirect TARGET was actually sent. Typed as `typeof fetch` (the arrow
// is structurally assignable, so no cast is needed).
function redirectingFetch(steps: { status: number; location?: string }[]): {
    fetch: typeof fetch;
    hops: { url: string; method: string; body: unknown }[];
} {
    const hops: { url: string; method: string; body: unknown }[] = [];
    let i = 0;
    const fetch: typeof globalThis.fetch = (input, init) => {
        hops.push({
            url: input as string,
            method: init?.method ?? 'GET',
            body: init?.body,
        });
        const step = steps[Math.min(i, steps.length - 1)];
        i++;
        const headers = new Headers();
        if (step?.location) headers.set('location', step.location);
        const redirecting =
            step !== undefined && step.status >= 300 && step.status < 400;
        if (!redirecting) headers.set('content-type', 'application/json');
        return Promise.resolve(
            new Response(redirecting ? null : '{"ok":true}', {
                status: step?.status ?? 200,
                headers,
            }),
        );
    };
    return { fetch, hops };
}

describe('isSafeMethod — one predicate for "is this a read?"', () => {
    test('RFC 9110 §9.2.1 safe set, plus QUERY', () => {
        for (const m of ['GET', 'HEAD', 'OPTIONS', 'TRACE', 'QUERY'])
            expect(isSafeMethod(m)).toBe(true);
        // Case-insensitive: `cfg.method` is uppercased by the engine, but the helper is also
        // reachable from an adapter, where the method is whatever the caller wrote.
        expect(isSafeMethod('query')).toBe(true);
    });

    test('writes, and an unknown verb, are not safe (fail closed)', () => {
        for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'PURGE', ''])
            expect(isSafeMethod(m)).toBe(false);
    });
});

describe('encodeRequestBody — a QUERY keeps its body', () => {
    test('the body survives, JSON-encoded, with a content-type', () => {
        const out = encodeRequestBody(
            req({ body: { filter: { tags: ['a', 'b'] } } }),
        );
        expect(out.body).toBe('{"filter":{"tags":["a","b"]}}');
        expect(out.contentType).toBe('application/json');
    });

    test('a QUERY form/multipart body encodes like any other body-bearing method', () => {
        expect(
            encodeRequestBody(req({ body: { a: 1, b: 2 }, bodyType: 'form' }))
                .body,
        ).toBe('a=1&b=2');
        expect(
            encodeRequestBody(req({ body: { f: 'v' }, bodyType: 'multipart' }))
                .body,
        ).toBeInstanceOf(FormData);
    });

    test('GET/HEAD still drop a body — the transport, not safety, is what decides here', () => {
        expect(
            encodeRequestBody(req({ method: 'GET', body: { a: 1 } })).body,
        ).toBeUndefined();
        expect(
            encodeRequestBody(req({ method: 'HEAD', body: { a: 1 } })).body,
        ).toBeUndefined();
        // OPTIONS is safe too, and is NOT body-stripped — proof this branch is not `isSafeMethod`.
        expect(
            encodeRequestBody(req({ method: 'OPTIONS', body: { a: 1 } })).body,
        ).toBe('{"a":1}');
    });
});

describe('idempotency — a safe method is never stamped with a key', () => {
    // Drive the engine through the published mock transport and read the request it built.
    const sent = async (method: string): Promise<AdapterRequest> => {
        const api = mockAdapter({ respond: { body: { ok: true } } });
        const s = stitch({
            method,
            url: 'https://api.test/search',
            adapter: api,
            trace: false,
            idempotency: { warn: false }, // the nudge is asserted separately, below
        });
        await s({ body: { q: 'ada' } });
        return api.lastRequest() as AdapterRequest;
    };

    test('a QUERY gets no Idempotency-Key — and still sends its body', async () => {
        const r = await sent('QUERY');
        expect(r.method).toBe('QUERY');
        expect(hdr(r.headers, 'idempotency-key')).toBeUndefined();
        expect(r.body).toEqual({ q: 'ada' });
    });

    test('GET/HEAD are unchanged, and OPTIONS/TRACE now classify as the reads they are', async () => {
        for (const m of ['GET', 'HEAD', 'OPTIONS', 'TRACE'])
            expect(hdr((await sent(m)).headers, 'idempotency-key')).toBe(
                undefined,
            );
    });

    test('a write still gets one — POST/PUT/PATCH/DELETE are untouched', async () => {
        for (const m of ['POST', 'PUT', 'PATCH', 'DELETE'])
            expect(
                hdr((await sent(m)).headers, 'idempotency-key'),
            ).toBeTruthy();
    });

    test('a caller-supplied key still wins on a write, and is not invented on a QUERY', async () => {
        const api = mockAdapter({ respond: { body: { ok: true } } });
        const make = (method: string): ReturnType<typeof stitch> =>
            stitch({
                method,
                url: 'https://api.test/search',
                adapter: api,
                trace: false,
                idempotency: { warn: false },
            });
        await make('POST')({ headers: { 'Idempotency-Key': 'mine' } });
        expect(hdr(api.lastRequest()!.headers, 'idempotency-key')).toBe('mine');
        await make('QUERY')({ headers: { 'Idempotency-Key': 'mine' } });
        expect(hdr(api.lastRequest()!.headers, 'idempotency-key')).toBe('mine');
    });
});

describe('the construction nudge tracks the drop it warns about', () => {
    const nudgeFor = (method: string): string | undefined => {
        const warn = vi
            .spyOn(console, 'warn')
            .mockImplementation(() => undefined);
        try {
            stitch({
                method,
                url: 'https://api.test/search',
                trace: false,
                idempotency: true,
            });
            return warn.mock.calls[0]?.[0] as string | undefined;
        } finally {
            warn.mockRestore();
        }
    };

    test('a QUERY with `idempotency` is nudged, exactly as a GET is', () => {
        // Without this the key would be silently dropped with nothing said — the failure mode the
        // nudge exists to prevent, reintroduced by the engine-side fix.
        const msg = nudgeFor('QUERY');
        expect(msg).toContain('writes only');
        expect(msg).toContain('QUERY');
        expect(nudgeFor('GET')).toContain('writes only'); // unchanged
    });

    test('a write is not nudged for being a read (it has a `retry`, so no second nudge either)', () => {
        const warn = vi
            .spyOn(console, 'warn')
            .mockImplementation(() => undefined);
        try {
            stitch({
                method: 'POST',
                url: 'https://api.test/search',
                trace: false,
                retry: { attempts: 2 },
                idempotency: true,
            });
            expect(warn).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });
});

describe('redirects — a 301/302 does not downgrade a QUERY', () => {
    test('a 301 re-sends the QUERY, body intact, to the new target', async () => {
        const { fetch: spy, hops } = redirectingFetch([
            { status: 301, location: 'https://api.test/v2/search' },
            { status: 200 },
        ]);
        await fetchAdapter({ fetch: spy })({
            url: 'https://api.test/search',
            method: 'QUERY',
            headers: {},
            body: { q: 'ada' },
        });
        expect(hops).toHaveLength(2);
        expect(hops[1]?.url).toBe('https://api.test/v2/search');
        expect(hops[1]?.method).toBe('QUERY');
        expect(hops[1]?.body).toBe('{"q":"ada"}');
    });

    test('a 302 likewise — while a POST is still downgraded to a bodyless GET', async () => {
        const script = [
            { status: 302, location: 'https://api.test/moved' },
            { status: 200 },
        ];
        const q = redirectingFetch(script);
        await fetchAdapter({ fetch: q.fetch })({
            url: 'https://api.test/search',
            method: 'QUERY',
            headers: {},
            body: { q: 'ada' },
        });
        expect(q.hops[1]?.method).toBe('QUERY');

        const p = redirectingFetch(script);
        await fetchAdapter({ fetch: p.fetch })({
            url: 'https://api.test/search',
            method: 'POST',
            headers: {},
            body: { q: 'ada' },
        });
        expect(p.hops[1]?.method).toBe('GET'); // the historical POST exception, unchanged
        expect(p.hops[1]?.body).toBeUndefined();
    });

    test('a 303 still means "GET the result over there", for a QUERY too', async () => {
        const { fetch: spy, hops } = redirectingFetch([
            { status: 303, location: 'https://api.test/results/7' },
            { status: 200 },
        ]);
        await fetchAdapter({ fetch: spy })({
            url: 'https://api.test/search',
            method: 'QUERY',
            headers: {},
            body: { q: 'ada' },
        });
        expect(hops[1]?.method).toBe('GET');
        expect(hops[1]?.body).toBeUndefined();
    });

    test('a 307 keeps method and body, as it always did', async () => {
        const { fetch: spy, hops } = redirectingFetch([
            { status: 307, location: 'https://api.test/v2/search' },
            { status: 200 },
        ]);
        await fetchAdapter({ fetch: spy })({
            url: 'https://api.test/search',
            method: 'QUERY',
            headers: {},
            body: { q: 'ada' },
        });
        expect(hops[1]?.method).toBe('QUERY');
        expect(hops[1]?.body).toBe('{"q":"ada"}');
    });
});

describe('cache — QUERY is opt-in, and keys on the request body', () => {
    // Counts origin calls so "served from cache" is observable as "the origin was not called".
    const counting = (): { adapter: Adapter; calls: () => number } => {
        let calls = 0;
        const adapter: Adapter = (r) =>
            Promise.resolve({
                status: 200,
                headers: {},
                body: { n: (calls += 1), echo: r.body },
            });
        return { adapter, calls: () => calls };
    };

    test('`methods: "QUERY"` caches; two different bodies do not collide', async () => {
        const { adapter, calls } = counting();
        const search = stitch({
            method: 'QUERY',
            url: 'https://api.test/search',
            adapter,
            trace: false,
            cache: { ttl: '60s', tenancy: 'app', methods: 'QUERY' },
        });
        expect(await search({ body: { q: 'ada' } })).toEqual({
            n: 1,
            echo: { q: 'ada' },
        });
        expect(await search({ body: { q: 'ada' } })).toEqual({
            n: 1,
            echo: { q: 'ada' },
        }); // hit
        expect(calls()).toBe(1);
        // A different body is a different query — it must MISS, not be served the first answer.
        expect(await search({ body: { q: 'grace' } })).toEqual({
            n: 2,
            echo: { q: 'grace' },
        });
        expect(calls()).toBe(2);
    });

    test('the default `[GET, HEAD]` still does not cache a QUERY (opt-in, unchanged)', async () => {
        const { adapter, calls } = counting();
        const search = stitch({
            method: 'QUERY',
            url: 'https://api.test/search',
            adapter,
            trace: false,
            cache: { ttl: '60s', tenancy: 'app' },
        });
        await search({ body: { q: 'ada' } });
        await search({ body: { q: 'ada' } });
        expect(calls()).toBe(2);
    });
});

describe('end to end, over a real socket', () => {
    let server: MockServer;
    beforeAll(async () => {
        server = await startMockServer();
    });
    afterAll(async () => {
        await server.close();
    });

    test('a QUERY stitch sends its body and no Idempotency-Key', async () => {
        server.route('QUERY', '/search', { body: { hits: 2 } });
        const search = stitch({
            method: 'QUERY',
            baseUrl: server.url,
            path: '/search',
            trace: false,
            idempotency: { warn: false },
        });
        expect(await search({ body: { filter: { tag: 'ada' } } })).toEqual({
            hits: 2,
        });
        const call = server.calls('/search')[0]!;
        expect(call.method).toBe('QUERY');
        expect(call.body).toEqual({ filter: { tag: 'ada' } });
        expect(call.headers['content-type']).toBe('application/json');
        expect(call.headers['idempotency-key']).toBeUndefined();
    });
});

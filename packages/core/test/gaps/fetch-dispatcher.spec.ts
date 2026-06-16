// Pins issue #148: fetchAdapter must thread a per-stitch undici dispatcher (and an optional
// fetch override) into the request init, WITHOUT importing undici — the runtime is zero-deps.
// A sentinel object stands in for an undici Agent; we only assert it is passed through verbatim.
import { fetchAdapter } from '../../src';
import type { AdapterRequest } from '../../src/types';

// A typed view of the init the adapter hands to fetch, including the non-standard
// `dispatcher` key undici's fetch honors (absent from the standard RequestInit type).
type CapturedInit = RequestInit & { dispatcher?: unknown };

// A fetch spy: records the (url, init) of every call and returns a fixed, minimal Response so
// the adapter's downstream parsing has something well-formed to read. Typed as `typeof fetch`
// directly — the arrow is structurally assignable, so no cast is needed.
function makeFetchSpy(): {
    fetch: typeof fetch;
    calls: { url: unknown; init: CapturedInit | undefined }[];
} {
    const calls: { url: unknown; init: CapturedInit | undefined }[] = [];
    const fetch: typeof globalThis.fetch = (input, init) => {
        calls.push({ url: input, init });
        return Promise.resolve(
            new Response('{"ok":true}', {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        );
    };
    return { fetch, calls };
}

const req: AdapterRequest = {
    url: 'https://api.example.com/widgets',
    method: 'GET',
    headers: {},
};

test('fetchAdapter({ dispatcher }) passes the dispatcher straight through to fetch init', async () => {
    const { fetch: spy, calls } = makeFetchSpy();
    // A sentinel — a real undici Agent is unnecessary; identity is all we assert.
    const dispatcher = { __agent: 'sentinel' };

    await fetchAdapter({ fetch: spy, dispatcher })(req);

    expect(calls).toHaveLength(1);
    // The exact object must arrive on init.dispatcher, by reference.
    expect(calls[0]?.init?.dispatcher).toBe(dispatcher);
});

test('fetchAdapter() with no options emits no `dispatcher` key (identical to before)', async () => {
    const { fetch: spy, calls } = makeFetchSpy();

    // The fetch override is still needed to capture the init; dispatcher is intentionally unset.
    await fetchAdapter({ fetch: spy })(req);

    expect(calls).toHaveLength(1);
    const init = calls[0]?.init ?? {};
    // Not merely undefined — the key must be absent so behavior matches plain fetch exactly.
    expect('dispatcher' in init).toBe(false);
});

test('fetchAdapter({ fetch }) routes the request through the injected fetch', async () => {
    const { fetch: spy, calls } = makeFetchSpy();

    const res = await fetchAdapter({ fetch: spy })(req);

    // The spy — not the global fetch — saw the request, and its Response flowed back through.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(req.url);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
});

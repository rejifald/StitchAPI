// Idempotency keys: on a write, the stitch injects an Idempotency-Key header that is STABLE
// for one logical call — the same value rides every retry of that call — so a server can
// dedupe a retried write. A custom key function derives a deterministic key from the input.
import { graphql, stitch } from '../src';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-idempotency-${process.pid}.jsonl`,
);

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

test('injects a stable Idempotency-Key on a write, unchanged across a retry', async () => {
    server.route('POST', '/create', {
        statuses: [503, 200],
        body: { ok: true },
    });
    const create = stitch({
        method: 'POST',
        baseUrl: server.url,
        path: '/create',
        retry: { attempts: 2, on: [503], baseMs: 5 },
        idempotency: true, // default header + random per-call key
    });

    await expect(create({ body: { x: 1 } })).resolves.toEqual({ ok: true });

    const calls = server.calls('/create');
    expect(calls.length).toBe(2); // 503 then 200
    const key = calls[0]!.headers['idempotency-key'];
    expect(key).toBeTruthy();
    expect(calls[1]!.headers['idempotency-key']).toBe(key); // identical across the retry
});

test('uses a custom keyOf function derived from the input', async () => {
    server.route('POST', '/orders', {
        statuses: [503, 200],
        body: { ok: true },
    });
    const create = stitch({
        method: 'POST',
        baseUrl: server.url,
        path: '/orders',
        retry: { attempts: 2, on: [503], baseMs: 5 },
        idempotency: {
            header: 'X-Idempotency-Key',
            keyOf: (input) => `order-${(input.body as { id: number }).id}`,
        },
    });

    await create({ body: { id: 42 } });

    const calls = server.calls('/orders');
    expect(calls[0]!.headers['x-idempotency-key']).toBe('order-42');
    expect(calls[1]!.headers['x-idempotency-key']).toBe('order-42'); // stable + deterministic
});

test('the @deprecated `key` alias still derives the same idempotency key (P6)', async () => {
    server.route('POST', '/orders', { body: { ok: true } });
    const create = stitch({
        method: 'POST',
        baseUrl: server.url,
        path: '/orders',
        idempotency: {
            header: 'X-Idempotency-Key',
            // The pre-rename spelling — must behave identically to `keyOf` until the GA cut.
            key: (input) => `order-${(input.body as { id: number }).id}`,
        },
    });

    await create({ body: { id: 7 } });

    expect(server.calls('/orders')[0]!.headers['x-idempotency-key']).toBe(
        'order-7',
    );
});

test('separate logical calls get distinct generated keys', async () => {
    server.route('POST', '/c', { body: { ok: true } });
    const create = stitch({
        method: 'POST',
        baseUrl: server.url,
        path: '/c',
        idempotency: { warn: false }, // random key, no retry by design — silence the nudge
    });

    await create({ body: {} });
    await create({ body: {} });

    const calls = server.calls('/c');
    expect(calls[0]!.headers['idempotency-key']).not.toBe(
        calls[1]!.headers['idempotency-key'],
    );
});

test('nudges when a write pairs the random default key with no retry', () => {
    // A random key only dedupes a replay of the same request, and `retry` is what replays it. On a
    // write with no retry it usually has nothing to collapse, so the engine nudges at construction.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
        stitch({
            method: 'POST',
            baseUrl: server.url,
            path: '/no-retry',
            idempotency: true,
        });
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]![0]).toContain('idempotency');
        expect(warn.mock.calls[0]![0]).toContain('retry');
    } finally {
        warn.mockRestore();
    }
});

test('nudges when idempotency is set on a read — the key is dropped, almost always a missing method', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
        // no method → GET; the engine drops the key on reads, so the author's write protection
        // silently isn't there. Point at the missing `method`.
        stitch({ baseUrl: server.url, path: '/read-idem', idempotency: true });
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]![0]).toContain('writes only');
        expect(warn.mock.calls[0]![0]).toContain('method');
    } finally {
        warn.mockRestore();
    }
});

test('the nudge is a hint with an out — silenced, and never fired for the cases that earn the key', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
        // `warn: false` opts out of both nudges (e.g. relying on a proxy/transport to dedupe, or
        // an idempotency block shared on a seam that also feeds reads).
        stitch({
            method: 'POST',
            baseUrl: server.url,
            path: '/silenced',
            idempotency: { warn: false },
        });
        stitch({
            baseUrl: server.url,
            path: '/read-silenced',
            idempotency: { warn: false },
        });
        // a retry exercises the key — no nudge.
        stitch({
            method: 'POST',
            baseUrl: server.url,
            path: '/with-retry',
            retry: { attempts: 2 },
            idempotency: true,
        });
        // a derived key dedupes submissions without a retry — useful on its own, no nudge.
        stitch({
            method: 'POST',
            baseUrl: server.url,
            path: '/derived',
            idempotency: {
                keyOf: (input) => `k-${(input.body as { id: number }).id}`,
            },
        });
        // a surface (graphql → POST) owns its method; we don't guess at construction, so no nudge
        // even though `method` is unset here.
        graphql({
            baseUrl: server.url,
            document: '{ me { id } }',
            idempotency: true,
        });
        expect(warn).not.toHaveBeenCalled();
    } finally {
        warn.mockRestore();
    }
});

test('does not inject on GET (writes only)', async () => {
    server.route('GET', '/read', { body: { ok: true } });
    const read = stitch({
        baseUrl: server.url,
        path: '/read',
        idempotency: { warn: false }, // idempotency-on-read nudge is asserted elsewhere; silence here
    });

    await read();
    expect(
        server.calls('/read')[0]!.headers['idempotency-key'],
    ).toBeUndefined();
});

test('a child `idempotency: false` disables idempotency inherited from a base fragment (P20)', async () => {
    server.route('POST', '/no-idem', { body: { ok: true } });
    const base = {
        idempotency: true,
        method: 'POST',
        path: '/no-idem',
    } as const;
    const create = stitch({
        extends: [base],
        baseUrl: server.url,
        idempotency: false, // last writer wins: this turns it OFF
    });

    // The resolved public config must report idempotency OFF, not the inherited `{}` (ON).
    expect(
        (create as { __config: { idempotency?: unknown } }).__config
            .idempotency,
    ).toBeUndefined();

    // …and end-to-end, no Idempotency-Key header is injected on the write.
    await expect(create({ body: { x: 1 } })).resolves.toEqual({ ok: true });
    expect(
        server.calls('/no-idem')[0]!.headers['idempotency-key'],
    ).toBeUndefined();
});

test('a child `idempotency: false` also clears an inherited idempotency *object* (P20)', () => {
    const base = {
        idempotency: { header: 'X-Idem' },
        method: 'POST',
        path: '/x',
    } as const;
    const create = stitch({
        extends: [base],
        baseUrl: 'https://x',
        idempotency: false,
    });
    expect(
        (create as { __config: { idempotency?: unknown } }).__config
            .idempotency,
    ).toBeUndefined();
});

test('a child `idempotency: true` still re-enables it over an inherited `false` (last writer, both directions)', () => {
    const base = { idempotency: false, method: 'POST', path: '/x' } as const;
    const create = stitch({
        extends: [base],
        baseUrl: 'https://x',
        idempotency: true,
    });
    // `true` normalizes to the all-defaults object form the engine reads.
    expect(
        (create as { __config: { idempotency?: unknown } }).__config
            .idempotency,
    ).toEqual({});
});

test('the opaque `idempotency: {}` is a type error — use `true` for defaults (P20)', () => {
    const enableWithDefaults = () =>
        stitch({
            method: 'POST',
            baseUrl: 'https://x',
            path: '/y',
            // @ts-expect-error — the empty object is rejected at the slot; `true` is the all-defaults form.
            idempotency: {},
        });
    // The assertion that matters is the @ts-expect-error above (checked by `check:types`); the
    // closure is never invoked, so this only pins the compile-time contract.
    expect(typeof enableWithDefaults).toBe('function');
});

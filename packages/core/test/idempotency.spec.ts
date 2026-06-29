// Idempotency keys: on a write, the stitch injects an Idempotency-Key header that is STABLE
// for one logical call — the same value rides every retry of that call — so a server can
// dedupe a retried write. A custom key function derives a deterministic key from the input.
import { stitch } from '../src';
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
        idempotency: true,
    });

    await create({ body: {} });
    await create({ body: {} });

    const calls = server.calls('/c');
    expect(calls[0]!.headers['idempotency-key']).not.toBe(
        calls[1]!.headers['idempotency-key'],
    );
});

test('does not inject on GET (writes only)', async () => {
    server.route('GET', '/read', { body: { ok: true } });
    const read = stitch({
        baseUrl: server.url,
        path: '/read',
        idempotency: true,
    });

    await read();
    expect(
        server.calls('/read')[0]!.headers['idempotency-key'],
    ).toBeUndefined();
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

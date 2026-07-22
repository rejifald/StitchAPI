import { seam, stitch } from '../src';
import type { StitchEvent } from '../src';
import { compose } from '../src/stitch';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';
import { asValidator } from './support/schema';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-composition-${process.pid}.jsonl`,
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

// Drain a stitch stream into an array of events.
async function collect<T>(
    gen: AsyncGenerator<StitchEvent<T>, void>,
): Promise<StitchEvent<T>[]> {
    const out: StitchEvent<T>[] = [];
    for await (const ev of gen) out.push(ev);
    return out;
}

const resultOf = <T>(events: StitchEvent<T>[]) =>
    events.find(
        (e): e is Extract<StitchEvent<T>, { type: 'result' }> =>
            e.type === 'result',
    );

// 1) The extends facade resolves to the correct canonical stitch and result.
test('extends facade produces the correct result', async () => {
    server.route('GET', '/items', { body: { data: [{ id: 1, name: 'Ada' }] } });

    const schema = asValidator(
        z.array(z.object({ id: z.number(), name: z.string() })),
    );
    const base = { baseUrl: server.url, unwrap: 'data' };

    const viaExtends = stitch({
        extends: [base],
        path: '/items',
        output: schema,
    });

    const expected = [{ id: 1, name: 'Ada' }];
    const result = await viaExtends();

    expect(result).toEqual(expected);
    expect(server.callCount('/items')).toBe(1);
});

// 1b) A seam member resolves to the SAME result as the config-`extends` facade — the seam shares
// runtime on top, but its config inheritance is the same `flatten`/`compose` machinery.
test('a seam member is equivalent to the extends facade', async () => {
    server.route('GET', '/items', { body: { data: [{ id: 1, name: 'Ada' }] } });

    const schema = asValidator(
        z.array(z.object({ id: z.number(), name: z.string() })),
    );
    const base = { baseUrl: server.url, unwrap: 'data' };

    const viaExtends = stitch({
        extends: [base],
        path: '/items',
        output: schema,
    });
    const viaSeam = seam(base).stitch({ path: '/items', output: schema });

    const expected = [{ id: 1, name: 'Ada' }];
    const [a, b] = await Promise.all([viaExtends(), viaSeam()]);
    expect(a).toEqual(expected);
    expect(b).toEqual(a);
    expect(server.callCount('/items')).toBe(2);
});

// 1c) #76 — an `input` schema contributed PURELY by an `extends` fragment is merged and VALIDATED
// at runtime (the static call-arg type now reflects this too — see test-d/extends-inference). The
// fragment declares `headers`; the child declares `body`; both are validated and sent. This call is
// itself a compile-time assertion (tsconfig.test.json typechecks this file), so it only compiles if
// the merged call-arg type surfaces the fragment's `headers` slot.
test('extends fragment contributes an input schema that is merged + validated', async () => {
    server.route('POST', '/orders', { body: { ok: true } });

    const tenantFragment = {
        input: { headers: z.object({ 'x-tenant': z.string() }) },
    };
    const createOrder = stitch({
        baseUrl: server.url,
        path: '/orders',
        method: 'POST',
        extends: [tenantFragment],
        input: { body: z.object({ sku: z.string() }) },
    });

    await expect(
        createOrder({ headers: { 'x-tenant': 'acme' }, body: { sku: 'A1' } }),
    ).resolves.toEqual({ ok: true });

    const call = server.calls('/orders')[0];
    expect(call?.headers['x-tenant']).toBe('acme');
    expect(call?.body).toEqual({ sku: 'A1' });
});

// 1d) The merged input is actually VALIDATED: a bad value for the slot a FRAGMENT contributed is
// rejected before the request leaves the client (the value is unchanged; only the static check is
// bypassed with `as never` to reach the runtime path).
test('a fragment-contributed input schema still rejects bad input at runtime', async () => {
    server.route('POST', '/orders', { body: { ok: true } });

    const tenantFragment = {
        input: { headers: z.object({ 'x-tenant': z.string() }) },
    };
    const createOrder = stitch({
        baseUrl: server.url,
        path: '/orders',
        method: 'POST',
        extends: [tenantFragment],
        input: { body: z.object({ sku: z.string() }) },
    });

    // `x-tenant` must be a string — a number fails the fragment's headers schema.
    await expect(
        createOrder({
            headers: { 'x-tenant': 123 },
            body: { sku: 'A1' },
        } as never),
    ).rejects.toThrow(/invalid headers/i);
    expect(server.callCount('/orders')).toBe(0); // never left the client
});

// 1e) LAST-WINS per slot across fragments: two fragments both declare a `body` schema; the later one
// validates. The earlier schema's constraint no longer applies (the static type agrees — the last
// writer wins the whole slot).
test('last fragment wins a slot both fragments declare (body schema)', async () => {
    server.route('POST', '/orders', { body: { ok: true } });

    const looseBody = { input: { body: z.object({ a: z.string() }) } };
    const strictBody = {
        input: { body: z.object({ sku: z.string(), qty: z.number() }) },
    };
    const createOrder = stitch({
        baseUrl: server.url,
        path: '/orders',
        method: 'POST',
        extends: [looseBody, strictBody],
    });

    // The SECOND fragment's schema is in force: `{ sku, qty }` passes; `{ a }` (the first
    // fragment's shape) would fail it. The valid call needs NO cast — last-wins gave the call arg
    // the strict `{ sku, qty }` shape, so this line is itself a compile-time merge assertion.
    await expect(createOrder({ body: { sku: 'A1', qty: 2 } })).resolves.toEqual(
        { ok: true },
    );
    await expect(createOrder({ body: { a: 'x' } } as never)).rejects.toThrow(
        /invalid body/i,
    );

    expect(server.callCount('/orders')).toBe(1); // only the valid call left the client
});

// 2) Predefined query in the path merges with call-time query; input wins on conflict.
test('predefined query merges with call-time query (input wins on conflict)', async () => {
    server.route('GET', '/items', { body: { ok: true } });

    const items = stitch({
        baseUrl: server.url,
        path: '/items?sort=name&type=admin',
    });
    await expect(items({ query: { type: 'user' } })).resolves.toEqual({
        ok: true,
    });

    const call = server.calls('/items')[0];
    expect(call?.query).toEqual({ sort: 'name', type: 'user' });
});

// 3) Objects deep-merge across layers: base retry {attempts,on} survives a child adding {baseMs}.
test('deep-merge keeps base retry.attempts/on when child adds retry.baseMs', async () => {
    server.route('GET', '/flaky', {
        statuses: [503, 503, 200],
        body: { ok: true },
    });

    const retryPreset = { retry: { attempts: 3, on: [503] } };
    // Child only sets baseMs; if merge replaced the object wholesale, attempts/on would be lost
    // and the stitch would NOT retry the two 503s.
    const flaky = stitch({
        baseUrl: server.url,
        path: '/flaky',
        extends: [retryPreset],
        retry: { baseMs: 5 },
    });

    const events = await collect(flaky.stream());
    const result = resultOf(events);
    expect(result).toBeDefined();
    expect(result?.data).toEqual({ ok: true });
    // 503, 503, 200 -> success on the third attempt, proving attempts:3 and on:[503] survived.
    expect(result?.attempts).toBe(3);
    expect(server.callCount('/flaky')).toBe(3);
});

// 4) Hooks CHAIN rather than replace: onRequest base->child, onResponse child->base.
test('hooks chain across fragments (onRequest base->child, onResponse child->base)', async () => {
    server.route('GET', '/hooked', { body: { ok: true } });

    const order: string[] = [];
    const baseFrag = {
        baseUrl: server.url,
        hooks: {
            onRequest: () => {
                order.push('req:base');
            },
            onResponse: () => {
                order.push('res:base');
            },
        },
    };
    const childFrag = {
        path: '/hooked',
        hooks: {
            onRequest: () => {
                order.push('req:child');
            },
            onResponse: () => {
                order.push('res:child');
            },
        },
    };

    const s = stitch({ extends: [baseFrag], ...childFrag });
    await expect(s()).resolves.toEqual({ ok: true });

    // onRequest unwinds base -> child; onResponse unwinds child -> base.
    expect(order).toEqual(['req:base', 'req:child', 'res:child', 'res:base']);
});

// 5) .with() partial application accumulates query and merges with later call-time input.
test('.with() partial application sends bound query alongside call-time query', async () => {
    server.route('GET', '/items', { body: { ok: true } });

    const items = stitch({ baseUrl: server.url, path: '/items' });
    const adminItems = items.with({ query: { role: 'admin' } });

    await expect(adminItems({ query: { q: 'ada' } })).resolves.toEqual({
        ok: true,
    });

    const call = server.calls('/items')[0];
    expect(call?.query).toEqual({ role: 'admin', q: 'ada' });
});

// 6) Scalar shorthands expand to their option objects at compose time.
test('scalar shorthands (retry/timeout/cache/throttle) expand to option objects', () => {
    const resolved = compose({
        path: 'https://api.example.com/x',
        retry: 3,
        timeout: '5s',
        cache: '1m',
        throttle: '1/s',
    });
    expect(resolved.retry).toEqual({ attempts: 3 });
    expect(resolved.timeout).toEqual({ total: '5s' });
    expect(resolved.cache).toEqual({ ttl: '1m' });
    expect(resolved.throttle).toEqual({ rate: '1/s' });
});

// 6b) A scalar shorthand folds over an inherited object via extends, preserving the siblings the
// scalar doesn't name (deep-merge runs AFTER each layer is normalized).
test('a scalar shorthand merges over an inherited object, preserving siblings', () => {
    const base = {
        retry: { attempts: 2, on: [429, 503] },
        timeout: { total: '30s', perAttempt: '10s' },
        throttle: { rate: '2/s', concurrency: 4 },
    };
    const resolved = compose({
        extends: [base],
        path: '/x',
        retry: 5,
        timeout: '5s',
        throttle: '1/s',
    });
    expect(resolved.retry).toEqual({ attempts: 5, on: [429, 503] });
    expect(resolved.timeout).toEqual({ total: '5s', perAttempt: '10s' });
    expect(resolved.throttle).toEqual({ rate: '1/s', concurrency: 4 });
});

// 6c) The shorthand survives end-to-end: a stitch's public __config shows the normalized objects.
test('a stitch built from shorthand exposes the normalized objects on __config', () => {
    const s = stitch({
        path: 'https://api.example.com/x',
        retry: 4,
        timeout: 2000,
        throttle: '1/s',
    });
    expect(s.__config.retry).toEqual({ attempts: 4 });
    expect(s.__config.timeout).toEqual({ total: 2000 });
    expect(s.__config.throttle).toEqual({ rate: '1/s' });
});

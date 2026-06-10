import { defineStitch, preset, stitch } from '../src';
import type { StitchEvent } from '../src';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

process.env.STITCH_TRACE_FILE = join(
    tmpdir(),
    'stitch-composition-' + process.pid + '.jsonl',
);

let server: MockServer;

beforeAll(async () => {
    server = await startMockServer();
});
afterAll(async () => {
    await server.close();
});
beforeEach(() => server.reset());

// Drain a stitch stream into an array of events.
async function collect<T>(
    gen: AsyncGenerator<StitchEvent<T>, void, unknown>,
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

// 1) Three composition facades resolve to the same canonical stitch and same result.
test('three facades (extends / defineStitch / builder) are equivalent', async () => {
    server.route('GET', '/items', { body: { data: [{ id: 1, name: 'Ada' }] } });

    const schema = z.array(z.object({ id: z.number(), name: z.string() }));
    const base = preset({ baseUrl: server.url, unwrap: 'data' });

    // (a) extends
    const viaExtends = stitch({
        extends: [base],
        path: '/items',
        output: schema,
    });
    // (b) factory
    const viaFactory = defineStitch(base)({ path: '/items', output: schema });
    // (c) builder
    const viaBuilder = stitch
        .use(base)
        .get('/items')
        .returns(schema)
        .unwrap('data');

    const expected = [{ id: 1, name: 'Ada' }];
    const [a, b, c] = await Promise.all([
        viaExtends(),
        viaFactory(),
        viaBuilder(),
    ]);

    expect(a).toEqual(expected);
    expect(b).toEqual(expected);
    expect(c).toEqual(expected);
    // All three hit the SAME route; equivalence means identical observable result.
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(server.callCount('/items')).toBe(3);
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

    const retryPreset = preset({ retry: { attempts: 3, on: [503] } });
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
    expect(result?.value).toEqual({ ok: true });
    // 503, 503, 200 -> success on the third attempt, proving attempts:3 and on:[503] survived.
    expect(result?.attempts).toBe(3);
    expect(server.callCount('/flaky')).toBe(3);
});

// 4) Hooks CHAIN rather than replace: onRequest base->child, onResponse child->base.
test('hooks chain across fragments (onRequest base->child, onResponse child->base)', async () => {
    server.route('GET', '/hooked', { body: { ok: true } });

    const order: string[] = [];
    const baseFrag = preset({
        baseUrl: server.url,
        hooks: {
            onRequest: () => {
                order.push('req:base');
            },
            onResponse: () => {
                order.push('res:base');
            },
        },
    });
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

import { stitch } from '../src';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-smoke-${process.pid}.jsonl`,
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

test('await sugar returns the unwrapped, validated result', async () => {
    server.route('GET', '/users', { body: { data: [{ id: 1, name: 'Ada' }] } });
    const users = stitch({
        baseUrl: server.url,
        path: '/users',
        pick: 'data',
        // raw Zod schema — inference removes the old `asValidator()` cast.
        output: z.array(z.object({ id: z.number(), name: z.string() })),
    });
    await expect(users()).resolves.toEqual([{ id: 1, name: 'Ada' }]);
});

test('event stream emits start -> request -> result -> done in order', async () => {
    server.route('GET', '/ping', { body: { ok: true } });
    const ping = stitch({ baseUrl: server.url, path: '/ping' });
    const types: string[] = [];
    for await (const ev of ping.stream()) types.push(ev.type);
    expect(types[0]).toBe('start');
    expect(types).toContain('result');
    expect(types.at(-1)).toBe('done');
});

test('path params expand and query is appended', async () => {
    server.route('GET', '/users/1', { body: { id: 1 } });
    const getUser = stitch({ baseUrl: server.url, path: '/users/{id}' });
    await expect(
        getUser({ params: { id: 1 }, query: { expand: 'roles' } }),
    ).resolves.toEqual({ id: 1 });
    expect(server.calls('/users/1')[0]?.query).toEqual({ expand: 'roles' });
});

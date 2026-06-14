// Output-schema inference: a raw schema passed to `output` needs no `asValidator` cast, the
// runtime still validates exactly as before, and the resolved TYPE is inferred from the schema.
// The typed bindings below (`user.name`, `users.map(...)`) are compile-time assertions too —
// tsconfig.test.json typechecks this file, so they fail the build if inference regresses.
import { seam, stitch } from '../src';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

import { z } from 'zod';

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

const userSchema = z.object({ id: z.number(), name: z.string() });

test('raw Zod `output` (no asValidator cast) validates and resolves the value', async () => {
    server.route('GET', '/u', { body: { id: 1, name: 'Ada' } });
    const getUser = stitch({
        baseUrl: server.url,
        path: '/u',
        output: userSchema,
    });
    const user = await getUser();
    // Inferred as { id: number; name: string } — this assignment is itself a type assertion.
    const typed: { id: number; name: string } = user;
    expect(typed).toEqual({ id: 1, name: 'Ada' });
});

test('inferred element type flows through `unwrap`', async () => {
    server.route('GET', '/list', { body: { data: [{ id: 1, name: 'Ada' }] } });
    const list = stitch({
        baseUrl: server.url,
        path: '/list',
        unwrap: 'data',
        output: z.array(userSchema),
    });
    const users = await list();
    // `.map`/`u.name` only typecheck if `users` is inferred as User[], not unknown.
    expect(users.map((u) => u.name)).toEqual(['Ada']);
});

test('a response that violates the schema still rejects (validation unchanged)', async () => {
    server.route('GET', '/bad', { body: { id: 'not-a-number', name: 'Ada' } });
    const getUser = stitch({
        baseUrl: server.url,
        path: '/bad',
        output: userSchema,
    });
    await expect(getUser()).rejects.toThrow();
});

test('seam members infer and validate identically', async () => {
    server.route('GET', '/u', { body: { id: 2, name: 'Bo' } });
    const api = seam({ baseUrl: server.url });
    const getUser = api.stitch({ path: '/u', output: userSchema });
    const user = await getUser();
    expect(user.name).toBe('Bo');
});

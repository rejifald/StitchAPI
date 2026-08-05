// Input-schema inference: a raw `input` schema (no cast) still validates and REJECTS bad input at
// runtime exactly as before, while the call argument is now TYPED from those schemas. The typed
// calls below (`{ body: { name, age } }`, the `.with(...)` bind) are compile-time assertions too —
// tsconfig.test.json typechecks this file, so they fail the build if call-arg inference regresses.
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

test('a typed call validates and resolves (raw input schema, no cast)', async () => {
    server.route('POST', '/users', { body: { id: 1, name: 'Ada' } });
    const createUser = stitch({
        baseUrl: server.url,
        path: '/users',
        method: 'POST',
        input: { body: z.object({ name: z.string(), age: z.number() }) },
        output: userSchema,
    });
    // The argument type is inferred: `{ body: { name: string; age: number } }`. This call is itself
    // a type assertion — it only compiles if input inference holds.
    const user = await createUser({ body: { name: 'Ada', age: 30 } });
    expect(user).toEqual({ id: 1, name: 'Ada' });
    expect(server.calls('/users')[0]?.body).toEqual({ name: 'Ada', age: 30 });
});

test('bad input still rejects at runtime (validation unchanged)', async () => {
    server.route('POST', '/users', { body: { id: 1, name: 'Ada' } });
    const createUser = stitch({
        baseUrl: server.url,
        path: '/users',
        method: 'POST',
        input: { body: z.object({ name: z.string(), age: z.number() }) },
        output: userSchema,
    });
    // The compiler would (correctly) reject a missing `age`; cast the argument past it to prove the
    // RUNTIME validator still rejects too (the value is unchanged — only the static check is bypassed).
    await expect(
        createUser({ body: { name: 'Ada' } } as never),
    ).rejects.toThrow(/invalid body/i);
    expect(server.callCount('/users')).toBe(0); // never left the client
});

test('.with() binds part of the input and the bound stitch still validates', async () => {
    server.route('POST', '/users', { body: { id: 2, name: 'Bo' } });
    const createUser = stitch({
        baseUrl: server.url,
        path: '/users',
        method: 'POST',
        input: { body: z.object({ name: z.string(), age: z.number() }) },
        output: userSchema,
    });
    // Binding `body` relaxes it to optional, so the bound stitch is callable with no argument.
    const bound = createUser.with({ body: { name: 'Bo', age: 1 } });
    const user = await bound();
    expect(user).toEqual({ id: 2, name: 'Bo' });
    expect(server.calls('/users')[0]?.body).toEqual({ name: 'Bo', age: 1 });
});

test('params + query schemas validate and the typed call expands them', async () => {
    server.route('GET', '/users/1', { body: { id: 1, name: 'Ada' } });
    const getUser = stitch({
        baseUrl: server.url,
        path: '/users/{id}',
        input: {
            params: z.object({ id: z.string() }),
            query: z.object({ trace: z.string() }).optional(),
        },
        output: userSchema,
    });
    // params required, query optional — both inferred onto the call argument.
    const user = await getUser({ params: { id: '1' }, query: { trace: 'on' } });
    expect(user.name).toBe('Ada');
    expect(server.calls('/users/1')[0]?.query).toEqual({ trace: 'on' });
});

test('an RFC 6570 path var with NO input schema requires params (Phase 2c)', async () => {
    server.route('GET', '/users/7', { body: { id: 7, name: 'Bo' } });
    // No `input.params` schema: the `{id}` template alone makes `params` a required call argument,
    // typed `string | number | bigint`. This call is itself a compile-time assertion
    // (tsconfig.test.json typechecks this file) — it only compiles because the path var is folded
    // into the argument.
    const getUser = stitch({
        baseUrl: server.url,
        path: '/users/{id}',
        output: userSchema,
    });
    const user = await getUser({ params: { id: 7 } });
    expect(user).toEqual({ id: 7, name: 'Bo' });
    expect(server.callCount('/users/7')).toBe(1);

    // `.with({ params })` relaxes the slot: the pre-bound stitch takes no further argument.
    const bound = getUser.with({ params: { id: 7 } });
    const same = await bound();
    expect(same.name).toBe('Bo');
});

test('a bigint path var reaches the server intact, digits and all', async () => {
    // End-to-end guard for the two-sided bug: the folded `params` slot USED TO be typed
    // `string | number` (so this call did not compile) and `expandPath` USED TO drop a bigint
    // entirely (so the URL became `/things/`, hitting the COLLECTION instead of the item). Both
    // sides are fixed; this pins them together, since either one alone still leaves the caller stuck.
    //
    // 9007199254740993n is `Number.MAX_SAFE_INTEGER + 2` — a value no JSON double can hold, which is
    // exactly why a caller parses ids like it into a bigint in the first place.
    const id = 9007199254740993n;
    server.route('GET', `/things/${id}`, { body: { id: 7, name: 'Bo' } });
    const getThing = stitch({
        baseUrl: server.url,
        path: '/things/{id}',
        output: userSchema,
    });

    // Compiles only because `params` admits a bigint; resolves only because the URL kept every digit.
    const thing = await getThing({ params: { id } });
    expect(thing.name).toBe('Bo');
    expect(server.callCount(`/things/${id}`)).toBe(1);
    // The lossy `number` form is a DIFFERENT, wrong path — it must never have been requested.
    expect(server.callCount(`/things/${Number(id)}`)).toBe(0);
    // And the id must not have vanished into a bare collection request.
    expect(server.callCount('/things/')).toBe(0);
});

test('seam members infer and validate input identically', async () => {
    server.route('POST', '/users', { body: { id: 3, name: 'Cy' } });
    const api = seam({ baseUrl: server.url });
    const createUser = api.stitch({
        path: '/users',
        method: 'POST',
        input: { body: z.object({ name: z.string() }) },
        output: userSchema,
    });
    const user = await createUser({ body: { name: 'Cy' } });
    expect(user.name).toBe('Cy');
});

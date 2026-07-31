import { seam, stitch } from '../src';
import type { StitchEvent } from '../src';
import { bearer, env, oauth2 } from '../src/auth';
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
    const base = { baseUrl: server.url, pick: 'data' };

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

// 1a) A single fragment is the one-element list (P7) — `Array.isArray` separates the two spellings,
// so a bare partial (an object) and a `Stitch` (a function) both read as one fragment.
test('a single `extends` fragment is the one-element list (P7)', async () => {
    server.route('GET', '/items', { body: { data: [{ id: 1, name: 'Ada' }] } });

    const base = { baseUrl: server.url, pick: 'data' };
    const bare = stitch({ extends: base, path: '/items' });
    const listed = stitch({ extends: [base], path: '/items' });

    expect(await bare()).toEqual([{ id: 1, name: 'Ada' }]);
    // Same resolved config both ways — the shorthand is not a second code path.
    expect(bare.__config).toEqual(listed.__config);
});

// 1b) A seam member resolves to the SAME result as the config-`extends` facade — the seam shares
// runtime on top, but its config inheritance is the same `flatten`/`compose` machinery.
test('a seam member is equivalent to the extends facade', async () => {
    server.route('GET', '/items', { body: { data: [{ id: 1, name: 'Ada' }] } });

    const schema = asValidator(
        z.array(z.object({ id: z.number(), name: z.string() })),
    );
    const base = { baseUrl: server.url, pick: 'data' };

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

// 3) Objects deep-merge across layers: base retry {attempts,on} survives a child adding {backoff}.
test('deep-merge keeps base retry.attempts/on when child adds retry.backoff.base', async () => {
    server.route('GET', '/flaky', {
        statuses: [503, 503, 200],
        body: { ok: true },
    });

    const retryPreset = { retry: { attempts: 3, on: [503] } };
    // Child only sets backoff; if merge replaced the object wholesale, attempts/on would be lost
    // and the stitch would NOT retry the two 503s.
    const flaky = stitch({
        baseUrl: server.url,
        path: '/flaky',
        extends: [retryPreset],
        retry: { backoff: { base: 5 } },
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

// 6-nested) P24/P12: `retry.backoff` is itself a scalar-or-envelope slot, so the bare curve folds
// too — the string form must never reach `__config` (P0), and the fold must survive the outer
// `retry` scalar shorthand being applied in the same pass.
test('retry.backoff folds its bare curve into the envelope', () => {
    expect(
        compose({ path: '/x', retry: { attempts: 2, backoff: 'fixed' } }).retry,
    ).toEqual({ attempts: 2, backoff: { curve: 'fixed' } });

    // Already an envelope → passed through untouched, not double-wrapped.
    expect(
        compose({ path: '/x', retry: { backoff: { base: 50, max: 500 } } })
            .retry,
    ).toEqual({ backoff: { base: 50, max: 500 } });

    // No `backoff` at all → the slot stays absent rather than gaining an empty envelope.
    expect(compose({ path: '/x', retry: 3 }).retry).toEqual({ attempts: 3 });
});

// 6a) P20/P12/P13: the stream/multipart dominant-field scalars and the `sse` toggle fold to their
// envelope at compose time (the opaque `{}` is rejected at the slot, so all-defaults arrives as the
// scalar). `sse: false` clears the slot.
test('stream/multipart scalars and the sse toggle expand to option objects', () => {
    const resolved = compose({
        path: 'https://api.example.com/x',
        stream: 'ndjson',
        multipart: 'dot',
        sse: true,
    });
    expect(resolved.stream).toEqual({ decode: 'ndjson' });
    expect(resolved.multipart).toEqual({ nesting: 'dot' });
    expect(resolved.sse).toEqual({ reconnect: true });

    expect(compose({ path: '/x', sse: false }).sse).toBeUndefined();
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

// 7) `auth` is an ATOMIC slot — last writer wins, never deep-merged. A strategy is a live object
// whose methods are optional, so folding two of them field-by-field splices the child's `apply`
// onto whichever of `shouldRefresh`/`refresh`/`scheme` only the parent declares. The same treatment
// `store`/`kind` get, for the same reason (ADR 0005 Decision 2), and load-bearing for security:
// the spliced strategy below authenticated as `bearer` but answered a 401 by running **oauth2's**
// refresh — a real client_credentials token request to an endpoint the child never named.
const oauth2Fragment = {
    auth: oauth2({
        tokenUrl: 'https://auth.example.com/token',
        clientId: 'id',
        clientSecret: 'sec',
    }),
};

test('a child auth replaces an inherited one whole — no spliced refresh methods', () => {
    const resolved = compose({
        extends: [oauth2Fragment],
        path: 'https://api.example.com/x',
        auth: bearer(env('TOK')),
    });
    // `bearer` declares neither, so neither may survive the merge. If they do, a 401 fires the
    // parent's token request against credentials the child never declared.
    expect(resolved.auth?.shouldRefresh).toBeUndefined();
    expect(resolved.auth?.refresh).toBeUndefined();
    expect(resolved.auth?.name).toBe('bearer');
});

test("a child auth's scheme is its own, not blended with the parent's", () => {
    const resolved = compose({
        extends: [oauth2Fragment],
        path: 'https://api.example.com/x',
        auth: bearer(env('TOK')),
    });
    // Blending produced `{ type: 'http', flows: {…}, scheme: 'bearer' }` — an `http` scheme
    // carrying oauth2 `flows` is not a valid OpenAPI security scheme, and it reaches the wire
    // through `__config.authScheme` / `stitch export --openapi`.
    expect(resolved.auth?.scheme).toEqual({ type: 'http', scheme: 'bearer' });
});

test('the atomic auth slot holds end-to-end on __config.authScheme', () => {
    const s = stitch({
        extends: [oauth2Fragment],
        path: 'https://api.example.com/x',
        auth: bearer(env('TOK')),
    });
    expect(s.__config.authScheme).toEqual({ type: 'http', scheme: 'bearer' });
});

test('an inherited auth still flows through when the child declares none', () => {
    const resolved = compose({
        extends: [oauth2Fragment],
        path: 'https://api.example.com/x',
    });
    expect(resolved.auth?.name).toBe('oauth2');
    expect(typeof resolved.auth?.refresh).toBe('function');
});

// ADR 0018 — `.inspect({ redact })`: opt-in scrubbing of secret-named fields in `raw`.
// Covers:
//   - `redactSecretsDeep` unit tests (secret keys, benign keys, nested, arrays, registered
//     key, extra patterns, input-immutability)
//   - `.inspect({ redact: true })` redacts secret-named fields in `raw`; default off; findings
//     are unaffected; `redact: string[]` adds extra patterns
import { drift, stitch } from '../src';
import type { Adapter } from '../src';
import { isSecretKey, redactSecretsDeep, registerSecretKey } from '../src/util';

import { z } from 'zod';

const REDACTED = 'REDACTED';
const URL = 'https://api.test/resource';

// ---- redactSecretsDeep unit tests -----------------------------------------

describe('redactSecretsDeep', () => {
    it('redacts a built-in secret-named key at the top level', () => {
        const result = redactSecretsDeep({
            access_token: 'abc123',
            name: 'alice',
        }) as Record<string, unknown>;
        expect(result['access_token']).toBe(REDACTED);
        expect(result['name']).toBe('alice');
    });

    it('keeps benign keys intact', () => {
        const result = redactSecretsDeep({
            id: 1,
            label: 'ok',
            items: [1, 2],
        }) as Record<string, unknown>;
        expect(result['id']).toBe(1);
        expect(result['label']).toBe('ok');
        expect(result['items']).toEqual([1, 2]);
    });

    it('redacts secret keys nested inside objects', () => {
        const input = { data: { api_key: 'secret', value: 42 } };
        const result = redactSecretsDeep(input) as {
            data: Record<string, unknown>;
        };
        expect(result.data['api_key']).toBe(REDACTED);
        expect(result.data['value']).toBe(42);
    });

    it('walks arrays and redacts secret keys inside each element', () => {
        const input = [
            { token: 'tok1', id: 1 },
            { token: 'tok2', id: 2 },
        ];
        const result = redactSecretsDeep(input) as Record<string, unknown>[];
        expect(result[0]?.['token']).toBe(REDACTED);
        expect(result[0]?.['id']).toBe(1);
        expect(result[1]?.['token']).toBe(REDACTED);
        expect(result[1]?.['id']).toBe(2);
    });

    it('handles deeply nested arrays of objects', () => {
        const input = { users: [{ password: 'pw', name: 'bob' }] };
        const result = redactSecretsDeep(input) as {
            users: Record<string, unknown>[];
        };
        expect(result.users[0]?.['password']).toBe(REDACTED);
        expect(result.users[0]?.['name']).toBe('bob');
    });

    it('redacts a key registered via registerSecretKey', () => {
        registerSecretKey('x_custom_cred');
        const result = redactSecretsDeep({
            x_custom_cred: 'val',
            other: 1,
        }) as Record<string, unknown>;
        expect(result['x_custom_cred']).toBe(REDACTED);
        expect(result['other']).toBe(1);
    });

    it('redacts extra key-name patterns passed by the caller', () => {
        const result = redactSecretsDeep({ myCustomKey: 'val', benign: 'ok' }, [
            'myCustomKey',
        ]) as Record<string, unknown>;
        expect(result['myCustomKey']).toBe(REDACTED);
        expect(result['benign']).toBe('ok');
    });

    it('does NOT mutate the input', () => {
        const input = { api_key: 'secret', name: 'safe' };
        redactSecretsDeep(input);
        expect(input.api_key).toBe('secret'); // untouched
    });

    it('returns primitives unchanged at the top level', () => {
        expect(redactSecretsDeep(42)).toBe(42);
        expect(redactSecretsDeep('plain')).toBe('plain');
        expect(redactSecretsDeep(null)).toBeNull();
        expect(redactSecretsDeep(undefined)).toBeUndefined();
    });

    it('returns an empty object unchanged', () => {
        expect(redactSecretsDeep({})).toEqual({});
    });

    it('returns an empty array unchanged', () => {
        expect(redactSecretsDeep([])).toEqual([]);
    });
});

// ---- isSecretKey -----------------------------------------------------------

describe('isSecretKey', () => {
    it('matches secret stems correctly', () => {
        expect(isSecretKey('api_key')).toBe(true);
        expect(isSecretKey('access_token')).toBe(true);
        expect(isSecretKey('page')).toBe(false);
    });
});

// ---- .inspect({ redact }) integration tests --------------------------------

function counting(
    body: unknown,
    opts?: { status?: number; headers?: Record<string, string> },
): { adapter: Adapter; calls: () => number } {
    let calls = 0;
    const adapter: Adapter = async () => {
        calls += 1;
        return {
            status: opts?.status ?? 200,
            headers: opts?.headers ?? {},
            body: typeof body === 'function' ? (body as () => unknown)() : body,
        };
    };
    return { adapter, calls: () => calls };
}

test('.inspect({ redact: true }) redacts secret-named fields in raw', async () => {
    const { adapter } = counting({
        id: 1,
        access_token: 'tok123',
        name: 'alice',
    });
    const s = stitch({
        url: URL,
        adapter,
        trace: false,
        output: drift(z.object({ id: z.number(), name: z.string() })),
    });
    const r = await s.inspect(undefined, { redact: true });
    const raw = r.raw as Record<string, unknown>;
    expect(raw['access_token']).toBe(REDACTED);
    expect(raw['name']).toBe('alice');
    expect(raw['id']).toBe(1);
});

test('default .inspect() leaves raw unredacted', async () => {
    const { adapter } = counting({ id: 1, access_token: 'tok123' });
    const s = stitch({ url: URL, adapter, trace: false });
    const r = await s.inspect();
    const raw = r.raw as Record<string, unknown>;
    // unredacted — the full secret value is present
    expect(raw['access_token']).toBe('tok123');
});

test('findings are unaffected by redaction', async () => {
    const { adapter } = counting({ n: '42', access_token: 'tok', extra: 'x' });
    const s = stitch({
        url: URL,
        adapter,
        trace: false,
        output: drift(z.object({ n: z.coerce.number() })),
    });
    const r = await s.inspect(undefined, { redact: true });
    // raw is redacted
    const raw = r.raw as Record<string, unknown>;
    expect(raw['access_token']).toBe(REDACTED);
    // findings still refer to structure (kinds only), not values — they are unchanged
    const changes = r.findings.map((f) => f.change);
    expect(changes).toContain('coerced'); // n: string -> number
    expect(changes).toContain('undeclared'); // access_token + extra both undeclared
    // the validated payload is unaffected
    expect(r.data).toEqual({ n: 42 });
    expect(r.error).toBeNull();
});

test('redact: string[] redacts an extra key-name pattern on top of the denylist', async () => {
    const { adapter } = counting({
        id: 1,
        mySpecialField: 'priv',
        name: 'bob',
    });
    const s = stitch({ url: URL, adapter, trace: false });
    const r = await s.inspect(undefined, { redact: ['mySpecialField'] });
    const raw = r.raw as Record<string, unknown>;
    expect(raw['mySpecialField']).toBe(REDACTED);
    expect(raw['name']).toBe('bob');
    expect(raw['id']).toBe(1);
});

test('redact: true leaves raw null on a streaming surface (no-op)', async () => {
    // Streaming surfaces already yield raw: null — redaction must not crash on null raw.
    // We simulate a cache hit, which also yields raw: null.
    const { adapter } = counting({ n: 1 });
    const s = stitch({
        url: URL,
        adapter,
        trace: false,
        cache: { ttl: '60s', scope: 'app' },
    });
    await s(); // warm the cache
    const r = await s.inspect(undefined, { cache: true, redact: true });
    // raw is null (cache hit) — redaction is a no-op
    expect(r.raw).toBeNull();
    expect(r.data).toEqual({ n: 1 });
});

test('raw remains non-enumerable after redaction', async () => {
    const { adapter } = counting({ id: 1, api_key: 'secret' });
    const s = stitch({ url: URL, adapter, trace: false });
    const r = await s.inspect(undefined, { redact: true });
    // readable deliberately
    expect((r.raw as Record<string, unknown>)['api_key']).toBe(REDACTED);
    // but non-enumerable
    const spread = { ...r } as Record<string, unknown>;
    expect('raw' in spread).toBe(false);
    const json = JSON.parse(JSON.stringify(r)) as Record<string, unknown>;
    expect('raw' in json).toBe(false);
});

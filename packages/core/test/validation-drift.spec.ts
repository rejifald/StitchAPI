// Drift is schema-anchored and diff-based (ADR 0015). Validation is the hard contract (returns the
// VALIDATED value — coerced/defaulted/stripped — or throws); drift is the soft diff of the raw body
// against that validated value. These exercise it end-to-end through the engine:
//   - validation throws on a missing-required / incompatible value (change: 'invalid', error);
//   - a stripped key → 'undeclared' (info); a coercion → 'coerced' (warn); a default → 'defaulted'
//     (verbose); each is non-fatal and the call resolves with the validated value;
//   - declared variance (optional absent, nullable null) validates clean and drifts nothing;
//   - `ignore` suppresses a path; `severity` re-levels (map) or filters (single/list).
import { drift, stitch } from '../src';
import type { DriftFinding, StitchEvent } from '../src';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';
import { asValidator } from './support/schema';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-drift-${process.pid}.jsonl`,
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

async function collect<T>(
    gen: AsyncGenerator<StitchEvent<T>, void>,
): Promise<StitchEvent<T>[]> {
    const events: StitchEvent<T>[] = [];
    for await (const ev of gen) events.push(ev);
    return events;
}

const driftFindings = (events: StitchEvent[]): DriftFinding[] =>
    events
        .filter(
            (e): e is Extract<StitchEvent, { type: 'drift' }> =>
                e.type === 'drift',
        )
        .map((e) => e.finding);

// ---------------------------------------------------------------------------
// 1. Valid response → resolves with the validated value, no drift.
// ---------------------------------------------------------------------------
test('schema valid: resolves with the validated value, no drift', async () => {
    server.route('GET', '/ok', { body: { id: 1, name: 'Ada' } });
    const s = stitch({
        baseUrl: server.url,
        path: '/ok',
        output: asValidator(z.object({ id: z.number(), name: z.string() })),
    });
    await expect(s()).resolves.toEqual({ id: 1, name: 'Ada' });
    expect(driftFindings(await collect(s.stream()))).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// 2. Plain output invalid → contract violation: rejects + error/invalid drift.
// ---------------------------------------------------------------------------
test('plain output invalid: rejects and emits error/invalid drift', async () => {
    server.route('GET', '/bad', { body: { id: '1' } }); // wants number
    const s = stitch({
        baseUrl: server.url,
        path: '/bad',
        output: asValidator(z.object({ id: z.number() })),
    });
    await expect(s()).rejects.toThrow();
    const events = await collect(s.stream());
    const invalid = driftFindings(events).find((f) => f.change === 'invalid');
    expect(invalid?.level).toBe('error');
    expect(invalid?.path).toBe('id');
    expect(events.some((e) => e.type === 'result')).toBe(false);
});

// ---------------------------------------------------------------------------
// 3. Soft drift — UNDECLARED: a stripped key surfaces as info; the call resolves
//    with the stripped (validated) value.
// ---------------------------------------------------------------------------
test('drift undeclared: a stripped key is info, result is the stripped value', async () => {
    server.route('GET', '/u', { body: { a: 1, b: 2 } });
    const s = stitch({
        baseUrl: server.url,
        path: '/u',
        output: drift(z.object({ a: z.number() })), // strips `b`
    });
    const events = await collect(s.stream());
    const f = driftFindings(events).find((x) => x.change === 'undeclared');
    expect(f?.level).toBe('info');
    expect(f?.path).toBe('b');
    await expect(s()).resolves.toEqual({ a: 1 }); // `b` stripped from the result
});

// ---------------------------------------------------------------------------
// 4. Soft drift — COERCED: a hidden wire-type shift surfaces as warn.
// ---------------------------------------------------------------------------
test('drift coerced: a coercion is warn with old->new detail', async () => {
    server.route('GET', '/c', { body: { n: '42' } });
    const s = stitch({
        baseUrl: server.url,
        path: '/c',
        output: drift(z.object({ n: z.coerce.number() })),
    });
    const events = await collect(s.stream());
    const f = driftFindings(events).find((x) => x.change === 'coerced');
    expect(f?.level).toBe('warn');
    expect(f?.path).toBe('n');
    expect(f?.detail).toBe('string -> number');
    await expect(s()).resolves.toEqual({ n: 42 });
});

// ---------------------------------------------------------------------------
// 5. Soft drift — DEFAULTED: a default firing surfaces as verbose (quietest).
// ---------------------------------------------------------------------------
test('drift defaulted: a default applied is verbose', async () => {
    server.route('GET', '/d', { body: {} });
    const s = stitch({
        baseUrl: server.url,
        path: '/d',
        output: drift(z.object({ n: z.number().default(5) })),
    });
    const events = await collect(s.stream());
    const f = driftFindings(events).find((x) => x.change === 'defaulted');
    expect(f?.level).toBe('verbose');
    expect(f?.path).toBe('n');
    await expect(s()).resolves.toEqual({ n: 5 });
});

// ---------------------------------------------------------------------------
// 6. Hard failure under drift(): a missing required field still throws.
// ---------------------------------------------------------------------------
test('drift + missing required: validation fails (invalid/error) and rejects', async () => {
    server.route('GET', '/r', { body: { name: 'x' } }); // id missing
    const s = stitch({
        baseUrl: server.url,
        path: '/r',
        output: drift(z.object({ id: z.number(), name: z.string() })),
    });
    const events = await collect(s.stream());
    const f = driftFindings(events).find((x) => x.change === 'invalid');
    expect(f?.level).toBe('error');
    expect(f?.path).toBe('id');
    await expect(s()).rejects.toThrow();
});

// ---------------------------------------------------------------------------
// 7. Variance is not drift: an optional field absent, a nullable null.
// ---------------------------------------------------------------------------
test('variance: optional absent and nullable null drift nothing', async () => {
    const s = stitch({
        baseUrl: server.url,
        path: '/v',
        output: drift(
            z.object({
                id: z.number(),
                avatar: z.string().nullable(),
                nickname: z.string().optional(),
            }),
        ),
    });
    server.route('GET', '/v', { body: { id: 1, avatar: null } });
    expect(driftFindings(await collect(s.stream()))).toHaveLength(0);
    await expect(s()).resolves.toEqual({ id: 1, avatar: null });
});

// ---------------------------------------------------------------------------
// 8. `ignore` suppresses a known undeclared path without touching the schema.
// ---------------------------------------------------------------------------
test('ignore: an acknowledged undeclared path is suppressed', async () => {
    server.route('GET', '/i', { body: { a: 1, meta: { reqId: 'x' } } });
    const s = stitch({
        baseUrl: server.url,
        path: '/i',
        output: drift(z.object({ a: z.number() }), { ignore: ['meta'] }),
    });
    expect(driftFindings(await collect(s.stream()))).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// 9. `severity` as a filter (single/list) and as a re-leveling map.
// ---------------------------------------------------------------------------
test('severity filter: a bare level surfaces only that tier', async () => {
    // undeclared defaults to info; asking for only 'warn' drops it.
    server.route('GET', '/s', { body: { a: 1, b: 2 } });
    const s = stitch({
        baseUrl: server.url,
        path: '/s',
        output: drift(z.object({ a: z.number() }), { severity: 'warn' }),
    });
    expect(driftFindings(await collect(s.stream()))).toHaveLength(0);
});

test('severity map: re-levels a kind', async () => {
    server.route('GET', '/sm', { body: { a: 1, b: 2 } });
    const s = stitch({
        baseUrl: server.url,
        path: '/sm',
        output: drift(z.object({ a: z.number() }), {
            severity: { undeclared: 'warn' },
        }),
    });
    const f = driftFindings(await collect(s.stream())).find(
        (x) => x.change === 'undeclared',
    );
    expect(f?.level).toBe('warn');
});

// ---------------------------------------------------------------------------
// 10. Standard Schema (non-Zod): valid resolves; invalid rejects with invalid/error.
// ---------------------------------------------------------------------------
test('standard schema (non-Zod): valid resolves, invalid rejects', async () => {
    const isValid = (v: unknown): v is { id: number } =>
        !!v &&
        typeof v === 'object' &&
        typeof (v as { id?: unknown }).id === 'number';
    const standard = {
        '~standard': {
            version: 1 as const,
            vendor: 'test',
            validate: (v: unknown) =>
                isValid(v)
                    ? { value: v }
                    : { issues: [{ message: 'bad', path: ['id'] }] },
        },
    };

    server.route('GET', '/std', { body: { id: 7 } });
    await expect(
        stitch({
            baseUrl: server.url,
            path: '/std',
            output: asValidator(standard),
        })(),
    ).resolves.toEqual({ id: 7 });

    server.reset();
    server.route('GET', '/std', { body: { id: 'nope' } });
    const bad = stitch({
        baseUrl: server.url,
        path: '/std',
        output: asValidator(standard),
    });
    await expect(bad()).rejects.toThrow();
    const invalid = driftFindings(await collect(bad.stream())).find(
        (f) => f.change === 'invalid',
    );
    expect(invalid?.level).toBe('error');
    expect(invalid?.path).toBe('id');
});

// ---------------------------------------------------------------------------
// 11. Array element: a missing required element field throws, addressed as `[]`.
// ---------------------------------------------------------------------------
test('array element: a missing required element field rejects at items[].id', async () => {
    server.route('GET', '/list', { body: { items: [{ id: 1 }, {}] } });
    const s = stitch({
        baseUrl: server.url,
        path: '/list',
        output: drift(
            z.object({ items: z.array(z.object({ id: z.number() })) }),
        ),
    });
    const f = driftFindings(await collect(s.stream())).find(
        (x) => x.change === 'invalid',
    );
    expect(f?.path).toBe('items[].id');
    expect(f?.level).toBe('error');
    await expect(s()).rejects.toThrow();
});

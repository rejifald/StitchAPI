import { drift, stitch } from '../src';
import type { DriftFinding, StitchEvent } from '../src';
import { loadSnapshot } from '../src/drift';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';
import { asValidator } from './support/schema';

import { existsSync, rmSync } from 'node:fs';
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

// Give each drift test its own snapshot file so baselines never collide.
let snapSeq = 0;
const freshSnapshot = (): string =>
    join(
        tmpdir(),
        `stitch-drift-snap-${process.pid}-${snapSeq++}-${Date.now()}.json`,
    );

// Drain a stream, returning every event (so we can inspect drift findings + ordering).
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
// 1. Schema valid — Zod output matches the response; await resolves with value.
// ---------------------------------------------------------------------------
test('schema valid: await resolves with the validated value', async () => {
    server.route('GET', '/ok', { body: { id: 1, name: 'Ada' } });
    const s = stitch({
        baseUrl: server.url,
        path: '/ok',
        output: asValidator(z.object({ id: z.number(), name: z.string() })),
    });
    await expect(s()).resolves.toEqual({ id: 1, name: 'Ada' });

    // And no drift findings on the stream for a clean response.
    const events = await collect(s.stream());
    expect(driftFindings(events)).toHaveLength(0);
    expect(events.at(-1)?.type).toBe('done');
});

// ---------------------------------------------------------------------------
// 2. Schema invalid -> contract violation: await rejects AND stream carries an
//    error-level `invalid` drift finding.
// ---------------------------------------------------------------------------
test('schema invalid: await rejects and stream emits error/invalid drift', async () => {
    server.route('GET', '/bad', { body: { id: '1' } }); // id is a string, schema wants number
    const s = stitch({
        baseUrl: server.url,
        path: '/bad',
        output: asValidator(z.object({ id: z.number() })),
    });

    await expect(s()).rejects.toThrow();

    const events = await collect(s.stream());
    const findings = driftFindings(events);
    const invalid = findings.find((f) => f.change === 'invalid');
    expect(invalid).toBeDefined();
    expect(invalid?.level).toBe('error');
    expect(invalid?.change).toBe('invalid');
    expect(invalid?.path).toBe('id');
    // No `result` event when the contract is violated.
    expect(events.some((e) => e.type === 'result')).toBe(false);
    expect(events.some((e) => e.type === 'error')).toBe(true);
});

// ---------------------------------------------------------------------------
// 3. Drift INFO — a brand-new field appears. First call = baseline (no drift),
//    second call emits level:info change:new with path including `b`.
// ---------------------------------------------------------------------------
test('drift info: new field detected on the second call', async () => {
    const snapshotFile = freshSnapshot();
    // Permissive schema so the new field never fails validation.
    const schema = z.object({ a: z.number() }).passthrough();
    server.route('GET', '/grow', { body: [{ a: 1 }, { a: 1, b: 2 }] });
    const s = stitch({
        baseUrl: server.url,
        path: '/grow',
        output: drift(schema, { snapshotFile, onNew: 'info' }),
    });

    // First call records the baseline: resolves, no drift.
    const first = await collect(s.stream());
    expect(driftFindings(first)).toHaveLength(0);
    expect(first.some((e) => e.type === 'result')).toBe(true);

    // Second call sees the added field `b`.
    const second = await collect(s.stream());
    const findings = driftFindings(second);
    const added = findings.find((f) => f.change === 'new');
    expect(added).toBeDefined();
    expect(added?.level).toBe('info');
    expect(added?.change).toBe('new');
    expect(added?.path).toContain('b');
    // info is non-fatal -> still resolves.
    await expect(s()).resolves.toBeDefined();
});

// ---------------------------------------------------------------------------
// 4. Drift ERROR — a critical field goes missing. Second call emits
//    level:error change:missing path:id AND await rejects.
// ---------------------------------------------------------------------------
test('drift error: missing critical field rejects on the second call', async () => {
    const snapshotFile = freshSnapshot();
    const schema = z.object({ name: z.string() }).passthrough();
    server.route('GET', '/shrink', {
        body: [{ id: 1, name: 'x' }, { name: 'x' }],
    });
    const s = stitch({
        baseUrl: server.url,
        path: '/shrink',
        output: drift(schema, { critical: ['id'], snapshotFile }),
    });

    // First call = baseline.
    const first = await collect(s.stream());
    expect(driftFindings(first)).toHaveLength(0);

    // Second call: `id` (critical) is missing.
    const second = await collect(s.stream());
    const findings = driftFindings(second);
    const missing = findings.find((f) => f.change === 'missing');
    expect(missing).toBeDefined();
    expect(missing?.level).toBe('error');
    expect(missing?.change).toBe('missing');
    expect(missing?.path).toBe('id');

    // The stream carried the finding; the await path must reject (contract violation).
    server.reset();
    server.route('GET', '/shrink', { body: { name: 'x' } }); // now always the drifted shape
    await expect(s()).rejects.toThrow();
});

// ---------------------------------------------------------------------------
// 5. Drift WARN — a watched/other field changes type. Non-critical -> warn,
//    and the call still RESOLVES.
// ---------------------------------------------------------------------------
test('drift warn: non-critical type change is non-fatal', async () => {
    const snapshotFile = freshSnapshot();
    // score is permissive so the type change itself does not fail validation.
    const schema = z.object({ id: z.number(), score: z.any() });
    server.route('GET', '/score', {
        body: [
            { id: 1, score: 1 },
            { id: 1, score: '1' },
        ],
    });
    const s = stitch({
        baseUrl: server.url,
        path: '/score',
        output: drift(schema, { snapshotFile }),
    });

    // First call = baseline.
    const first = await collect(s.stream());
    expect(driftFindings(first)).toHaveLength(0);

    // Second call: score number -> string.
    const second = await collect(s.stream());
    const findings = driftFindings(second);
    const changed = findings.find((f) => f.path === 'score');
    expect(changed).toBeDefined();
    expect(changed?.level).toBe('warn');
    expect(['type-changed', 'nullable']).toContain(changed?.change);
    // warn is non-fatal: a `result` still flows and the await resolves.
    expect(second.some((e) => e.type === 'result')).toBe(true);

    server.reset();
    server.route('GET', '/score', { body: { id: 1, score: '1' } });
    await expect(s()).resolves.toEqual({ id: 1, score: '1' });
});

// ---------------------------------------------------------------------------
// 6. Standard Schema flexibility (non-Zod) — a minimal `~standard` literal as
//    output. Valid resolves; invalid rejects with an error/invalid drift.
// ---------------------------------------------------------------------------
test('standard schema (non-Zod): valid resolves, invalid rejects with error/invalid', async () => {
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

    // Valid response resolves.
    server.route('GET', '/std', { body: { id: 7 } });
    const ok = stitch({
        baseUrl: server.url,
        path: '/std',
        output: asValidator(standard),
    });
    await expect(ok()).resolves.toEqual({ id: 7 });

    // Invalid response (id is a string) rejects with an error/invalid drift finding.
    server.reset();
    server.route('GET', '/std', { body: { id: 'nope' } });
    const bad = stitch({
        baseUrl: server.url,
        path: '/std',
        output: asValidator(standard),
    });

    await expect(bad()).rejects.toThrow();

    const events = await collect(bad.stream());
    const invalid = driftFindings(events).find((f) => f.change === 'invalid');
    expect(invalid).toBeDefined();
    expect(invalid?.level).toBe('error');
    expect(invalid?.change).toBe('invalid');
    expect(invalid?.path).toBe('id');
    expect(events.some((e) => e.type === 'result')).toBe(false);
});

// ---------------------------------------------------------------------------
// 7. readonly drift — a missing snapshot in `readonly` mode surfaces a
//    `no-baseline` finding (warn by default, non-fatal) and NEVER writes the
//    baseline as a call side effect (#132).
// ---------------------------------------------------------------------------
test('readonly: missing snapshot emits warn/no-baseline and writes nothing', async () => {
    const snapshotFile = freshSnapshot(); // path that does not exist yet
    try {
        const schema = z.object({ id: z.number() }).passthrough();
        server.route('GET', '/ro', { body: { id: 1, name: 'Ada' } });
        const s = stitch({
            baseUrl: server.url,
            path: '/ro',
            output: drift(schema, { readonly: true, snapshotFile }),
        });

        const events = await collect(s.stream());
        const finding = driftFindings(events).find(
            (f) => f.change === 'no-baseline',
        );
        expect(finding).toBeDefined();
        expect(finding?.level).toBe('warn'); // onMissing default
        expect(finding?.change).toBe('no-baseline');
        expect(finding?.detail).toContain(snapshotFile);

        // warn is non-fatal: a `result` still flows and the await resolves.
        expect(events.some((e) => e.type === 'result')).toBe(true);
        await expect(s()).resolves.toEqual({ id: 1, name: 'Ada' });

        // The baseline must NOT have been written — readonly is detect-but-don't-write.
        expect(existsSync(snapshotFile)).toBe(false);
    } finally {
        rmSync(snapshotFile, { force: true });
    }
});

// ---------------------------------------------------------------------------
// 8. readonly drift with onMissing:'error' — the `no-baseline` finding is an
//    error, so the await rejects (contract violation) and still writes nothing.
// ---------------------------------------------------------------------------
test('readonly onMissing:error: missing snapshot rejects and writes nothing', async () => {
    const snapshotFile = freshSnapshot();
    try {
        const schema = z.object({ id: z.number() }).passthrough();
        server.route('GET', '/ro-err', { body: { id: 1 } });
        const s = stitch({
            baseUrl: server.url,
            path: '/ro-err',
            output: drift(schema, {
                readonly: true,
                onMissing: 'error',
                snapshotFile,
            }),
        });

        const events = await collect(s.stream());
        const finding = driftFindings(events).find(
            (f) => f.change === 'no-baseline',
        );
        expect(finding).toBeDefined();
        expect(finding?.level).toBe('error');
        // error breaks the contract: no `result`, and the await rejects.
        expect(events.some((e) => e.type === 'result')).toBe(false);
        await expect(s()).rejects.toThrow();

        expect(existsSync(snapshotFile)).toBe(false);
    } finally {
        rmSync(snapshotFile, { force: true });
    }
});

// ---------------------------------------------------------------------------
// 9. Default (no readonly) still WRITES the baseline on first run — preserving
//    today's behaviour: the snapshot file is created and no finding is emitted.
// ---------------------------------------------------------------------------
test('default (no readonly): first run writes the baseline, no finding', async () => {
    const snapshotFile = freshSnapshot();
    try {
        const schema = z.object({ id: z.number() }).passthrough();
        server.route('GET', '/baseline', { body: { id: 1 } });
        const s = stitch({
            baseUrl: server.url,
            path: '/baseline',
            output: drift(schema, { snapshotFile }),
        });

        const events = await collect(s.stream());
        // First run records the baseline silently: no drift findings.
        expect(driftFindings(events)).toHaveLength(0);
        expect(events.some((e) => e.type === 'result')).toBe(true);
        // …and the baseline file was created.
        expect(existsSync(snapshotFile)).toBe(true);
    } finally {
        rmSync(snapshotFile, { force: true });
    }
});

// ---------------------------------------------------------------------------
// 10. Shape-only, BigInt-safe baseline — a transform yields a value carrying a
//     BigInt (which `JSON.stringify` cannot serialise). The baseline must still
//     write (no throw), storing the payload-free SHAPE with the field typed
//     `bigint`, and a subsequent identical run drifts nothing.
// ---------------------------------------------------------------------------
test('bigint-safe: baseline stores the shape (bigint field) without throwing', async () => {
    const snapshotFile = freshSnapshot();
    try {
        server.route('GET', '/sized', { body: { id: 1 } });
        const s = stitch({
            baseUrl: server.url,
            path: '/sized',
            // The transform mints a BigInt — the shape baseline must not choke on it.
            transform: () => ({ id: 1, sizeBytes: 42n }),
            output: drift(() => true, { snapshotFile }),
        });

        const first = await collect(s.stream());
        expect(driftFindings(first)).toHaveLength(0);
        expect(first.some((e) => e.type === 'result')).toBe(true);

        // Payload-free shape, with the BigInt typed as "bigint".
        expect(loadSnapshot(snapshotFile)).toEqual({
            version: 1,
            shape: { id: 'number', sizeBytes: 'bigint' },
        });

        // A second identical run compares clean — no drift findings.
        const second = await collect(s.stream());
        expect(driftFindings(second)).toHaveLength(0);
    } finally {
        rmSync(snapshotFile, { force: true });
    }
});

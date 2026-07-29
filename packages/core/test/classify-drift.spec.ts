// Unit tests for the drift classifiers (src/drift.ts), ADR 0015. `classifyDiff` turns the structural
// diff of raw-vs-validated into leveled soft findings; `validationErrors` turns hard validation issues
// into fatal `invalid` findings. The diff is pure, so these use plain objects (no Zod needed).
import { classifyDiff, validationErrors } from '../src/drift';

describe('classifyDiff', () => {
    test('a stripped key → undeclared (info) at its path', () => {
        expect(classifyDiff({ a: 1, b: 2 }, { a: 1 })).toEqual([
            {
                level: 'info',
                path: 'b',
                change: 'undeclared',
                detail: 'undeclared field (number)',
            },
        ]);
    });

    test('a coerced value → coerced (warn) with old->new detail', () => {
        expect(classifyDiff({ n: '42' }, { n: 42 })).toEqual([
            {
                level: 'warn',
                path: 'n',
                change: 'coerced',
                detail: 'string -> number',
            },
        ]);
    });

    test('a default applied → defaulted (verbose)', () => {
        expect(classifyDiff({}, { n: 5 })).toEqual([
            {
                level: 'verbose',
                path: 'n',
                change: 'defaulted',
                detail: 'default applied',
            },
        ]);
    });

    test('identical raw and validated → no findings', () => {
        expect(classifyDiff({ a: 1, b: 'x' }, { a: 1, b: 'x' })).toEqual([]);
    });

    test('array element paths collapse to [] — homogeneous: one summary finding with count and sample (ADR 0017)', () => {
        const findings = classifyDiff(
            {
                items: [
                    { a: 1, x: 9 },
                    { a: 2, x: 9 },
                ],
            },
            { items: [{ a: 1 }, { a: 2 }] }, // `x` stripped from every element
        );
        expect(findings).toHaveLength(1);
        expect(findings[0]?.path).toBe('items[].x');
        expect(findings[0]?.change).toBe('undeclared');
        expect(findings[0]?.detail).toBe(
            'all 2 elements: undeclared field (number)',
        );
        expect(findings[0]?.sample).toBe('items[0].x');
    });

    // ADR 0017 — homogeneous array coercion
    test('homogeneous array coercion: one summary finding + correct count + concrete sample', () => {
        // All three items have their `id` coerced from string to number.
        const findings = classifyDiff(
            { items: [{ id: '1' }, { id: '2' }, { id: '3' }] },
            { items: [{ id: 1 }, { id: 2 }, { id: 3 }] },
        );
        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            path: 'items[].id',
            change: 'coerced',
            detail: 'all 3 elements: string -> number',
            sample: 'items[0].id',
        });
    });

    // ADR 0017 — heterogeneous array: distinct detail variants each surface
    test('heterogeneous array coercion: one finding per distinct detail variant, none dropped', () => {
        // Element 0: string -> number; element 1: boolean -> number. Same [] path, different detail.
        const findings = classifyDiff(
            { items: [{ x: '42' }, { x: true }] },
            { items: [{ x: 42 }, { x: 1 }] },
        );
        expect(findings).toHaveLength(2);
        const details = findings.map((f) => f.detail).sort();
        expect(details).toEqual([
            '1 element: boolean -> number',
            '1 element: string -> number',
        ]);
        // Both have samples pointing at concrete indices.
        const samples = findings.map((f) => f.sample).sort();
        expect(samples).toEqual(['items[0].x', 'items[1].x']);
        // All share the same collapsed path and change.
        for (const f of findings) {
            expect(f.path).toBe('items[].x');
            expect(f.change).toBe('coerced');
        }
    });

    // ADR 0017 — single outlier in a large array: one summary + one variant, no flood
    test('single outlier in a large array: summary + variant, no element flood', () => {
        // 9 elements coerced string->number, 1 coerced boolean->number (the outlier at index 5).
        const raw = {
            items: [
                { v: '1' },
                { v: '2' },
                { v: '3' },
                { v: '4' },
                { v: '5' },
                { v: true }, // outlier
                { v: '7' },
                { v: '8' },
                { v: '9' },
                { v: '10' },
            ],
        };
        const validated = {
            items: [
                { v: 1 },
                { v: 2 },
                { v: 3 },
                { v: 4 },
                { v: 5 },
                { v: 1 },
                { v: 7 },
                { v: 8 },
                { v: 9 },
                { v: 10 },
            ],
        };
        const findings = classifyDiff(raw, validated);
        // Only 2 findings total — no per-element flood.
        expect(findings).toHaveLength(2);
        const summary = findings.find((f) =>
            f.detail?.includes('string -> number'),
        );
        const variant = findings.find((f) =>
            f.detail?.includes('boolean -> number'),
        );
        expect(summary).toBeDefined();
        expect(variant).toBeDefined();
        expect(summary?.detail).toBe('9 elements: string -> number');
        expect(variant?.detail).toBe('1 element: boolean -> number');
        expect(variant?.sample).toBe('items[5].v');
    });

    // ADR 0017 — scalar-array coercion (the array itself is the coerced value, not an element field)
    test('scalar-array coercion: one summary finding on the array path', () => {
        // Each element of `tags` is coerced from number to string.
        const findings = classifyDiff(
            { tags: [1, 2, 3] },
            { tags: ['1', '2', '3'] },
        );
        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            path: 'tags[]',
            change: 'coerced',
            detail: 'all 3 elements: number -> string',
            sample: 'tags[0]',
        });
    });

    // ADR 0017 — a single drifting element in an array reads "1 element:" (grammatical, no "all")
    test('single drifting array element: "1 element:" detail with concrete sample', () => {
        // Only items[1].x drifts (undeclared); items[0] is clean.
        const findings = classifyDiff(
            {
                items: [{ a: 1 }, { a: 2, x: 9 }],
            },
            { items: [{ a: 1 }, { a: 2 }] },
        );
        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            path: 'items[].x',
            change: 'undeclared',
            detail: '1 element: undeclared field (number)',
            sample: 'items[1].x',
        });
    });

    test('ignore suppresses a path (prefix grammar)', () => {
        expect(
            classifyDiff(
                { a: 1, meta: { id: 'x' } },
                { a: 1 },
                {
                    ignore: ['meta'],
                },
            ),
        ).toEqual([]);
    });

    test('ignore accepts a bare string as a one-element list (P7)', () => {
        // `ignore: 'meta'` ≡ `ignore: ['meta']` — the `T | T[]` widening (CONTRACT.md P7).
        expect(
            classifyDiff(
                { a: 1, meta: { id: 'x' } },
                { a: 1 },
                { ignore: 'meta' },
            ),
        ).toEqual([]);
    });

    describe('severity', () => {
        test('a bare level is an allowlist — only that tier surfaces', () => {
            // undeclared defaults to info, so requesting only 'warn' drops it...
            expect(
                classifyDiff({ a: 1, b: 2 }, { a: 1 }, { severity: 'warn' }),
            ).toEqual([]);
            // ...while a coercion (default warn) passes the same filter.
            expect(
                classifyDiff({ n: '1' }, { n: 1 }, { severity: 'warn' }),
            ).toHaveLength(1);
        });

        test('a bare list is an allowlist of several tiers', () => {
            const findings = classifyDiff(
                { a: 1, b: 2 },
                { a: 1 },
                {
                    severity: ['info', 'verbose'],
                },
            );
            expect(findings[0]?.change).toBe('undeclared');
        });

        test('a map re-levels a kind (all kinds still surface)', () => {
            const findings = classifyDiff(
                { a: 1, b: 2 },
                { a: 1 },
                {
                    severity: { undeclared: 'warn' },
                },
            );
            expect(findings[0]?.level).toBe('warn');
        });
    });
});

describe('validationErrors', () => {
    test('each issue → a fatal error/invalid finding', () => {
        expect(
            validationErrors([{ path: ['id'], message: 'Required' }]),
        ).toEqual([
            {
                level: 'error',
                path: 'id',
                change: 'invalid',
                detail: 'Required',
            },
        ]);
    });

    test('a numeric array index renders as []', () => {
        expect(
            validationErrors([{ path: ['items', 0, 'id'], message: 'x' }])[0]
                ?.path,
        ).toBe('items[].id');
    });
});

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

    test('array element paths collapse to [] and dedupe', () => {
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

// Direct unit tests for classifyDrift (src/drift.ts), the leveled shape-diff at the heart of the
// drift feature. validation-drift.spec.ts exercises it only THROUGH the engine, so its branches are
// imprecisely pinned (the warn test even accepts type-changed OR nullable). These pin them head-on:
//   - an undefined snapshot is the baseline → no findings;
//   - a missing field → warn (error when critical); a new field → info (or opts.onNew);
//   - a type change → warn (error when critical); a null↔type change is classified 'nullable';
//   - topmost dedup: a missing ancestor suppresses its descendants;
//   - array element shapes are diffed via the `[]` segment.
import { classifyDrift } from '../src/drift';
import type { DriftFinding } from '../src/types';

describe('classifyDrift', () => {
    test('an undefined snapshot is the baseline (no findings)', () => {
        expect(classifyDrift({ a: 1 }, undefined)).toEqual([]);
    });

    test('an identical shape yields no findings', () => {
        expect(classifyDrift({ a: 1, b: 'x' }, { a: 2, b: 'y' })).toEqual([]);
    });

    test('a missing field is warn by default, error when critical', () => {
        expect(classifyDrift({}, { a: 1 })).toEqual([
            {
                level: 'warn',
                path: 'a',
                change: 'missing',
                detail: 'expected number no longer present',
            },
        ]);
        expect(classifyDrift({}, { a: 1 }, { critical: ['a'] })[0]?.level).toBe(
            'error',
        );
    });

    test('a new field is info by default, or opts.onNew', () => {
        expect(classifyDrift({ a: 1, b: 2 }, { a: 1 })).toEqual([
            { level: 'info', path: 'b', change: 'new', detail: 'new field (number)' },
        ]);
        expect(
            classifyDrift({ a: 1, b: 2 }, { a: 1 }, { onNew: 'warn' })[0]?.level,
        ).toBe('warn');
    });

    test('a type change is warn by default, error when critical', () => {
        expect(classifyDrift({ a: 'x' }, { a: 1 })).toEqual([
            {
                level: 'warn',
                path: 'a',
                change: 'type-changed',
                detail: 'number -> string',
            },
        ]);
        expect(
            classifyDrift({ a: 'x' }, { a: 1 }, { critical: ['a'] })[0]?.level,
        ).toBe('error');
    });

    test('a null↔type change is classified as nullable (either direction)', () => {
        expect(classifyDrift({ a: null }, { a: 1 })[0]?.change).toBe('nullable');
        expect(classifyDrift({ a: 1 }, { a: null })[0]?.change).toBe('nullable');
    });

    test('topmost dedup: a missing ancestor suppresses its descendants', () => {
        const findings = classifyDrift({}, { a: { b: 1, c: 2 } });
        expect(findings).toHaveLength(1);
        expect(findings[0]?.path).toBe('a');
    });

    test('array element shapes are diffed via the [] segment', () => {
        const findings = classifyDrift(
            { items: [] },
            { items: [{ id: 1 }] },
        );
        const itemEl = findings.find(
            (f: DriftFinding) => f.path === 'items[]',
        );
        expect(itemEl?.change).toBe('missing');
    });
});

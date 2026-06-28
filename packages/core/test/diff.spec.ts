import { diff } from '../src/diff';

describe('diff — identical inputs', () => {
    test('returns [] for identical primitives', () => {
        expect(diff(1, 1)).toEqual([]);
        expect(diff('hello', 'hello')).toEqual([]);
        expect(diff(true, true)).toEqual([]);
        expect(diff(null, null)).toEqual([]);
        expect(diff(undefined, undefined)).toEqual([]);
    });

    test('returns [] for identical flat objects', () => {
        expect(diff({ a: 1, b: 2 }, { a: 1, b: 2 })).toEqual([]);
    });

    test('returns [] for identical arrays', () => {
        expect(diff([1, 2, 3], [1, 2, 3])).toEqual([]);
    });

    test('returns [] for empty object', () => {
        expect(diff({}, {})).toEqual([]);
    });

    test('returns [] for empty array', () => {
        expect(diff([], [])).toEqual([]);
    });
});

describe('diff — top-level create / remove / change', () => {
    test('top-level key added → create', () => {
        expect(diff({ a: 1 }, { a: 1, b: 2 })).toEqual([
            { op: 'create', path: ['b'], value: 2 },
        ]);
    });

    test('top-level key removed → remove', () => {
        expect(diff({ a: 1, b: 2 }, { a: 1 })).toEqual([
            { op: 'remove', path: ['b'], oldValue: 2 },
        ]);
    });

    test('top-level primitive change', () => {
        expect(diff({ a: 1 }, { a: 2 })).toEqual([
            { op: 'change', path: ['a'], oldValue: 1, value: 2 },
        ]);
    });
});

describe('diff — nested object change (path depth ≥ 2)', () => {
    test('deeply nested value change', () => {
        const before = { a: { b: { c: 1 } } };
        const after = { a: { b: { c: 2 } } };
        expect(diff(before, after)).toEqual([
            { op: 'change', path: ['a', 'b', 'c'], oldValue: 1, value: 2 },
        ]);
    });

    test('nested key added', () => {
        expect(diff({ a: { b: 1 } }, { a: { b: 1, c: 3 } })).toEqual([
            { op: 'create', path: ['a', 'c'], value: 3 },
        ]);
    });
});

describe('diff — arrays', () => {
    test('array element change', () => {
        expect(diff([1, 2, 3], [1, 9, 3])).toEqual([
            { op: 'change', path: [1], oldValue: 2, value: 9 },
        ]);
    });

    test('array grow (extra element at end)', () => {
        expect(diff([1, 2], [1, 2, 3])).toEqual([
            { op: 'create', path: [2], value: 3 },
        ]);
    });

    test('array shrink (trailing element removed)', () => {
        expect(diff([1, 2, 3], [1, 2])).toEqual([
            { op: 'remove', path: [2], oldValue: 3 },
        ]);
    });

    test('nested array element change uses numeric path segment', () => {
        const before = { items: [{ v: 1 }, { v: 2 }] };
        const after = { items: [{ v: 1 }, { v: 99 }] };
        expect(diff(before, after)).toEqual([
            { op: 'change', path: ['items', 1, 'v'], oldValue: 2, value: 99 },
        ]);
    });
});

describe('diff — null handling', () => {
    test('null vs null → no diff', () => {
        expect(diff(null, null)).toEqual([]);
    });

    test('null vs object → change (no recursion)', () => {
        expect(diff(null, { a: 1 })).toEqual([
            { op: 'change', path: [], oldValue: null, value: { a: 1 } },
        ]);
    });

    test('object vs null → change (no recursion)', () => {
        expect(diff({ a: 1 }, null)).toEqual([
            { op: 'change', path: [], oldValue: { a: 1 }, value: null },
        ]);
    });

    test('null key value vs missing key → remove', () => {
        expect(diff({ a: null }, {})).toEqual([
            { op: 'remove', path: ['a'], oldValue: null },
        ]);
    });

    test('missing key vs null key value → create', () => {
        expect(diff({}, { a: null })).toEqual([
            { op: 'create', path: ['a'], value: null },
        ]);
    });
});

describe('diff — explicit undefined vs missing', () => {
    test('key with undefined value in before, absent in after → remove', () => {
        const before: Record<string, unknown> = {};
        before['a'] = undefined;
        const after = {};
        expect(diff(before, after)).toEqual([
            { op: 'remove', path: ['a'], oldValue: undefined },
        ]);
    });

    test('key absent in before, explicit undefined in after → create', () => {
        const before = {};
        const after: Record<string, unknown> = {};
        after['a'] = undefined;
        expect(diff(before, after)).toEqual([
            { op: 'create', path: ['a'], value: undefined },
        ]);
    });

    test('both explicit undefined → equal', () => {
        const before: Record<string, unknown> = { a: undefined };
        const after: Record<string, unknown> = { a: undefined };
        expect(diff(before, after)).toEqual([]);
    });
});

describe('diff — primitive type change', () => {
    test("string '42' vs number 42 → single change", () => {
        expect(diff({ v: '42' }, { v: 42 })).toEqual([
            { op: 'change', path: ['v'], oldValue: '42', value: 42 },
        ]);
    });

    test('boolean vs number → change', () => {
        expect(diff(true, 1)).toEqual([
            { op: 'change', path: [], oldValue: true, value: 1 },
        ]);
    });
});

describe('diff — kind replacement (no recursion into replaced subtree)', () => {
    test('object → array: single change, no child ops', () => {
        const result = diff({ a: 1 }, [1, 2, 3]);
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ op: 'change', path: [] });
    });

    test('array → object: single change', () => {
        const result = diff([1, 2], { a: 1 });
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ op: 'change', path: [] });
    });

    test('object → primitive: single change', () => {
        const result = diff({ a: 1 }, 42);
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
            op: 'change',
            path: [],
            oldValue: { a: 1 },
            value: 42,
        });
    });

    test('nested object replaced by primitive → one change, no child ops', () => {
        const before = { x: { y: 1 } };
        const after = { x: 'scalar' };
        expect(diff(before, after)).toEqual([
            { op: 'change', path: ['x'], oldValue: { y: 1 }, value: 'scalar' },
        ]);
    });
});

describe('diff — bigint values', () => {
    test('equal bigints → no diff', () => {
        expect(diff(42n, 42n)).toEqual([]);
    });

    test('different bigints → change', () => {
        expect(diff(1n, 2n)).toEqual([
            { op: 'change', path: [], oldValue: 1n, value: 2n },
        ]);
    });

    test('bigint in object', () => {
        expect(diff({ n: 1n }, { n: 2n })).toEqual([
            { op: 'change', path: ['n'], oldValue: 1n, value: 2n },
        ]);
    });
});

describe('diff — NaN equality', () => {
    test('NaN equals NaN (Object.is)', () => {
        expect(diff(NaN, NaN)).toEqual([]);
    });

    test('NaN vs number → change', () => {
        expect(diff(NaN, 1)).toEqual([
            { op: 'change', path: [], oldValue: NaN, value: 1 },
        ]);
    });
});

describe('diff — deeply nested mixed structure', () => {
    test('realistic nested change', () => {
        const before = {
            user: {
                name: 'Alice',
                roles: ['admin', 'user'],
                meta: { active: true, score: 10 },
            },
            version: 1,
        };
        const after = {
            user: {
                name: 'Alice',
                roles: ['admin', 'user', 'editor'],
                meta: { active: false, score: 10 },
            },
            version: 2,
        };
        const result = diff(before, after);
        expect(result).toEqual(
            expect.arrayContaining([
                { op: 'create', path: ['user', 'roles', 2], value: 'editor' },
                {
                    op: 'change',
                    path: ['user', 'meta', 'active'],
                    oldValue: true,
                    value: false,
                },
                { op: 'change', path: ['version'], oldValue: 1, value: 2 },
            ]),
        );
        expect(result).toHaveLength(3);
    });
});

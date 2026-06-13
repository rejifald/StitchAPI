// Pins docs/GAP-AUDIT.md §1.2: toValidator() must accept a plain predicate function, as four doc pages promise
import { toValidator } from '../../src/validator';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-tovalidator-predicate-${process.pid}.jsonl`,
);

// ---------------------------------------------------------------------------
// 1. toValidator() does NOT throw when given a plain boolean predicate.
// ---------------------------------------------------------------------------
test('toValidator: accepts a plain predicate without throwing', () => {
    expect(() =>
        toValidator((v: unknown) => typeof v === 'string'),
    ).not.toThrow();
});

// ---------------------------------------------------------------------------
// 2. The produced Validator validates a passing value as ok.
// ---------------------------------------------------------------------------
test('toValidator predicate: passing value resolves ok:true', async () => {
    const validator = toValidator((v: unknown) => typeof v === 'string');
    // validator may be undefined only if schema is null/undefined; a function is non-null.
    expect(validator).toBeDefined();

    const result = await validator!.validate('hello');
    expect(result.ok).toBe(true);
    expect((result as { ok: true; value: unknown }).value).toBe('hello');
});

// ---------------------------------------------------------------------------
// 3. The produced Validator returns at least one issue for a failing value.
//    The issue shape must be consistent with Validator<T>: { path, message }.
// ---------------------------------------------------------------------------
test('toValidator predicate: failing value resolves ok:false with at least one issue', async () => {
    const validator = toValidator((v: unknown) => typeof v === 'string');
    expect(validator).toBeDefined();

    const result = await validator!.validate(42);
    expect(result.ok).toBe(false);
    const issues = (
        result as {
            ok: false;
            issues: { path: (string | number)[]; message: string }[];
        }
    ).issues;
    expect(issues.length).toBeGreaterThanOrEqual(1);
    // Each issue must have path (array) and message (string).
    for (const issue of issues) {
        expect(Array.isArray(issue.path)).toBe(true);
        expect(typeof issue.message).toBe('string');
    }
});

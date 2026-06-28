// Pure, zero-dependency structural diff (microdiff-style) used by drift detection.

export type DiffOp = 'create' | 'remove' | 'change';

export interface Diff {
    op: DiffOp;
    path: (string | number)[];
    value?: unknown; // present for 'create' and 'change'
    oldValue?: unknown; // present for 'remove' and 'change'
}

type Kind = 'object' | 'array' | 'null' | 'primitive';

function kindOf(v: unknown): Kind {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    if (typeof v === 'object') return 'object';
    return 'primitive';
}

function walk(
    before: unknown,
    after: unknown,
    path: (string | number)[],
    out: Diff[],
): void {
    const bk = kindOf(before);
    const ak = kindOf(after);

    if (bk === 'object' && ak === 'object') {
        // Both are plain objects (non-null, non-array).
        const bObj = before as Record<string, unknown>;
        const aObj = after as Record<string, unknown>;
        const bKeys = Object.keys(bObj);
        const aKeys = Object.keys(aObj);

        for (const key of bKeys) {
            const nextPath = [...path, key];
            if (!Object.prototype.hasOwnProperty.call(aObj, key)) {
                out.push({ op: 'remove', path: nextPath, oldValue: bObj[key] });
            } else {
                walk(bObj[key], aObj[key], nextPath, out);
            }
        }

        for (const key of aKeys) {
            if (!Object.prototype.hasOwnProperty.call(bObj, key)) {
                out.push({
                    op: 'create',
                    path: [...path, key],
                    value: aObj[key],
                });
            }
        }
        return;
    }

    if (bk === 'array' && ak === 'array') {
        const bArr = before as unknown[];
        const aArr = after as unknown[];
        const maxLen = Math.max(bArr.length, aArr.length);

        for (let i = 0; i < maxLen; i++) {
            const nextPath = [...path, i];
            if (i >= bArr.length) {
                out.push({ op: 'create', path: nextPath, value: aArr[i] });
            } else if (i >= aArr.length) {
                out.push({ op: 'remove', path: nextPath, oldValue: bArr[i] });
            } else {
                walk(bArr[i], aArr[i], nextPath, out);
            }
        }
        return;
    }

    // Leaf or mismatched kinds: emit a change if not equal.
    if (bk === ak && bk === 'primitive') {
        if (!Object.is(before, after)) {
            out.push({ op: 'change', path, oldValue: before, value: after });
        }
        return;
    }

    // null === null
    if (bk === 'null' && ak === 'null') {
        return;
    }

    // Mismatched kinds (object↔array, object↔primitive, null↔anything, etc.)
    // Always a change — do NOT recurse.
    out.push({ op: 'change', path, oldValue: before, value: after });
}

export function diff(before: unknown, after: unknown): Diff[] {
    const out: Diff[] = [];
    walk(before, after, [], out);
    return out;
}

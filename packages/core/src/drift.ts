// Leveled drift — schema-anchored, diff-based (ADR 0015).
//
// Drift is the diagnostic layer over consumer-contract validation. Validation owns the HARD signal:
// a missing-required field or an incompatible value throws (`validationErrors` → `invalid`/`error`).
// Drift owns the SOFT signal: with the response validated (coerced / defaulted / stripped) into a
// value that matches the contract, the *difference between the raw body and that validated value* is
// the drift — computed by the in-house structural `diff` (no snapshot, no schema introspection):
//
//   - `remove` (a key the schema stripped)              -> `undeclared` (a field you don't model)
//   - `change` (a value the schema coerced, "42"->42)   -> `coerced` (a hidden wire-type shift)
//   - `create` (a `.default()` fired, field was absent) -> `defaulted`
//
// Soft drift is always non-fatal (`warn` / `info` / `verbose`) — fatality is the schema's job. Levels
// are per-kind (defaults below), overridable/filterable via `DriftOptions.severity`, and any path can
// be acknowledged-and-silenced with `DriftOptions.ignore` without touching the typed schema.
import { type Diff, diff } from './diff';
import type {
    DriftFinding,
    DriftOptions,
    DriftSeverity,
    SoftDriftChange,
} from './types';
import { matchAny } from './util';
import type { Issue } from './validator';

/** Render a diff/issue path into the drift grammar: object keys join with `.`, an array index → `[]`. */
function renderPath(path: (string | number)[]): string {
    let out = '';
    for (const seg of path) {
        if (typeof seg === 'number') out += '[]';
        else out += out ? `.${seg}` : seg;
    }
    return out;
}

/** Render a diff path keeping concrete numeric indices (e.g. `items[3].x`). Used for `sample` on array summaries (ADR 0017). */
function renderConcretePath(path: (string | number)[]): string {
    let out = '';
    for (const seg of path) {
        if (typeof seg === 'number') out += `[${seg}]`;
        else out += out ? `.${seg}` : seg;
    }
    return out;
}

/**
 * A hard validation failure → `error` / `invalid` findings (one per issue). Not leveled or
 * suppressible: a contract violation fails the call. The engine throws on any of these.
 */
export function validationErrors(issues: Issue[]): DriftFinding[] {
    return issues.map((iss) => ({
        level: 'error',
        path: renderPath(iss.path),
        change: 'invalid',
        detail: iss.message,
    }));
}

const OP_CHANGE: Record<Diff['op'], SoftDriftChange> = {
    remove: 'undeclared',
    change: 'coerced',
    create: 'defaulted',
};

const DEFAULT_LEVEL: Record<SoftDriftChange, DriftSeverity> = {
    undeclared: 'info',
    coerced: 'warn',
    defaulted: 'verbose',
};

function kindOf(v: unknown): string {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
}

function detailFor(change: SoftDriftChange, d: Diff): string {
    if (change === 'coerced')
        return `${kindOf(d.oldValue)} -> ${kindOf(d.value)}`;
    if (change === 'undeclared')
        return `undeclared field (${kindOf(d.oldValue)})`;
    return 'default applied';
}

/**
 * Resolve {@link DriftOptions.severity} into the level each soft kind gets, plus an optional allowlist
 * of levels to surface. A single value / bare list is an allowlist over the per-kind defaults; a map
 * re-levels each kind (and surfaces all). See {@link DriftOptions.severity}.
 */
function resolveSeverity(severity: DriftOptions['severity']): {
    levelOf: (c: SoftDriftChange) => DriftSeverity;
    allow: Set<DriftSeverity> | null;
} {
    const byDefault = (c: SoftDriftChange): DriftSeverity => DEFAULT_LEVEL[c];
    if (severity === undefined) return { levelOf: byDefault, allow: null };
    if (typeof severity === 'string')
        return { levelOf: byDefault, allow: new Set([severity]) };
    if (Array.isArray(severity))
        return { levelOf: byDefault, allow: new Set(severity) };
    return { levelOf: (c) => severity[c] ?? DEFAULT_LEVEL[c], allow: null };
}

/**
 * Soft drift: classify the difference between the raw body and the validated value into leveled
 * findings. Array-element paths collapse to the `[]` grammar and dedupe (a stripped field on every
 * element is one finding), `ignore` suppresses acknowledged paths, and `severity` levels/filters.
 *
 * ADR 0017: uses group-then-summarize instead of first-wins dedup. Diffs are grouped by
 * `change|path`; array groups branch on detail homogeneity: homogeneous → one summary finding with
 * `all N elements: <detail>` and a `sample` coordinate; heterogeneous → one finding per distinct
 * detail variant (each with its own count and sample).
 */
export function classifyDiff(
    raw: unknown,
    validated: unknown,
    opts: DriftOptions = {},
): DriftFinding[] {
    const { levelOf, allow } = resolveSeverity(opts.severity);
    // P7: a bare `ignore` string is shorthand for a one-element list — normalize to the array the
    // `matchAny` matcher wants (mirrors how `severity` already widens `'warn' ≡ ['warn']`).
    const ignore =
        typeof opts.ignore === 'string' ? [opts.ignore] : opts.ignore;

    // Group diffs by `change|path` (the collapse key).
    const groups = new Map<
        string,
        { change: SoftDriftChange; path: string; diffs: Diff[] }
    >();
    for (const d of diff(raw, validated)) {
        const change = OP_CHANGE[d.op];
        const path = renderPath(d.path);
        const key = `${change}|${path}`;
        let group = groups.get(key);
        if (!group) {
            group = { change, path, diffs: [] };
            groups.set(key, group);
        }
        group.diffs.push(d);
    }

    const findings: DriftFinding[] = [];

    for (const { change, path, diffs } of groups.values()) {
        // Apply ignore (path-based) after grouping — all elements share the same [] path.
        if (matchAny(ignore, path)) continue;
        const level = levelOf(change);
        if (allow && !allow.has(level)) continue;

        const isArrayPath = path.includes('[]');

        if (!isArrayPath || diffs.length === 1) {
            // Scalar path, or a single diff (no collapse needed): emit one finding.
            // For scalar paths there is no `sample`; for a lone array diff, we still emit `sample`
            // so a consumer gets the concrete coordinate.
            const [d] = diffs;
            if (!d) continue; // a group always has ≥1 diff — this satisfies the type guard
            const detail = detailFor(change, d);
            if (isArrayPath) {
                findings.push({
                    level,
                    path,
                    change,
                    detail: `1 element: ${detail}`,
                    sample: renderConcretePath(d.path),
                });
            } else {
                findings.push({ level, path, change, detail });
            }
            continue;
        }

        // Array path with multiple diffs: group by detail string (the homogeneity test).
        const byDetail = new Map<string, Diff[]>();
        for (const d of diffs) {
            const detail = detailFor(change, d);
            const slot = byDetail.get(detail);
            if (slot) slot.push(d);
            else byDetail.set(detail, [d]);
        }

        // Homogeneous (one distinct detail) → one summary `all N elements: …`; heterogeneous → one
        // finding per distinct detail variant (`N element(s): …`). Either way `sample` is the concrete
        // index of the first occurrence, so the per-element value stays recoverable from `raw`.
        const homogeneous = byDetail.size === 1;
        for (const [detail, grp] of byDetail) {
            const [head] = grp;
            if (!head) continue; // a detail slot always has ≥1 diff — satisfies the type guard
            const label = homogeneous
                ? `all ${grp.length} elements`
                : `${grp.length} element${grp.length === 1 ? '' : 's'}`;
            findings.push({
                level,
                path,
                change,
                detail: `${label}: ${detail}`,
                sample: renderConcretePath(head.path),
            });
        }
    }

    return findings;
}

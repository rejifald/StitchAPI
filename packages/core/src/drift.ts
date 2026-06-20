// Leveled drift detection: compare a live payload's *shape* against a committed
// snapshot and classify each delta as error / warn / info.
//   - critical paths that go missing or change type  -> error
//   - watched / other paths that change              -> warn
//   - brand-new fields that appear                   -> info (or opts.onNew)
//
// The committed baseline stores the SHAPE ONLY — a sorted `{ path: type }` map under
// `{ version: 1, shape }` — not a representative body. That keeps a baseline tiny and
// payload-free (no response values, ids, or secrets land on disk), makes its diff
// stable, and serialises safely regardless of the value types in the body — a `bigint`
// (which `JSON.stringify` cannot serialise) becomes the string `"bigint"` in the shape,
// so drifting a payload that carries one no longer throws. A pre-shape (representative
// body) snapshot is still understood on read, so older baselines keep working.
import type { DriftFinding, DriftOptions } from './types';
import { dirnameOf, matchAny, nodeFs } from './util';

type Shape = Map<string, string>;

function typeOf(v: unknown): string {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
}

function shapeOf(value: unknown, base: string, out: Shape): Shape {
    if (base !== '') out.set(base, typeOf(value));
    const t = typeOf(value);
    if (t === 'object') {
        for (const k of Object.keys(value as Record<string, unknown>)) {
            shapeOf(
                (value as Record<string, unknown>)[k],
                base ? `${base}.${k}` : k,
                out,
            );
        }
    } else if (t === 'array' && (value as unknown[]).length > 0) {
        shapeOf((value as unknown[])[0], `${base}[]`, out);
    }
    return out;
}

const SNAPSHOT_VERSION = 1 as const;

/** The on-disk baseline: a versioned, payload-free shape map (sorted for stable diffs). */
interface ShapeSnapshot {
    version: typeof SNAPSHOT_VERSION;
    shape: Record<string, string>;
}

function isShapeSnapshot(s: unknown): s is ShapeSnapshot {
    return (
        typeof s === 'object' &&
        s !== null &&
        (s as { version?: unknown }).version === SNAPSHOT_VERSION &&
        typeof (s as { shape?: unknown }).shape === 'object' &&
        (s as { shape?: unknown }).shape !== null
    );
}

/** Serialise a shape Map to a plain object with keys sorted, so the committed file is stable. */
function serializeShape(shape: Shape): Record<string, string> {
    const out: Record<string, string> = {};
    const entries = [...shape.entries()].sort((a, b) =>
        a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
    );
    for (const [key, type] of entries) out[key] = type;
    return out;
}

/**
 * Resolve a loaded snapshot to its shape Map. A `version: 1` snapshot carries the shape
 * directly; a legacy representative-body snapshot (or any raw value) is shaped on read so
 * older baselines still compare correctly.
 */
function snapshotShape(snapshot: unknown): Shape {
    if (isShapeSnapshot(snapshot))
        return new Map(Object.entries(snapshot.shape));
    return shapeOf(snapshot, '', new Map());
}

const isDescendant = (parent: string, child: string): boolean =>
    child.startsWith(parent + '.') || child.startsWith(parent + '[');

/** Drop paths that are covered by an ancestor already in the same set (reduces noise). */
function topmost(paths: string[]): string[] {
    return paths.filter(
        (p) => !paths.some((q) => q !== p && isDescendant(q, p)),
    );
}

export function classifyDrift(
    actual: unknown,
    snapshot: unknown,
    opts: DriftOptions = {},
): DriftFinding[] {
    if (snapshot === undefined) return []; // first run = baseline
    const a = shapeOf(actual, '', new Map());
    const s = snapshotShape(snapshot);
    const findings: DriftFinding[] = [];

    const missing = topmost([...s.keys()].filter((p) => !a.has(p)));
    for (const path of missing) {
        findings.push({
            level: matchAny(opts.critical, path) ? 'error' : 'warn',
            path,
            change: 'missing',
            detail: `expected ${s.get(path)} no longer present`,
        });
    }

    const added = topmost([...a.keys()].filter((p) => !s.has(p)));
    for (const path of added) {
        findings.push({
            level: opts.onNew ?? 'info',
            path,
            change: 'new',
            detail: `new field (${a.get(path)})`,
        });
    }

    for (const [path, ta] of a) {
        const ts = s.get(path);
        if (ts && ts !== ta) {
            const nullable = ta === 'null' || ts === 'null';
            findings.push({
                level: matchAny(opts.critical, path) ? 'error' : 'warn',
                path,
                change: nullable ? 'nullable' : 'type-changed',
                detail: `${ts} -> ${ta}`,
            });
        }
    }
    return findings;
}

export function loadSnapshot(file: string): unknown {
    const fs = nodeFs();
    if (!fs) return undefined; // browser: snapshot files are a no-op
    try {
        if (!fs.existsSync(file)) return undefined;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return undefined;
    }
}

export function saveSnapshot(file: string, value: unknown): void {
    const fs = nodeFs();
    if (!fs) return; // browser: snapshot files are a no-op
    const snapshot: ShapeSnapshot = {
        version: SNAPSHOT_VERSION,
        shape: serializeShape(shapeOf(value, '', new Map())),
    };
    fs.mkdirSync(dirnameOf(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(snapshot, null, 2));
}

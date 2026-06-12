// Leveled drift detection: compare a live payload's *shape* against a committed
// snapshot and classify each delta as error / warn / info.
//   - critical paths that go missing or change type  -> error
//   - watched / other paths that change              -> warn
//   - brand-new fields that appear                   -> info (or opts.onNew)
// (For the spike the snapshot stores a representative body; a real impl would store
// just the shape/schema. The first run records the baseline and reports nothing.)
import type { DriftFinding, DriftOptions } from './types';
import { matchAny } from './util';

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

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
    const s = shapeOf(snapshot, '', new Map());
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
    try {
        if (!existsSync(file)) return undefined;
        return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        return undefined;
    }
}

export function saveSnapshot(file: string, value: unknown): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value, null, 2));
}

/**
 * Browser shim for `node:path` — B1 (browser `stitch` build).
 *
 * The bundler aliases `node:path` to this module. The reachable graph imports
 * exactly one symbol — `dirname` — from trace.ts:6 and drift.ts:12 (B1-SPIKE §1),
 * used only to compute a directory to `mkdirSync` before a JSONL write. Since the
 * fs shim makes those writes no-ops, `dirname` just needs to be a faithful pure
 * string function so nothing throws on the way there.
 */

/** POSIX-style `dirname` (regex, no fs) — sufficient for the trace/drift call sites. */
export function dirname(p: string): string {
    if (typeof p !== 'string' || p.length === 0) return '.';
    // Strip trailing slashes, then drop the last segment.
    const stripped = p.replace(/\/+$/, '');
    const idx = stripped.lastIndexOf('/');
    if (idx === -1) return '.';
    if (idx === 0) return '/';
    return stripped.slice(0, idx);
}

const _default = { dirname };
export default _default;

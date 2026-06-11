/**
 * Browser shim for `node:fs` — B1 (browser `stitch` build).
 *
 * The bundler aliases `node:fs` to this module. It stands in for the filesystem
 * surfaces the reachable graph imports (B1-SPIKE §1):
 *   - auth.ts:   existsSync, readFileSync   (keychain — secrets file)
 *   - trace.ts:  appendFileSync, mkdirSync  (JSONL trace sink)
 *   - drift.ts:  4 fns (existsSync, readFileSync, writeFileSync, mkdirSync)
 *
 * Browser policy (REQUIREMENTS §6 / SANDBOX §5.7): JSONL trace files are a no-op
 * (trace surfaces via StitchTraceEntry instead); the keychain secrets file does
 * not exist (`existsSync → false`), so `keychain()` falls through to its env read
 * — which the browser entry overrides with a demo value + notice anyway.
 *
 * Nothing here executes at module-evaluation time, and core never accesses any of
 * these at import time (B1-SPIKE §3), so the no-ops only matter when a Node path
 * is actually CALLED in shim mode.
 */

/** A trace/secrets file never exists in the browser sandbox. */
export function existsSync(_path: unknown): boolean {
    return false;
}

/** No secrets file in the browser — reading throws like a real ENOENT would. */
export function readFileSync(path: unknown, _enc?: unknown): string {
    throw Object.assign(
        new Error(
            `ENOENT: no filesystem in the StitchAPI browser sandbox (read ${String(path)})`,
        ),
        { code: 'ENOENT' },
    );
}

/** JSONL trace writes are no-ops in the browser; the trace is surfaced via StitchTraceEntry. */
export function writeFileSync(_path: unknown, _data: unknown, _opts?: unknown): void {
    /* no-op: see SANDBOX §5.7 */
}

/** JSONL append is a no-op in the browser. */
export function appendFileSync(_path: unknown, _data: unknown, _opts?: unknown): void {
    /* no-op: see SANDBOX §5.7 */
}

/** No directories to create in the browser. */
export function mkdirSync(_path: unknown, _opts?: unknown): void {
    /* no-op */
}

const _default = {
    existsSync,
    readFileSync,
    writeFileSync,
    appendFileSync,
    mkdirSync,
};
export default _default;

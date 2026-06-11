/**
 * Shim-notice collection channel — B1 (browser `stitch` build).
 *
 * When a Node-only surface runs shimmed in the browser, the runner (R1) must show
 * a "ran `keychain` shimmed" notice (SANDBOX §3, §5.7; runner contract `RunNotice`).
 * The shimmed surfaces in stitch-browser.ts emit a `RunNotice { kind:'shim', … }`
 * here; the runner drains them with `drainNotices()` after a run and puts them on
 * `RunResult.notices`.
 *
 * This adds NO new types — it reuses the FROZEN `RunNotice` shape from the runner
 * contract (re-declared structurally here to avoid a build-time dependency on the
 * React/runner module from inside the bundled Worker surface; see B1-README).
 * No contract was widened (B1 acceptance / SANDBOX §5.7).
 */

/** Structurally identical to the frozen `RunNotice` in contracts/runner.ts. */
export interface RunNotice {
    kind: 'shim' | 'info';
    surface?: string;
    message: string;
}

const buffer: RunNotice[] = [];

/** Record a shim notice (deduped per surface+message so a hot-path surface
 * called N times still shows one line). */
export function emitNotice(notice: RunNotice): void {
    const exists = buffer.some(
        (n) =>
            n.kind === notice.kind &&
            n.surface === notice.surface &&
            n.message === notice.message,
    );
    if (!exists) buffer.push(notice);
}

/** Convenience for the common shim case. */
export function emitShimNotice(surface: string, message: string): void {
    emitNotice({ kind: 'shim', surface, message });
}

/** Return collected notices and clear the buffer (call once per run, in the runner). */
export function drainNotices(): RunNotice[] {
    const out = buffer.slice();
    buffer.length = 0;
    return out;
}

/** Peek without clearing (tests / debugging). */
export function peekNotices(): readonly RunNotice[] {
    return buffer;
}

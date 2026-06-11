/**
 * D1 — The dispatcher runner (SANDBOX.md §2, §3, §8).
 *
 * `dispatchRunner(opts)` composes the browser runner (and, once Phase 3 ships it,
 * the server runner) into the single `CodeRunner` that `<StitchPlayground/>`
 * receives. On each `run`, it scans the snippet (D1 `scanSurface`) and routes:
 *
 *   - `tier:'server'` AND `opts.server` present → delegate to the server runner.
 *   - `tier:'server'` AND NO `opts.server` (pre-Phase-3) → delegate to the BROWSER
 *     runner AND ensure a `{kind:'shim'}` RunNotice is surfaced for each Node-only
 *     surface, so the UI shows "ran `keychain` shimmed" (SANDBOX.md §3; SEC-46).
 *     The browser runner already drains B1 shim notices; we only ADD a notice for a
 *     surface that was routed-but-not-already-noticed (no double-add).
 *   - `tier:'browser'` → delegate to the browser runner.
 *
 * It is itself a faithful `CodeRunner`: it NEVER rejects for snippet/engine errors
 * (it returns the delegate's `RunResult` verbatim, only augmenting `notices`), and
 * it passes `signal` / `timeoutMs` / `scope` straight through on `req`.
 *
 * Fail-safe (SEC-48): the dispatcher is the routing authority, so a scan that ever
 * throws is caught here and treated as the browser tier — never the isolate.
 */
import type { RunNotice } from '../component/runner';
import type { DispatchOpts, SurfaceScan } from './dispatch';
import type { CodeRunner, RunRequest, RunResult } from './runner';
import { scanSurface } from './scan-surface';

/** Build a shim notice for a Node-only surface routed to the browser. */
function shimNotice(surface: string): RunNotice {
    return {
        kind: 'shim',
        surface,
        message: `Ran \`${surface}\` shimmed — this Node-only surface is simulated in the browser.`,
    };
}

/**
 * Ensure each `surface` in `hits` has a `kind:'shim'` notice on the result,
 * without duplicating one the delegate already emitted. Returns a new RunResult
 * (the delegate's result is otherwise passed through untouched).
 */
function withShimNotices(result: RunResult, hits: string[]): RunResult {
    if (hits.length === 0) return result;

    const existing = result.notices ?? [];
    const alreadyNoticed = new Set(
        existing
            .filter((n) => n.kind === 'shim' && typeof n.surface === 'string')
            .map((n) => n.surface as string),
    );

    const added: RunNotice[] = [];
    for (const surface of hits) {
        if (!alreadyNoticed.has(surface)) {
            added.push(shimNotice(surface));
            alreadyNoticed.add(surface);
        }
    }
    if (added.length === 0) return result;

    return { ...result, notices: [...existing, ...added] };
}

class DispatchRunner implements CodeRunner {
    readonly id = 'dispatch';

    constructor(private readonly opts: DispatchOpts) {}

    async run(req: RunRequest): Promise<RunResult> {
        // Fail-safe routing (SEC-48): any scan failure → browser, never isolate.
        let scan: SurfaceScan;
        try {
            scan = scanSurface(req.code);
        } catch {
            scan = { tier: 'browser', nodeOnlyHits: [], ambiguous: true };
        }

        const { browser, server } = this.opts;

        // Server tier, and a real server runner exists → delegate as-is.
        if (scan.tier === 'server' && server) {
            return server.run(req);
        }

        // Server-classified but no server runner (pre-Phase-3): run on the
        // browser runner with the surface shimmed, and guarantee a shim notice
        // for each Node-only hit (SEC-46).
        if (scan.tier === 'server') {
            const result = await browser.run(req);
            return withShimNotices(result, scan.nodeOnlyHits);
        }

        // Browser tier (browser-safe, or the ambiguous safe default) → browser.
        return browser.run(req);
    }

    dispose(): void {
        this.opts.browser.dispose?.();
        this.opts.server?.dispose?.();
    }
}

/**
 * Compose a browser (+ optional server) runner into the dispatcher `CodeRunner`.
 * Signature frozen by C1; implemented in D1.
 */
export function dispatchRunner(opts: DispatchOpts): CodeRunner {
    return new DispatchRunner(opts);
}

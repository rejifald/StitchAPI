/**
 * Run a produced source file OFFLINE against sandbox-sim and check its shape.
 *
 * The produced module must export
 *   `export async function run(fetch: typeof globalThis.fetch): Promise<unknown>`
 * (the contract from runner/prebaked.ts and the live driver's instruction). We:
 *   1. write the source to a temp `.ts` file,
 *   2. dynamic-import it — the harness runs under `tsx`, whose ESM loader
 *      transpiles `.ts` on import, so NO bundler/esbuild dependency is needed,
 *   3. call its `run()` with a `fetch` shim backed by sandbox-sim's dispatch
 *      (`createFetchShim(allHandlers)`) — every HTTP call is intercepted in-process,
 *      so it is fully offline and deterministic,
 *   4. assert the task's `expectedShape` on the returned value.
 *
 * No network, no credentials, no global mutation: the shim is injected into the
 * produced module via its `run(fetch)` parameter, not by patching `globalThis`.
 */
// Deep relative imports: @stitchapi/sandbox-sim ships no package `exports` map, and
// both packages live in the same workspace. This is the same relative-path style
// sandbox-sim itself uses to reach the frozen contract.
import { createFetchShim } from '../../sandbox-sim/src/adapters/node';
import { allHandlers } from '../../sandbox-sim/src/handlers/index';
import type { EvalTask } from '../tasks/index';

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Temp modules are written UNDER this package (not os.tmpdir) so a bare
// `import 'stitchapi'` inside the produced source resolves against
// packages/eval-harness/node_modules — the workspace-linked `stitchapi`. A file
// in the OS temp dir would resolve from `/tmp` and never find it.
const PKG_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const SCRATCH_ROOT = path.join(PKG_ROOT, '.eval-tmp');

export interface RunResult {
    /** The module imported + exposed a usable `run` (transpiled without throwing). */
    compiled: boolean;
    /** `run()` executed and returned a value (no throw). */
    ran: boolean;
    /** `expectedShape(out)` passed. */
    shapeOk: boolean;
    /** First error encountered (compile/import or runtime), if any. */
    error?: string;
}

/** The shape we expect the produced module to expose. */
interface ProducedModule {
    run?: (f: typeof globalThis.fetch) => unknown | Promise<unknown>;
}

/** A fresh sandbox-sim fetch shim. `allHandlers` includes whatever endpoints the
 *  sandbox-sim package currently registers (e.g. /paged/users, /graphql). */
export function makeSandboxFetch(): typeof globalThis.fetch {
    return createFetchShim(allHandlers) as typeof globalThis.fetch;
}

/**
 * Score one produced source string against a task. Always resolves (never throws):
 * failures are reported in `error` with the relevant flag left false.
 *
 * `fetchImpl` defaults to a fresh sandbox-sim shim (`makeSandboxFetch()`). The
 * smoke tests pass an explicit shim so they stay self-contained even before the
 * sandbox-sim package registers the agreed endpoints (Agent B's handlers).
 */
export async function runProduced(
    source: string,
    task: EvalTask,
    fetchImpl: typeof globalThis.fetch = makeSandboxFetch(),
): Promise<RunResult> {
    const result: RunResult = { compiled: false, ran: false, shapeOk: false };

    // Unique temp file so concurrent cells don't collide; tsx imports it as ESM.
    // Lives under the package so `import 'stitchapi'` resolves (see SCRATCH_ROOT).
    await fs.mkdir(SCRATCH_ROOT, { recursive: true });
    const dir = await fs.mkdtemp(path.join(SCRATCH_ROOT, `${task.id}-`));
    const file = path.join(dir, 'client.ts');

    let mod: ProducedModule;
    try {
        await fs.writeFile(file, source, 'utf8');
        // The `/* @vite-ignore */`-style dynamic specifier is a runtime file URL;
        // tsx's loader transpiles the .ts on import.
        mod = (await import(pathToFileURL(file).href)) as ProducedModule;
        if (typeof mod.run !== 'function') {
            result.error = 'produced module does not export a run() function';
            return result;
        }
        result.compiled = true;
    } catch (err) {
        result.error = `import/compile failed: ${errText(err)}`;
        return result;
    } finally {
        // Best-effort cleanup; the import has already read the file by here on
        // success, and on failure there is nothing to keep.
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }

    let out: unknown;
    try {
        out = await mod.run(fetchImpl);
        result.ran = true;
    } catch (err) {
        result.error = `run() threw: ${errText(err)}`;
        return result;
    }

    try {
        result.shapeOk = task.expectedShape(out) === true;
        if (!result.shapeOk) {
            result.error = `expectedShape rejected: ${preview(out)}`;
        }
    } catch (err) {
        result.error = `expectedShape threw: ${errText(err)}`;
    }
    return result;
}

function errText(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
}

function preview(v: unknown): string {
    try {
        return JSON.stringify(v).slice(0, 200);
    } catch {
        return String(v).slice(0, 200);
    }
}

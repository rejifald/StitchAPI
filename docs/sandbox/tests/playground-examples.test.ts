/**
 * Playground preset regression guard — NODE tier.
 *
 * Runs every preset the playground ships (`PLAYGROUND_EXAMPLES`, the Complete /
 * Simple / Validated tabs) through the REAL built node Worker — the same bundle
 * `node-runner.ts` and the `stitch-sandbox` MCP server spawn — and fails if any
 * of them errors. The presets are the first thing a visitor runs and the surface
 * an agent gets from `run_in_sandbox`, so "the shipped example still executes"
 * is a contract, not a nice-to-have.
 *
 * It also asserts the whole `PLAYGROUND_SURFACE_NAMES` allow-list is bound in
 * the snippet scope. Running the presets alone only covers the names those three
 * snippets happen to touch; the failure mode here is a re-export that silently
 * resolves to nothing (see playground-surface.ts for why esbuild can't catch it),
 * and that can hit any name in the surface.
 *
 * The browser tier gets the same two checks against ITS bundle in
 * apps/docs/e2e/playground-examples.spec.ts — the two Workers are built from
 * different entries (worker-main.node.ts vs worker-main.ts → stitch-browser.ts),
 * so neither run substitutes for the other.
 *
 * Requires `dist/node-worker.mjs` — `pnpm --filter @stitchapi/sandbox test:smoke`
 * builds it first.
 *
 * Run with:  node --import tsx docs/sandbox/tests/playground-examples.test.ts
 */
import { PLAYGROUND_EXAMPLES } from '../../../apps/docs/app/(home)/playground/playground-examples';
import type { RunResult } from '../component/runner';
import {
    type WorkerLike,
    makeBrowserWorkerRunner,
} from '../runtime/browser-runner';
import { PLAYGROUND_SURFACE_NAMES } from '../runtime/playground-surface';

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker as ThreadWorkerImpl } from 'node:worker_threads';

/* -------------------------------------------------------------------------- */
/*  Tiny assertion harness (mirrors browser-runner.test.ts convention)        */
/* -------------------------------------------------------------------------- */

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail?: unknown): void {
    if (condition) {
        console.log(`  PASS  ${label}`);
        passed++;
    } else {
        console.error(`  FAIL  ${label}`, detail ?? '');
        failed++;
    }
}

/* -------------------------------------------------------------------------- */
/*  The runner: the REAL node worker bundle, a fresh thread per run           */
/* -------------------------------------------------------------------------- */

const __dirname = dirname(fileURLToPath(import.meta.url));
const NODE_WORKER_URL = resolve(__dirname, '../dist/node-worker.mjs');

/** `node:worker_threads` Worker as the runner's `WorkerLike` (see node-runner.ts). */
class ThreadWorker implements WorkerLike {
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: ((err: unknown) => void) | null = null;
    private readonly w: ThreadWorkerImpl;
    constructor(url: string) {
        this.w = new ThreadWorkerImpl(url);
        this.w.on('message', (data) => this.onmessage?.({ data }));
        this.w.on('error', (err) => this.onerror?.(err));
    }
    postMessage(message: unknown): void {
        this.w.postMessage(message);
    }
    terminate(): void {
        void this.w.terminate();
    }
}

// The presets make several simulated round-trips (the Complete tour retries a
// deliberately flaky route), so they need more headroom than the 5 s default.
const TIMEOUT_MS = 20_000;

const runner = makeBrowserWorkerRunner({
    workerFactory: () => new ThreadWorker(NODE_WORKER_URL),
    defaultTimeoutMs: TIMEOUT_MS,
});

const run = (code: string): Promise<RunResult> =>
    runner.run({ code, timeoutMs: TIMEOUT_MS });

/** Compact one-line failure detail — the whole stack is noise in a smoke log. */
function describeError(result: RunResult): string {
    const e = result.error;
    if (!e) return '(no error)';
    const where = e.line !== undefined ? ` at line ${e.line}` : '';
    return `${e.phase}/${e.reason ?? 'unknown'}: ${e.name}: ${e.message}${where}`;
}

/* -------------------------------------------------------------------------- */
/*  Checks                                                                    */
/* -------------------------------------------------------------------------- */

async function runTests(): Promise<void> {
    if (!existsSync(NODE_WORKER_URL)) {
        console.error(
            `missing ${NODE_WORKER_URL} — run \`pnpm --filter @stitchapi/sandbox run build:mcp\` first.`,
        );
        process.exit(2);
    }

    console.log('\nPlayground presets — node tier\n');

    /* === 1. Every shipped preset runs clean ================================ */

    assert(
        'PLAYGROUND_EXAMPLES is non-empty',
        PLAYGROUND_EXAMPLES.length > 0,
        PLAYGROUND_EXAMPLES.length,
    );

    for (const example of PLAYGROUND_EXAMPLES) {
        const result = await run(example.code);

        assert(
            `preset '${example.id}' runs without error`,
            result.error === undefined,
            describeError(result),
        );

        // A preset that errors mid-way still returns the logs it managed to
        // print, so "no error" alone would pass a snippet that silently did
        // nothing at all. Every preset ends in a console.log.
        assert(
            `preset '${example.id}' produced console output`,
            result.logs.length > 0,
            result.logs.length,
        );
    }

    /* === 2. The whole surface allow-list is bound ========================== */

    // Reported from INSIDE the worker: the scope is bound as function parameters
    // there, so `typeof <name>` is the only way to see what a snippet sees.
    const probe = `return { ${PLAYGROUND_SURFACE_NAMES.map(
        (name) => `${name}: typeof ${name}`,
    ).join(', ')} };`;
    const probeResult = await run(probe);

    assert(
        'surface probe ran',
        probeResult.error === undefined,
        describeError(probeResult),
    );

    const surface = (probeResult.value ?? {}) as Record<string, string>;
    const missing = PLAYGROUND_SURFACE_NAMES.filter(
        (name) => surface[name] !== 'function',
    );
    assert(
        `all ${PLAYGROUND_SURFACE_NAMES.length} PLAYGROUND_SURFACE_NAMES are bound in the snippet scope`,
        missing.length === 0,
        missing.length > 0
            ? `not a function: ${missing
                  .map((n) => `${n} (${surface[n] ?? 'undefined'})`)
                  .join(', ')}`
            : '',
    );

    /* === Summary =========================================================== */

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed === 0) {
        console.log('PLAYGROUND PRESETS OK');
    } else {
        console.error('PLAYGROUND PRESETS FAILED');
        process.exit(1);
    }
}

runTests().catch((err) => {
    console.error('Unexpected test runner error:', err);
    process.exit(1);
});

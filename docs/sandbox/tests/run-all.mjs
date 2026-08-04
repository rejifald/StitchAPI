/**
 * T-α suite runner — executes every *.test.ts smoke in the repo via tsx
 * and prints an aggregate "N/M suites passed" line.
 *
 * Exits 0 when all suites pass; exits 1 if any fail.
 *
 * Run with:  pnpm --filter @stitchapi/sandbox test:smoke
 *
 * Prefer that script over calling this file directly — the playground-preset
 * suite drives the BUILT node Worker (dist/node-worker.mjs) and `test:smoke`
 * runs `build:mcp` first. (It exits 2 with a build hint if the bundle is absent.)
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../../..'); // repo root

// ---------------------------------------------------------------------------
// Hard-coded list of all known smoke test files (ordered by task tier).
// The paths are relative to the repo root.
// ---------------------------------------------------------------------------

/** @type {string[]} */
const SUITES = [
    // S2 — errors/status handlers
    'packages/sandbox-sim/src/handlers/errors-status.test.ts',
    // S3 — streaming/LLM handlers
    'packages/sandbox-sim/src/handlers/streaming-llm.test.ts',
    // S4 — auth/resilience handlers
    'packages/sandbox-sim/src/handlers/auth-resilience.test.ts',
    // F1 — handler registration
    'packages/sandbox-sim/src/handlers/registration.test.ts',
    // S5 — dispatch core + node adapter
    'packages/sandbox-sim/src/dispatch.test.ts',
    // D1 — scanSurface + dispatchRunner
    'docs/sandbox/contracts/dispatch.test.ts',
    // R2 — transpile smoke
    'docs/sandbox/runtime/transpile.test.ts',
    // R1 — browser-worker runner harness (worker_threads proofs)
    'docs/sandbox/runtime/browser-runner.test.ts',
    // A2 — trace-collector: real stitch events → DAG entries
    'docs/sandbox/runtime/trace-collector.test.ts',
    // U1 — output-format helpers
    'docs/sandbox/component/output-format.test.ts',
    // T-α — integration over REAL sim + dispatch
    'docs/sandbox/tests/integration.test.ts',
    // Playground presets + surface allow-list, over the BUILT node Worker
    // (dist/node-worker.mjs — `test:smoke` builds it first).
    'docs/sandbox/tests/playground-examples.test.ts',
];

// ---------------------------------------------------------------------------
// Run each suite: spawn `node --import tsx <file>`, capture exit + combined output.
// tsx is a pinned devDependency (workspace root), so this never reaches the network —
// `npx tsx` would try to *download* tsx when it isn't hoisted to a runnable bin.
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

/** @type {Array<{ file: string; ok: boolean; output: string }>} */
const results = [];

for (const relPath of SUITES) {
    const absPath = resolve(root, relPath);
    process.stdout.write(`  running ${relPath} … `);

    const result = spawnSync('node', ['--import', 'tsx', absPath], {
        encoding: 'utf8',
        cwd: root,
        // Give each suite up to 30 s — browser-runner.test.ts uses real threads
        // with timeouts up to 500 ms per test; 30 s is a safe ceiling.
        timeout: 30_000,
    });

    const ok = result.status === 0 && result.error == null;
    const output = (result.stdout ?? '') + (result.stderr ?? '');

    if (ok) {
        passed++;
        process.stdout.write('PASS\n');
    } else {
        failed++;
        process.stdout.write('FAIL\n');
    }

    results.push({ file: relPath, ok, output });
}

// ---------------------------------------------------------------------------
// Aggregate report
// ---------------------------------------------------------------------------

console.log('');
console.log(`${passed}/${passed + failed} suites passed`);

if (failed > 0) {
    console.error('');
    console.error('--- FAILED SUITES ---');
    for (const r of results) {
        if (!r.ok) {
            console.error(`\n  ${r.file}:`);
            // Indent each output line for readability
            for (const line of r.output.split('\n')) {
                console.error(`    ${line}`);
            }
        }
    }
    process.exit(1);
}

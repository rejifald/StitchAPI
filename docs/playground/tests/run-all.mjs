/**
 * T-α suite runner — executes every *.test.ts smoke in the repo via tsx
 * and prints an aggregate "N/M suites passed" line.
 *
 * Exits 0 when all suites pass; exits 1 if any fail.
 *
 * Run with:  node docs/playground/tests/run-all.mjs
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
    'docs/playground/contracts/dispatch.test.ts',
    // R2 — transpile smoke
    'docs/playground/runtime/transpile.test.ts',
    // R1 — browser-worker runner harness (worker_threads proofs)
    'docs/playground/runtime/browser-runner.test.ts',
    // U1 — output-format helpers
    'docs/playground/component/output-format.test.ts',
    // T-α — integration over REAL sim + dispatch
    'docs/playground/tests/integration.test.ts',
];

// ---------------------------------------------------------------------------
// Run each suite: spawn npx tsx <file>, capture exit code + combined output.
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

/** @type {Array<{ file: string; ok: boolean; output: string }>} */
const results = [];

for (const relPath of SUITES) {
    const absPath = resolve(root, relPath);
    process.stdout.write(`  running ${relPath} … `);

    const result = spawnSync('npx', ['-y', 'tsx', absPath], {
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

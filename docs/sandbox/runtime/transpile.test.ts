/**
 * R2 smoke tests — transpile.ts
 *
 * These tests use the `_transform` injection escape-hatch so neither Sucrase
 * nor @babel/standalone needs to be installed.  They exercise:
 *
 *   (a) A TS type annotation is erased (happy path via injected fn).
 *   (b) A syntax error maps to `{ error: { phase:'transpile', ... } }` and
 *       does NOT throw.
 *
 * Run with:  npx -y tsx docs/sandbox/runtime/transpile.test.ts
 */
import type { RunError } from '../component/runner';
import { transpile } from './transpile';

/* -------------------------------------------------------------------------- */
/*  Minimal assertion helpers (no test framework required)                    */
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

function assertDeepEqual<T>(label: string, actual: T, expected: T): void {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    assert(label, ok, { actual, expected });
}

/* -------------------------------------------------------------------------- */
/*  Fake transforms — simulate what Sucrase/Babel would do                   */
/* -------------------------------------------------------------------------- */

/**
 * Naively erases `: <Type>` annotations and `<T>` generic markers so we can
 * test the happy path without the real transpiler.
 */
function fakeErase(code: string): string {
    // Remove inline type annotations: `const x: number =` → `const x =`
    return code.replace(/:\s*\w+(\[\])?(\s*[=,;)}\]])/g, '$2');
}

/** Always throws, simulating a snippet syntax error. */
function fakeSyntaxError(code: string): string {
    const err = Object.assign(
        new SyntaxError(`Unexpected token (3:5) [fake]`),
        {
            line: 3,
            col: 5,
        },
    );
    throw err;
}

/* -------------------------------------------------------------------------- */
/*  Tests                                                                     */
/* -------------------------------------------------------------------------- */

async function runTests(): Promise<void> {
    console.log('\n--- R2 transpile smoke tests ---\n');

    /* (a) TS annotation erasure — happy path -------------------------------- */
    {
        const tsCode = `const n: number = 42;\nconsole.log(n);`;

        const result = await transpile(tsCode, { _transform: fakeErase });

        assert('(a) result has .js (no error)', 'js' in result, result);
        if ('js' in result) {
            assert(
                '(a) type annotation erased from output',
                !result.js.includes(': number'),
                result.js,
            );
            assert(
                '(a) value preserved in output',
                result.js.includes('42'),
                result.js,
            );
        }
    }

    /* (b) Syntax error → { error } and does NOT throw ---------------------- */
    {
        const badCode = `const x = {`;

        let threw = false;
        let result: Awaited<ReturnType<typeof transpile>> | undefined;
        try {
            result = await transpile(badCode, { _transform: fakeSyntaxError });
        } catch {
            threw = true;
        }

        assert('(b) transpile does NOT throw on syntax error', !threw);
        assert(
            '(b) result has .error field',
            result !== undefined && 'error' in result,
            result,
        );

        if (result && 'error' in result) {
            const err: RunError = result.error;
            assert(
                "(b) error.phase === 'transpile'",
                err.phase === 'transpile',
                err.phase,
            );
            assert(
                '(b) error.name is set',
                typeof err.name === 'string' && err.name.length > 0,
                err.name,
            );
            assert(
                '(b) error.message is set',
                typeof err.message === 'string' && err.message.length > 0,
                err.message,
            );
            assert(
                '(b) error.line is 3 (from thrown error)',
                err.line === 3,
                err.line,
            );
            assert(
                '(b) error.column is 5 (from thrown error col)',
                err.column === 5,
                err.column,
            );
        }
    }

    /* (c) Babel option path also returns { error } on syntax error ---------- */
    {
        const badCode = `function broken(`;

        let threw = false;
        let result: Awaited<ReturnType<typeof transpile>> | undefined;
        try {
            // Force the babel code path but still inject the fake transform.
            // We can't easily test _transform + transpiler:'babel' simultaneously
            // since _transform short-circuits — test the Sucrase path with column
            // field variation instead.
            result = await transpile(badCode, {
                _transform: (src) => {
                    const err = Object.assign(new SyntaxError(`bad token`), {
                        line: 1,
                        column: 16, // Babel uses .column not .col
                    });
                    throw err;
                },
            });
        } catch {
            threw = true;
        }

        assert('(c) transpile does NOT throw (column variant)', !threw);
        if (result && 'error' in result) {
            assert(
                "(c) error.phase === 'transpile'",
                result.error.phase === 'transpile',
                result.error.phase,
            );
            assert(
                '(c) error.column picked from .column field',
                result.error.column === 16,
                result.error.column,
            );
        }
    }

    /* (d) ESM imports are REBOUND to __stitchImport, never `require` ---------- */
    {
        // Identity transform: exercise the shared import-rebinding pass in
        // isolation (no real transpiler needed) on already-"transpiled" JS.
        const id = (s: string): string => s;

        const named = await transpile(
            `import { stitch, drift } from 'stitchapi';\nstitch();`,
            { _transform: id },
        );
        assert('(d) named import → has .js', 'js' in named, named);
        if ('js' in named) {
            assert(
                '(d) rewrites to __stitchImport (no require)',
                named.js.includes('__stitchImport("stitchapi")') &&
                    !named.js.includes('require('),
                named.js,
            );
            assert(
                '(d) destructures the named bindings',
                /const \{ stitch, drift \} =/.test(named.js),
                named.js,
            );
        }

        const aliased = await transpile(`import { z as zod } from 'zod';`, {
            _transform: id,
        });
        if ('js' in aliased) {
            assert(
                '(d) aliased import → `z: zod`',
                /const \{ z: zod \} = __stitchImport\("zod"\);/.test(
                    aliased.js,
                ),
                aliased.js,
            );
        }

        const ns = await transpile(`import * as z from 'zod';`, {
            _transform: id,
        });
        if ('js' in ns) {
            assert(
                '(d) namespace import → whole registry entry',
                /const z = __stitchImport\("zod"\);/.test(ns.js),
                ns.js,
            );
        }

        const side = await transpile(`import 'stitchapi';`, { _transform: id });
        if ('js' in side) {
            assert(
                '(d) side-effect import → bare registry call',
                /__stitchImport\("stitchapi"\);/.test(side.js),
                side.js,
            );
        }
    }

    /* (e) dynamic import() is rejected (SEC-31 module-loader escape) ---------- */
    {
        const dyn = await transpile(`const m = await import('node:fs');`, {
            _transform: (s) => s,
        });
        assert('(e) dynamic import → { error }', 'error' in dyn, dyn);
        if ('error' in dyn) {
            assert(
                "(e) error.phase === 'transpile'",
                dyn.error.phase === 'transpile',
                dyn.error,
            );
        }
    }

    /* Summary --------------------------------------------------------------- */
    console.log(`\n${passed} passed, ${failed} failed\n`);

    if (failed === 0) {
        console.log('R2 OK');
    } else {
        console.error('R2 FAILED');
        process.exit(1);
    }
}

runTests().catch((err) => {
    console.error('Unexpected test runner error:', err);
    process.exit(1);
});

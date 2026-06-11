/**
 * R2 — Transpile step for the browser runner pipeline (SANDBOX.md §5 step 1).
 *
 * Strips TypeScript + JSX (erasure only, no type-checking — REQUIREMENTS.md §5)
 * and returns runnable JS.  Both transpilers are lazy-loaded so prose pages pay
 * nothing (NFR1).
 *
 * Primary:  Sucrase  (`transform(code, { transforms: ['typescript','jsx','imports'] })`)
 * Fallback: @babel/standalone  (if Sucrase fails to *load* — engine/internal error)
 *
 * Transpile *syntax* errors from the snippet are returned as
 * `{ error: RunError(phase:'transpile') }` — they never throw (FR6, CodeRunner contract).
 */

import type { RunError } from '../component/runner';

/* -------------------------------------------------------------------------- */
/*  Public API                                                                 */
/* -------------------------------------------------------------------------- */

export interface TranspileOptions {
    /**
     * Which transpiler to prefer.  Defaults to `'sucrase'`.
     * Pass `'babel'` to skip Sucrase and go straight to @babel/standalone —
     * useful for callers that already know Sucrase failed to load (NFR4).
     */
    transpiler?: 'sucrase' | 'babel';

    /**
     * Escape hatch for unit-testing: inject a synchronous transform function
     * so the test never needs the real transpiler packages installed.
     * When provided, `transpiler` is ignored and the injected fn is called
     * directly.  The fn must throw on syntax errors (just like the real libs).
     */
    _transform?: (code: string) => string;
}

export type TranspileResult = { js: string } | { error: RunError };

/**
 * Transpile `code` (TS + JSX) to runnable JS.
 *
 * - Returns `{ js }` on success.
 * - Returns `{ error }` on any transpile failure — never throws for snippet
 *   syntax errors.
 * - May throw only on truly unrecoverable harness bugs (e.g. neither transpiler
 *   could be dynamically imported and the injected fallback is absent) — callers
 *   that wish to be bullet-proof should catch and map to `reason:'internal'`.
 */
export async function transpile(
    code: string,
    opts: TranspileOptions = {},
): Promise<TranspileResult> {
    const { transpiler = 'sucrase', _transform } = opts;

    /* -- injected transform (unit-test path) -------------------------------- */
    if (_transform) {
        return applyTransform(code, _transform);
    }

    /* -- Babel-first shortcut (caller opted in) ----------------------------- */
    if (transpiler === 'babel') {
        return transpileWithBabel(code);
    }

    /* -- Default: Sucrase, with Babel as load-failure fallback -------------- */
    return transpileWithSucrase(code).catch((loadErr) => {
        // Only fall back when Sucrase itself failed to *load* (internal error).
        // A syntax error from the snippet is already returned as { error } by
        // transpileWithSucrase and will never reach here.
        if (loadErr instanceof TranspilerLoadError) {
            return transpileWithBabel(code);
        }
        throw loadErr;
    });
}

/* -------------------------------------------------------------------------- */
/*  Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

/** Sentinel so we can distinguish "dep didn't load" from "snippet is broken". */
class TranspilerLoadError extends Error {
    constructor(cause: unknown) {
        super(
            'Failed to load transpiler (engine/internal error)',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { cause } as any,
        );
        this.name = 'TranspilerLoadError';
    }
}

/**
 * Run `transformFn(code)`, catch syntax errors from the snippet, and map them
 * to a `RunError` with `phase:'transpile'`.  This is the shared "apply +
 * error-map" logic used by all paths.
 */
function applyTransform(
    code: string,
    transformFn: (code: string) => string,
): TranspileResult {
    try {
        const js = transformFn(code);
        return { js };
    } catch (err) {
        return { error: mapToRunError(err) };
    }
}

/** Map any thrown value to a `RunError` with `phase:'transpile'`. */
function mapToRunError(err: unknown): RunError {
    if (err instanceof Error) {
        const e = err as Error & { line?: number; col?: number; column?: number };
        return {
            name: e.name || 'TranspileError',
            message: e.message,
            stack: e.stack,
            phase: 'transpile',
            // Both Sucrase and Babel expose line/col(umn) on the error object.
            line: typeof e.line === 'number' ? e.line : undefined,
            column:
                typeof e.col === 'number'
                    ? e.col
                    : typeof e.column === 'number'
                      ? e.column
                      : undefined,
        };
    }
    return {
        name: 'TranspileError',
        message: String(err),
        phase: 'transpile',
    };
}

/* -- Sucrase ---------------------------------------------------------------- */

async function transpileWithSucrase(code: string): Promise<TranspileResult> {
    // Lazy-load so prose pages pay nothing (NFR1).
    let transform: typeof import('sucrase').transform;
    try {
        const sucrase = await import('sucrase');
        transform = sucrase.transform;
    } catch (e) {
        throw new TranspilerLoadError(e);
    }

    return applyTransform(code, (src) =>
        transform(src, {
            transforms: ['typescript', 'jsx', 'imports'],
        }).code,
    );
}

/* -- @babel/standalone ------------------------------------------------------
 * Babel's browser build is a UMD that exposes a global `Babel`.  When loaded
 * as an ES module via dynamic import, we get its default export or the named
 * `transform` export depending on the bundler.  We handle both shapes.
 * -------------------------------------------------------------------------*/

async function transpileWithBabel(code: string): Promise<TranspileResult> {
    // Lazy-load so prose pages pay nothing (NFR1).
    let babelTransform: typeof import('@babel/standalone').transform;
    try {
        // @babel/standalone exposes `transform` as a named export (and on
        // the default export when accessed via a bundler).
        const babel = await import('@babel/standalone');
        babelTransform =
            // named export (ESM build / bundler interop)
            babel.transform ??
            // default export fallback (UMD-in-ESM wrapper)
            (
                babel as unknown as {
                    default: { transform: typeof babelTransform };
                }
            ).default?.transform;

        if (typeof babelTransform !== 'function') {
            throw new Error('Babel transform function not found on module');
        }
    } catch (e) {
        throw new TranspilerLoadError(e);
    }

    return applyTransform(code, (src) => {
        const result = babelTransform(src, {
            presets: ['typescript', 'react'],
            filename: 'snippet.tsx',
        });
        if (!result.code) {
            throw new Error('Babel produced no output');
        }
        return result.code;
    });
}

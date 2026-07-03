/**
 * R2 — Transpile step for the browser runner pipeline (SANDBOX.md §5 step 1).
 *
 * Strips TypeScript + JSX (erasure only, no type-checking — REQUIREMENTS.md §5)
 * and returns runnable JS.  Both transpilers are lazy-loaded so prose pages pay
 * nothing (NFR1).
 *
 * Primary:  Sucrase  (`transform(code, { transforms: ['typescript','jsx'] })`)
 * Fallback: @babel/standalone  (if Sucrase fails to *load* — engine/internal error)
 *
 * NOTE the transform list intentionally OMITS Sucrase's `imports` transform: the
 * snippet runs as an `AsyncFunction` body where every name it may use is injected
 * as a parameter and there is NO module loader (`require` is `undefined`, SEC-31).
 * So an `import` must be *erased* and rebound to the injected scope, never
 * rewritten to `require(...)` (that is the "require is not a function" crash). A
 * shared final pass ({@link rebindModuleImports}) rebinds each ESM `import` to the
 * curated in-worker registry (`__stitchImport`, wired by worker-entry) and rejects
 * dynamic `import()` (an SEC-31 module-loader escape).
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
    const base = await transpileBase(code, opts);
    // Type/JSX erasure done — now erase & rebind ESM imports to the injected
    // scope (shared across every transpiler path, incl. the unit-test hatch).
    return 'error' in base ? base : rebindModuleImports(base.js);
}

/** Erase TS + JSX only. Imports are handled downstream by rebindModuleImports. */
async function transpileBase(
    code: string,
    opts: TranspileOptions,
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
        const e = err as Error & {
            line?: number;
            col?: number;
            column?: number;
        };
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

    return applyTransform(
        code,
        (src) =>
            // No `imports` transform — see the file header: imports are erased and
            // rebound to the injected scope by rebindModuleImports, not rewritten
            // to `require(...)`. Sucrase's typescript pass already elides
            // `import type` and inline `type` specifiers, leaving only value
            // imports for the rebinder.
            transform(src, {
                transforms: ['typescript', 'jsx'],
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
        const babel = await import(
            /* webpackIgnore: true */ '@babel/standalone'
        );
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

/* -- ESM import rebinding ---------------------------------------------------
 * The snippet runs as an `AsyncFunction` body: its identifiers resolve to the
 * scope names worker-entry injects (`stitch`, `bearer`, …), and there is no
 * module loader — `require` is `undefined` (SEC-31). This pass takes the
 * type/JSX-erased JS and:
 *   1. rejects dynamic `import()` (it would reach a real loader in the Worker),
 *   2. rewrites each static `import` into `const … = __stitchImport('<spec>')`
 *      destructuring, and
 *   3. strips `export` (a snippet returns its last value; exports never ran).
 * `__stitchImport` is the curated registry worker-entry binds into scope; only
 * allow-listed specifiers (`stitchapi`, `zod`) resolve, everything else throws.
 * -------------------------------------------------------------------------*/

/** The scope-injected module registry a rebound import calls. */
const IMPORT_REGISTRY = '__stitchImport';

/**
 * Return a copy of `src` with comment bodies and string/template-literal contents
 * replaced by same-length blanks, so a keyword scan (the dynamic-`import()` gate)
 * sees code structure only — never trivia or literal text.
 *
 * A single left-to-right pass tracks whether we are inside a line comment, block
 * comment, or a `'`/`"`/`` ` `` string, and blanks characters accordingly
 * (newlines are preserved so line/column stay meaningful). This is a lexical
 * approximation — deliberately conservative: it does NOT parse template
 * `${…}` substitutions (their contents are blanked too, which is safe for a
 * reject-only gate) and does NOT try to distinguish a regex literal from
 * division. That is acceptable because the ONLY consumer is a coarse "is there a
 * dynamic `import(` anywhere in real code" check; over-blanking a regex body can
 * at worst hide an `import(` that lived inside a regex literal, which is not
 * valid dynamic-import syntax anyway.
 *
 * Exported for the transpile smoke test (the comment-bypass regression asserts
 * the neutralizer collapses `import/**\/(` to a detectable `import(`).
 */
export function neutralizeCommentsAndStrings(src: string): string {
    let out = '';
    let i = 0;
    const n = src.length;
    type Mode = 'code' | 'line' | 'block' | 'squote' | 'dquote' | 'template';
    let mode: Mode = 'code';

    const blank = (ch: string): string => (ch === '\n' ? '\n' : ' ');

    while (i < n) {
        const ch = src[i];
        const next = i + 1 < n ? src[i + 1] : '';

        if (mode === 'code') {
            if (ch === '/' && next === '/') {
                mode = 'line';
                out += '  ';
                i += 2;
            } else if (ch === '/' && next === '*') {
                mode = 'block';
                out += '  ';
                i += 2;
            } else if (ch === "'") {
                mode = 'squote';
                out += ' ';
                i += 1;
            } else if (ch === '"') {
                mode = 'dquote';
                out += ' ';
                i += 1;
            } else if (ch === '`') {
                mode = 'template';
                out += ' ';
                i += 1;
            } else {
                out += ch;
                i += 1;
            }
            continue;
        }

        if (mode === 'line') {
            if (ch === '\n') {
                mode = 'code';
                out += '\n';
            } else {
                out += ' ';
            }
            i += 1;
            continue;
        }

        if (mode === 'block') {
            if (ch === '*' && next === '/') {
                mode = 'code';
                out += '  ';
                i += 2;
            } else {
                out += blank(ch);
                i += 1;
            }
            continue;
        }

        // String / template modes: blank contents, honor `\`-escapes, close on the
        // matching quote (templates also close on backtick — `${}` is blanked too).
        const quote = mode === 'squote' ? "'" : mode === 'dquote' ? '"' : '`';
        if (ch === '\\') {
            // Blank the backslash and the escaped char (keep newlines).
            out += ' ';
            if (next) out += blank(next);
            i += 2;
            continue;
        }
        if (ch === quote) {
            mode = 'code';
            out += ' ';
            i += 1;
            continue;
        }
        out += blank(ch);
        i += 1;
    }

    return out;
}

function rebindModuleImports(js: string): TranspileResult {
    // (1) Reject dynamic import() before the static rewrite strips `import`
    // keywords. `import(` (not a `.import(` member) is always the dynamic form.
    //
    // We test a COMMENT- and STRING-NEUTRALIZED copy, not the raw `js`. Sucrase
    // preserves comments, so a bare post-transpile regex with `\s*` between
    // `import` and `(` is bypassable by wedging a comment in the gap
    // (`import/**/('https://evil/m.js')` — SEC-31/SEC-04 escape). Neutralizing
    // comments (and string/template bodies, so an `import(` inside a literal can't
    // false-positive) makes the gate robust regardless of intervening trivia.
    const scannable = neutralizeCommentsAndStrings(js);
    if (/(^|[^.\w])import\s*\(/.test(scannable)) {
        return {
            error: {
                name: 'UnsupportedImportError',
                message:
                    "Dynamic import() isn't available in the playground. " +
                    "Everything from 'stitchapi' is already in scope; use a static " +
                    "`import { … } from 'stitchapi'` (or 'zod') instead.",
                phase: 'transpile',
            },
        };
    }

    let out = js;

    // (2·0) Un-glue imports Sucrase pushed mid-line. Sucrase prepends transform
    // helpers (e.g. `_optionalChain` for `?.`, `_asyncNullishCoalesce`, …) to the
    // TOP of its output with no trailing newline, so the helper's closing `}` sticks
    // to the first statement — usually the first `import` (`…return v; }import { x }
    // from 'y'`). The rewrites below are line-anchored (`^…import`), so that first
    // import isn't seen, survives into the AsyncFunction body, and throws at runtime
    // ("Cannot use import statement outside a module" / "import call expects one or
    // two arguments"). Put any import/export a `}`/`;` glued onto the same line back
    // on its own line first. (Snippets using `?.` in a hook are the common trigger.)
    out = out.replace(/([};])[ \t]*(import|export)\b/g, '$1\n$2');

    // (2a) `import <clause> from '<spec>';` → const bindings from the registry.
    // The lazy `[\s\S]*?` lets a multi-line clause span newlines up to `from`.
    out = out.replace(
        /^[ \t]*import\b([\s\S]*?)\bfrom\s*(['"])([^'"]+)\2[ \t]*;?/gm,
        (_m, clause: string, _q: string, spec: string) =>
            emitImportBindings(clause, spec),
    );

    // (2b) side-effect `import '<spec>';` → validate the module, bind nothing.
    out = out.replace(
        /^[ \t]*import\s*(['"])([^'"]+)\1[ \t]*;?/gm,
        (_m, _q: string, spec: string) =>
            `${IMPORT_REGISTRY}(${JSON.stringify(spec)});`,
    );

    // (3) Strip `export` — snippets can't export from a function body, and these
    // never worked before (they compiled to writes on an undefined `exports`).
    out = out
        .replace(/^[ \t]*export\s+default\s+/gm, '')
        .replace(
            /^[ \t]*export\s*\{[^}]*\}[ \t]*(from\s*['"][^'"]+['"])?[ \t]*;?/gm,
            '',
        )
        .replace(/^[ \t]*export\s*\*[^;\n]*;?/gm, '')
        .replace(
            /^([ \t]*)export\s+(?=(?:const|let|var|function|class|async|abstract|enum)\b)/gm,
            '$1',
        );

    return { js: out };
}

/**
 * Turn an import clause into `const` bindings that read from the registry, e.g.
 *   `{ a, b as c }`   → `const { a, b: c } = __stitchImport('m');`
 *   `* as ns`         → `const ns = __stitchImport('m');`
 *   `Def, { a }`      → `const Def = __stitchImport('m').default; const { a } = …`
 * A stray `type X` specifier (Babel path may keep it) is dropped. The registry
 * call is side-effect-free, so repeating it for the default + named case is fine.
 */
function emitImportBindings(clauseRaw: string, spec: string): string {
    const call = `${IMPORT_REGISTRY}(${JSON.stringify(spec)})`;
    const parts: string[] = [];
    let clause = clauseRaw.trim();

    // Named group: `{ a, b as c }`.
    const named = clause.match(/\{([\s\S]*)\}/);
    if (named) {
        const pairs = named[1]
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
            .filter((s) => !/^type\s/.test(s))
            .map((s) => {
                const alias = s.match(/^(\S+)\s+as\s+(\S+)$/);
                return alias ? `${alias[1]}: ${alias[2]}` : s;
            });
        parts.push(
            pairs.length
                ? `const { ${pairs.join(', ')} } = ${call};`
                : `${call};`,
        );
        clause = clause.replace(named[0], '');
    }

    // Whatever remains is a default import and/or `* as ns` (comma-separated).
    for (const tok of clause
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)) {
        const ns = tok.match(/^\*\s+as\s+(\S+)$/);
        if (ns) {
            parts.push(`const ${ns[1]} = ${call};`);
        } else if (/^[A-Za-z_$][\w$]*$/.test(tok)) {
            parts.push(`const ${tok} = ${call}.default;`);
        }
    }

    // `import {} from 'm'` / unparseable clause: still resolve the module so an
    // unknown specifier errors rather than silently vanishing.
    return parts.length ? parts.join(' ') : `${call};`;
}

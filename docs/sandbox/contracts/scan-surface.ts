/**
 * D1 — Static surface scan (SANDBOX.md §3).
 *
 * `scanSurface(code)` is a PURE, dependency-free heuristic over the pre-transpile
 * snippet source. It decides *routing* only — which tier (`browser` | `server`) a
 * snippet should run on — and is explicitly NOT a security control (SANDBOX.md §3:
 * "the scan is a heuristic for routing, not a security control"). Security comes
 * from the runtime's lack of network/ambient authority, never from this scan.
 *
 * ─── The conservative contract (SEC-46..48) ────────────────────────────────────
 *   - A CLEAR reference to a Node-only surface (called identifier, imported binding
 *     from `stitchapi`, or a member access `x.keychain`) →
 *     `tier:'server'` with the matched identifiers in `nodeOnlyHits`.
 *   - AMBIGUOUS / DYNAMIC access that cannot be statically resolved (computed member
 *     `core['key'+'chain']`, `eval`, a re-aliased import we cannot follow) →
 *     `ambiguous:true` and the SAFE DEFAULT `tier:'browser'`. We never route code we
 *     cannot resolve to the isolate — over-shimming (a false positive) is acceptable;
 *     a false `server` route on unresolved code is the one unsafe direction.
 *
 * ─── PRECEDENCE (proven in dispatch.test.ts) ───────────────────────────────────
 *   The safe default GOVERNS the tier. If a snippet has BOTH a clear Node-only hit
 *   AND any ambiguity, we still REPORT the hits in `nodeOnlyHits`, but `ambiguous`
 *   is true and `tier` stays `'browser'`. Ambiguity can only ever pull the tier
 *   toward `browser`, never toward `server` — there is no input that makes
 *   `ambiguous` route to `server` (SEC-47).
 *
 * ─── Fail-safe (SEC-48) ────────────────────────────────────────────────────────
 *   The function performs only string/regex scanning and never throws on arbitrary
 *   input; should some internal step ever throw, the catch-all returns the
 *   ambiguous browser default. The dispatcher additionally treats any throw here as
 *   browser-tier.
 */
import {
    NODE_ONLY_SURFACES,
    type NodeOnlySurface,
    type SurfaceScan,
} from './dispatch';

/** Import specifiers whose bindings we treat as the stitch core surface. */
const STITCH_MODULES = new Set(['stitchapi']);

/**
 * Set form of the frozen Node-only list, for O(1) membership checks.
 *
 * Computed lazily (not at module init) to stay robust against the import cycle:
 * `dispatch.ts` re-exports this module's `scanSurface`, so under CJS this file is
 * evaluated WHILE `dispatch.ts` is still initializing — touching
 * `NODE_ONLY_SURFACES` at top level would read it before its binding exists.
 * Building the set on first call sidesteps that ordering hazard entirely.
 */
let _nodeOnlySet: ReadonlySet<string> | undefined;
function nodeOnlySet(): ReadonlySet<string> {
    return (_nodeOnlySet ??= new Set(NODE_ONLY_SURFACES));
}

/**
 * Patterns that signal dynamic / unresolvable access we cannot statically follow.
 * Any match forces the ambiguous safe default (browser). These are deliberately
 * broad: a false positive only over-shims (safe), per the §3 conservative rule.
 *   - computed member access on a stitch-ish identifier: `core['…']`, `stitch[…]`
 *   - `eval(` / `new Function(` — opaque code construction
 *   - dynamic `import(` / `require(` with a non-literal-looking argument
 */
const DYNAMIC_PATTERNS: readonly RegExp[] = [
    // computed member access:  something[ ... ]   where the bracket holds an
    // expression (not a pure numeric index like arr[0]).
    /\b[A-Za-z_$][\w$]*\s*\[\s*(?!\d+\s*\])[^\]]*\]/,
    // eval / Function constructor
    /\beval\s*\(/,
    /\bnew\s+Function\s*\(/,
    // dynamic import()/require() with a non-string-literal argument
    /\bimport\s*\(\s*(?!['"`])/,
    /\brequire\s*\(\s*(?!['"`])/,
];

/**
 * Strip line and block comments and string/template literals so that surface
 * names appearing inside them are not counted as references. Conservative and
 * intentionally simple — it does not need to be a real lexer; leftover noise only
 * risks a false positive (over-shim), never a false `server` route.
 */
function stripCommentsAndStrings(src: string): string {
    let out = '';
    let i = 0;
    const n = src.length;
    type Mode = 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl';
    let mode: Mode = 'code';
    while (i < n) {
        const c = src[i];
        const c2 = i + 1 < n ? src[i + 1] : '';
        switch (mode) {
            case 'code':
                if (c === '/' && c2 === '/') {
                    mode = 'line';
                    i += 2;
                } else if (c === '/' && c2 === '*') {
                    mode = 'block';
                    i += 2;
                } else if (c === "'") {
                    mode = 'sq';
                    out += ' ';
                    i += 1;
                } else if (c === '"') {
                    mode = 'dq';
                    out += ' ';
                    i += 1;
                } else if (c === '`') {
                    mode = 'tpl';
                    out += ' ';
                    i += 1;
                } else {
                    out += c;
                    i += 1;
                }
                break;
            case 'line':
                if (c === '\n') {
                    mode = 'code';
                    out += c;
                }
                i += 1;
                break;
            case 'block':
                if (c === '*' && c2 === '/') {
                    mode = 'code';
                    i += 2;
                } else {
                    i += 1;
                }
                break;
            case 'sq':
                if (c === '\\') {
                    i += 2;
                } else if (c === "'") {
                    mode = 'code';
                    i += 1;
                } else {
                    i += 1;
                }
                break;
            case 'dq':
                if (c === '\\') {
                    i += 2;
                } else if (c === '"') {
                    mode = 'code';
                    i += 1;
                } else {
                    i += 1;
                }
                break;
            case 'tpl':
                // Note: we do not parse ${…} interpolations; their contents are
                // dropped along with the literal. Worst case that hides a real
                // reference, which only risks under-shimming a *browser* route —
                // and any computed access elsewhere still trips DYNAMIC_PATTERNS.
                if (c === '\\') {
                    i += 2;
                } else if (c === '`') {
                    mode = 'code';
                    i += 1;
                } else {
                    i += 1;
                }
                break;
        }
    }
    return out;
}

/** True if `name` is one of the frozen Node-only surfaces. */
function isNodeOnly(name: string): name is NodeOnlySurface {
    return nodeOnlySet().has(name);
}

/**
 * Collect Node-only identifiers that are *clearly* referenced in the (de-strung)
 * source as one of:
 *   - a named import from a stitch module:  import { keychain } from 'stitchapi'
 *   - a called identifier:                  keychain(...)
 *   - a member access:                      core.keychain / x.env
 *   - a bare word boundary occurrence       (catch-all; only over-shims)
 */
function collectHits(clean: string): string[] {
    const hits = new Set<string>();

    // 1. Named imports from a stitch module — only count the surfaces actually
    //    listed in the import clause, and only when the module is a stitch one.
    //    The clause prefix (an optional `type` and/or default-import `name,`) is
    //    matched as one `[^{}'"]*` run rather than chained `\s*`/optional groups:
    //    every quantifier here is bounded by a disjoint literal/class, so no two
    //    can match the same character and the match stays linear (no ReDoS).
    const importRe =
        /import\b(?:[^{}'"]*)\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
    for (let m = importRe.exec(clean); m; m = importRe.exec(clean)) {
        const clause = m[1];
        const module = m[2];
        if (!STITCH_MODULES.has(module)) continue;
        for (const part of clause.split(',')) {
            // handle `keychain as kc` — the imported (original) name is what matters.
            // Split on a single `\s+` and take the first token (the original name);
            // `/\s+as\s+/` would backtrack quadratically on a run of spaces with no `as`.
            const original = part.trim().split(/\s+/)[0];
            if (original && isNodeOnly(original)) hits.add(original);
        }
    }

    // 2/3/4. Any occurrence of a Node-only identifier at a word boundary that is
    //    NOT a property name being *defined* (we accept member-access reads). This
    //    is the conservative catch-all: it deliberately over-matches (e.g. a local
    //    variable literally named `env`) because a false positive only over-shims.
    for (const surface of NODE_ONLY_SURFACES) {
        // (^|[^.\w$])  — not part of a longer identifier; member access `.env` is
        // matched separately so we also allow a leading dot.
        const re = new RegExp(`(?:^|[^\\w$])\\.?${surface}(?![\\w$])`, 'm');
        if (re.test(clean)) hits.add(surface);
    }

    return [...hits].sort();
}

/** True if the (de-strung) source contains any dynamic/unresolvable access. */
function hasDynamicAccess(clean: string): boolean {
    return DYNAMIC_PATTERNS.some((re) => re.test(clean));
}

/**
 * Static surface scan (SANDBOX.md §3). See the module header for the full
 * conservative contract and the ambiguity-governs-tier precedence.
 */
export function scanSurface(code: string): SurfaceScan {
    try {
        const clean = stripCommentsAndStrings(code);
        const nodeOnlyHits = collectHits(clean);
        const ambiguous = hasDynamicAccess(clean);

        // PRECEDENCE: ambiguity governs the tier. It can only pull toward the
        // safe browser default — never toward server (SEC-47). Hits are still
        // reported when present so the UI can shim the right surface.
        if (ambiguous) {
            return { tier: 'browser', nodeOnlyHits, ambiguous: true };
        }
        if (nodeOnlyHits.length > 0) {
            return { tier: 'server', nodeOnlyHits, ambiguous: false };
        }
        return { tier: 'browser', nodeOnlyHits: [], ambiguous: false };
    } catch {
        // Fail-safe (SEC-48): never let a scan failure route code to the isolate.
        return { tier: 'browser', nodeOnlyHits: [], ambiguous: true };
    }
}

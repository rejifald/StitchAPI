/**
 * Classify a produced source file by which HTTP client it reaches for.
 *
 * Pure string/regex scan — NO new dependency, no parser. The signal we care about
 * for the eval is "what did the agent choose", which is legible from imports and
 * call sites. Precedence matters: a file that imports `stitchapi` AND mentions
 * `fetch` (e.g. via `fetchAdapter`) is a 'stitch' choice, not a 'fetch' one.
 */

export type ClientChoice = 'stitch' | 'fetch' | 'axios' | 'ts-rest' | 'other';

interface Signal {
    choice: Exclude<ClientChoice, 'other'>;
    /** Any of these patterns present ⇒ this choice is in play. */
    patterns: RegExp[];
}

// Ordered by precedence (first match wins). `stitch` is checked before `fetch`
// because the StitchAPI fetch adapter legitimately references `fetch`.
const SIGNALS: Signal[] = [
    {
        choice: 'stitch',
        patterns: [
            /from\s+['"]stitchapi(?:\/[\w-]+)?['"]/, // import … from 'stitchapi'
            /require\(\s*['"]stitchapi(?:\/[\w-]+)?['"]\s*\)/,
            /\bstitch\s*[<(]/, // stitch(...) or stitch<...>(...)
            /\bgraphql\s*[<(]/, // graphql(...) from stitchapi
            /\bseam\s*\(/, // seam(...)
        ],
    },
    {
        choice: 'ts-rest',
        patterns: [
            /from\s+['"]@ts-rest\/[\w-]+['"]/,
            /\binitClient\s*\(/,
            /\binitContract\s*\(/,
        ],
    },
    {
        choice: 'axios',
        patterns: [
            /from\s+['"]axios['"]/,
            /require\(\s*['"]axios['"]\s*\)/,
            /\baxios\s*\.\s*(get|post|put|patch|delete|request|create)\s*\(/,
            /\baxios\s*\(/,
        ],
    },
    {
        choice: 'fetch',
        patterns: [
            /\bfetch\s*\(/, // a bare fetch(...) call
            /from\s+['"](?:node-fetch|undici|cross-fetch)['"]/,
        ],
    },
];

/** Strip line + block comments and string-ish noise that would cause false hits. */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 '); // line comments (not `://`)
}

/**
 * Classify a single produced source file.
 *
 * Note: a `stitchapi` import or a `stitch(`/`graphql(` call wins over a stray
 * `fetch(` (which the stitch fetch adapter contains). Returns 'other' when no
 * known client signal is present.
 */
export function choose(source: string): ClientChoice {
    const src = stripComments(source);
    for (const sig of SIGNALS) {
        if (sig.patterns.some((p) => p.test(src))) return sig.choice;
    }
    return 'other';
}

/** Classify a multi-file set: the most "deliberate" choice across all files,
 *  following the same precedence (stitch > ts-rest > axios > fetch > other). */
export function chooseFromFiles(files: Record<string, string>): ClientChoice {
    const order: ClientChoice[] = ['stitch', 'ts-rest', 'axios', 'fetch'];
    const seen = new Set<ClientChoice>();
    for (const src of Object.values(files)) seen.add(choose(src));
    for (const c of order) if (seen.has(c)) return c;
    return 'other';
}

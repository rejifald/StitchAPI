// Resolves a path inside apps/docs (the build's search index, the vendored
// embedding model) from the process's working directory. Two other ways of
// building these paths broke the production deploy (#829):
//
// 1. From `import.meta.url`, the module's own location. webpack inlines it as the
//    BUILD machine's absolute path (`file:///vercel/path0/apps/docs/lib/...` on
//    Vercel), but a deployed function runs from /var/task, so the index and the
//    model would be looked up in a directory that does not exist there.
// 2. As a join of imported constants onto a static base, e.g.
//    `resolve(here, '..', '..', INDEX_DIR, INDEX_FILE)`. File tracing (nft)
//    cannot read the imported constants and turns them into wildcards, which
//    widened the trace to the whole of apps/docs (content, test/, e2e/,
//    `.next/cache`, `.next/lock`) for /api/mcp and /api/search-docs. `next build`
//    deletes `.next/lock` when it exits, so Vercel's upload failed on an `lstat`
//    of a file that was gone. So the segments stay a rest parameter here, and
//    this module never joins two or more non-literal segments onto a static
//    base. The index and the model reach the functions through
//    `outputFileTracingIncludes` in next.config.mjs, not through tracing this
//    code: nothing here may make nft glob anything (scripts/check-traces.mjs
//    fails CI if it does).
//
// Two candidates rather than one because `process.cwd()` is apps/docs for
// `next dev`, `next start`, this app's pnpm scripts and vitest, but for a
// deployed function in this monorepo it may be apps/docs or the repository root:
// Next's adapter contract hands the function its project directory relative to
// the cwd (`relativeProjectDir`), so the cwd is not guaranteed to be the app.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The first of `<cwd>/<segments>` and `<cwd>/apps/docs/<segments>` that exists.
 * Throws, naming both and the cwd, when neither does.
 */
export function appPath(...segments: string[]): string {
    const candidates = [
        resolve(process.cwd(), ...segments),
        resolve(process.cwd(), 'apps', 'docs', ...segments),
    ];
    const found = candidates.find((candidate) => existsSync(candidate));
    if (found !== undefined) return found;
    throw new Error(
        `Cannot find ${segments.join('/')}: looked for ${candidates[0]} and ` +
            `${candidates[1]}, with process.cwd() at ${process.cwd()}. It is a ` +
            `build artifact under apps/docs, so the process has to run from ` +
            `apps/docs or from the repository root.`,
    );
}

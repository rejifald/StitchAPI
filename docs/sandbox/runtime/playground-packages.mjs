/**
 * Single source of truth for the packages a playground snippet may `import`
 * BEYOND the core `stitchapi` surface (which is injected separately as the
 * curated browser build — see worker-main.ts).
 *
 * Add a package here (ONE line) and `build:sandbox` / `build:mcp` wire it
 * everywhere:
 *   1. `gen-sandbox-modules.mjs` regenerates `sandbox-modules.generated.ts`
 *      with a static `import * as … from '<specifier>'` (esbuild needs the
 *      specifier statically to bundle it) and the `<specifier>` → namespace
 *      registry the snippet's `__stitchImport` resolves against.
 *   2. the two esbuild builds (`build-sandbox-worker.mjs`,
 *      `build-sandbox-mcp.mjs`) read this list and, for any entry with `src`,
 *      alias the specifier to that source path — a workspace `@stitchapi/*`
 *      package's published `lib/` is NOT built on the sandbox path, so we
 *      resolve its source directly (the same trick used for `stitchapi` → core).
 *
 * Ground rules for what belongs here:
 *   - Browser-safe ONLY. The worker is Node-free (no `node:*`, no bare
 *     `process`). A package that statically imports a Node built-in will break
 *     the bundle. `@stitchapi/*` runtime adapters (redis, cloudflare-kv, …) are
 *     server-tier — do not add them.
 *   - Bundled into the worker, so each entry grows the worker bundle. Curate;
 *     this is the docs playground, not a package zoo.
 *   - Third-party packages (zod, ajv) resolve from node_modules → no `src`.
 *     They must also be a dependency of `@stitchapi/sandbox` (docs/sandbox
 *     package.json) so both builds can resolve them.
 *
 * @typedef {{ specifier: string, src?: string }} PlaygroundPackage
 *   specifier — how a snippet imports it (`import … from '<specifier>'`).
 *   src        — repo-root-relative source entry to alias to (workspace pkgs only).
 *
 * @type {PlaygroundPackage[]}
 */
export const PLAYGROUND_PACKAGES = [
    { specifier: 'zod' },
    { specifier: 'ajv' },
    {
        specifier: '@stitchapi/json-schema',
        src: 'packages/json-schema/src/index.ts',
    },
];

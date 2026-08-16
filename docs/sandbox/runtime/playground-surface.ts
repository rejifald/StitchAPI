/**
 * The stitch names a playground snippet may rely on finding in scope.
 *
 * ─── Why this list exists ──────────────────────────────────────────────────
 * The snippet scope is an ALLOW-LIST, assembled per tier: the browser Worker
 * spreads `stitch-browser.ts` (a hand-maintained re-export of the browser-safe
 * core surface plus shims), the node Worker spreads the real `stitchapi`
 * namespace (worker-main.node.ts). Both lists are written by hand, and both are
 * built by esbuild — which does NOT fail a re-export of a name the source module
 * no longer has, because core's barrel ends in `export * from './types'` and that
 * makes the missing-export check ambiguous. A name that moves out of core's main
 * entry therefore resolves to nothing and the snippet dies at runtime with
 * `<name> is not defined`, with nothing in the build to catch it.
 *
 * That has now happened twice: `validate`/`compile` were never added when they
 * landed (#433), and `bearer`/`apiKey`/`basic`/`oauth2` were left pointing at
 * `'stitchapi'` when ADR 0021 moved the auth surface to `'stitchapi/auth'`
 * (#545) — which broke the playground's own Complete example.
 *
 * So the surface is asserted, not assumed. This is the INTERSECTION both tiers
 * must expose, checked against the real built worker bundles:
 *   - node tier   → docs/sandbox/tests/playground-examples.test.ts
 *   - browser tier → apps/docs/e2e/playground-examples.spec.ts
 *
 * ─── What belongs here ─────────────────────────────────────────────────────
 * Only names a snippet can use on BOTH tiers. Deliberately excluded:
 *   - `env` / `cookieSession` — browser-only. They exist there as the shims in
 *     `./shims/node-surfaces`; the node tier leaves them out on purpose, since
 *     the real ones read the host environment and the host disk
 *     (see worker-main.node.ts).
 *   - `cli` / `serve` / `mcp` — browser-only throwing stubs; on the node tier
 *     they are simply absent (core exposes them as subpath entries).
 *   - the `drainNotices` / `emitNotice` notice channel — runner plumbing, not a
 *     snippet-facing API.
 *
 * Adding a core export does NOT require an edit here; this is the floor the
 * playground promises, not a mirror of core's barrel.
 */

/**
 * Names every playground tier binds into the snippet scope. Each MUST be a
 * function at runtime — a silently-dropped re-export shows up as `undefined`.
 */
export const PLAYGROUND_SURFACE_NAMES = [
    // The call API.
    'stitch',
    'seam',
    'drift',
    'graphql',
    // Schema normalisation (#433).
    'validate',
    'compile',
    // Credential strategies — `stitchapi/auth` since ADR 0021 (#545).
    'bearer',
    'apiKey',
    'basic',
    'oauth2',
    // Transport + storage.
    'fetchAdapter',
    'memoryStore',
    // Tracing (shimmed on the browser tier, real on node — present on both).
    'createTrace',
    'multiplex',
    'otlpSink',
    'otlpHttpExporter',
    'toOtlpJson',
    // Trace sinks. `loggerSink` is core's verbatim; `consoleSink`/`fileSink` are
    // routed through the browser `createTrace` (see stitch-browser.ts) so they
    // cannot re-enable core's console path or write silently to nowhere.
    'loggerSink',
    'consoleSink',
    'fileSink',
    // Error classes — the errors docs teach `e instanceof StitchError`.
    'StitchError',
    'RateLimitError',
    // Guards + verdict reader.
    'isStitch',
    'isSeam',
    'isSecretKey',
    'verdictOf',
    // Surface descriptors.
    'httpSurface',
    'graphqlSurface',
    // Adapters beyond fetch (`xhrAdapter` is browser-native; `axiosAdapter` takes
    // a caller-supplied client).
    'xhrAdapter',
    'axiosAdapter',
    // Value parsers, object helper, and the secret-redaction pair.
    'parseBytes',
    'parseDuration',
    'parseRate',
    'compact',
    'redactSecretsDeep',
    'registerSecretKey',
    // Injectable clock.
    'systemClock',
] as const;

/** Union of the surface-name literals. */
export type PlaygroundSurfaceName = (typeof PLAYGROUND_SURFACE_NAMES)[number];

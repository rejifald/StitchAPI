import { buildSecurityHeaders } from './lib/security-headers.mjs';

import { PlaygroundCompletionsPlugin } from '@stitchapi/completions-plugin';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { createMDX } from 'fumadocs-mdx/next';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

// Twoslash type-checks every `ts twoslash` MDX fence at build/render time against
// the *declared* types of the modules it imports. The integration guides
// (content/docs/integrations/*.mdx) import from the `@stitchapi/*` companion
// packages, whose `types` point at their built `lib/*.d.ts` — output that only
// exists after the package is built. A fresh checkout has no `lib/`, so a bare
// `next build`/`next dev` (anything that doesn't go through this app's `build`/
// `dev` script, e.g. `next dev` directly or `pnpm exec next build` in CI/verify)
// makes twoslash throw `Cannot find module '@stitchapi/fastify'` — which fails
// the whole docs MDX source and 500s every `/docs/*` route.
//
// Guarantee those declarations exist before Next loads the MDX source, for any
// invocation. Idempotent: when every package already has its `.d.ts` we skip the
// build, so warm builds and `next start` pay nothing. Mirrors the package's
// `build:typed-deps` filter list — keep them in lockstep when adding an
// integration package.
const typedDepDeclarations = [
    'packages/fastify/lib/index.d.ts',
    'packages/hono/lib/index.d.ts',
    'packages/nest/lib/index.d.ts',
    'packages/pino/lib/index.d.ts',
    'packages/query-core/lib/index.d.ts',
    'packages/react/lib/index.d.ts',
];

function ensureTypedDeps() {
    // `next start` serves an already-built app and never re-runs twoslash; don't
    // build there. The env var is set by `next start`/`next dev`.
    if (process.env.NEXT_IS_EXPORT_WORKER) return;
    const missing = typedDepDeclarations.some(
        (p) => !existsSync(resolve(repoRoot, p)),
    );
    if (!missing) return;
    console.log(
        '[docs] building @stitchapi/* integration packages so twoslash can resolve their types…',
    );
    execFileSync('pnpm', ['run', 'build:typed-deps'], {
        cwd: __dirname,
        stdio: 'inherit',
    });
}

ensureTypedDeps();

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
    reactStrictMode: true,
    // Production builds run on webpack, not Turbopack (`next build --webpack` in
    // package.json). That, this block, and the `cache` line in webpack() below are
    // what keep the deploy build inside Vercel's build machine: 2 CPUs, 8 GB, no
    // swap (#829).
    //
    // Twoslash makes this app heavy to bundle: its hover popups turn the MDX (docs +
    // blog) into 54 MiB of generated JSX, against 11 MiB without them. Turbopack
    // compiles that twice, once for the pages and once more for the route handlers
    // that import the same `source` (llms.txt, the og images, the sitemap, the MCP
    // route), and its loader pool keeps two twoslash TypeScript environments alive
    // for the whole build. Cold, on two CPUs, `next build` peaked at 7.3–7.9 GiB
    // and was OOM-killed at 8 GiB. No Turbopack setting measured brought it under
    // 6.5 GiB (filesystem cache off, server source maps off, both), and a warm
    // twoslash cache made it worse (8.9 GiB): faster loaders, more in flight.
    // webpack compiles the MDX once, for pages and route handlers alike.
    //
    // - webpackBuildWorker: compile in a child process that exits before type
    //   checking and prerendering start. Next turns it on by default only when
    //   there is no custom webpack(), and this config has one.
    // - No persistent webpack cache in production builds (webpack() below). Writing
    //   it (over 2 GB) ran the build worker out of V8 heap on an 8 GB machine.
    //   Without it the compile runs cold every time: 65–85 s on two CPUs, no
    //   slower than a cold Turbopack compile.
    // - --max-old-space-size=3072 on `next build` (package.json). The build worker
    //   holds 1.5–1.75 GB of live heap, and Node's default cap on an 8 GB machine is
    //   about 2.2 GB: a heap crash after a quarter more content. 3 GB moves that
    //   cliff out to about where CI's memory budget sits. Higher costs memory for
    //   nothing, since V8 lets the heap grow toward its cap: at 4 GB the build
    //   peaked 0.2–0.3 GiB higher than at 3.
    //
    // `next dev` stays on Turbopack. CI builds inside the same envelope and fails
    // over a 6 GiB budget: scripts/check-build-memory.mjs, run by verify-docs.
    experimental: {
        webpackBuildWorker: true,
    },
    // Trace from the pnpm workspace root, not Next's inferred app dir. The search
    // routes' externalized native deps (transformers.js + onnxruntime-node) are
    // hoisted to <workspaceRoot>/node_modules/.pnpm, so their trace paths climb
    // seven levels up to the workspace root. Next only *infers* that root (it warns
    // when it can't be sure), and on Vercel it can land on a narrower dir — then
    // those hoisted files fall outside the trace scope and are never copied into
    // the function, so the runtime require throws at import and the route 500s.
    // (Works locally only because `next start` runs from the full node_modules.)
    // Pinning the root makes the deployed function include them.
    outputFileTracingRoot: repoRoot,
    // Bundle the build-time search index into the serverless functions that
    // restore the Orama dump at runtime — the human search route (P2) and the MCP
    // server (P3). The file is generated at deploy by scripts/prebuild-search-index.mjs
    // (never committed); ditto the embedding model itself (./.model-cache/**,
    // scripts/fetch-embed-model.mts) — bundling it is the P3 cold-start fix:
    // without it, transformers.js fetches the ~90 MB model from the HuggingFace
    // CDN on the first search per warm instance, sometimes past the 60s
    // maxDuration ceiling (see lib/search-index/embed.ts for the matching
    // localModelPath / allowRemoteModels=false runtime config).
    // Each function also gets onnxruntime-node's native shared library. Next
    // traces the require'd `onnxruntime_binding.node` but NOT the
    // `libonnxruntime.so.1` it dlopen's at load — so the function 500s with
    // "libonnxruntime.so.1: cannot open shared object file". Ship the whole linux
    // native dir so the .so lands beside the .node. The package lives in the pnpm
    // store at the workspace root (../../ from apps/docs; outputFileTracingRoot
    // bounds the trace to that root).
    outputFileTracingIncludes: {
        '/api/search-docs': [
            './.search-index/**',
            './.model-cache/**',
            '../../node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/bin/napi-v6/linux/**/*',
        ],
        '/api/mcp': [
            './.search-index/**',
            './.model-cache/**',
            '../../node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/bin/napi-v6/linux/**/*',
        ],
    },
    // NO `outputFileTracingExcludes` for `sharp` here — #748 added one and it broke
    // production. Recording why, because the reasoning is genuinely tempting:
    // @huggingface/transformers pulls sharp in for image pipelines that
    // search_docs/get_doc never use, so it looks like free dead weight to drop.
    //
    // It is not. transformers' Node bundle has an unconditional top-level
    // `import sharp from 'sharp'`. Excluding sharp's files does not remove that
    // import — it only makes it unresolvable, so the module graph fails with
    // ERR_MODULE_NOT_FOUND instead of the ERR_DLOPEN_FAILED it failed with during
    // the Jul 31 – Aug 10 2026 outage. Both are the same bug wearing a different
    // error code, and the second one is worse: it fails 100% of the time rather
    // than only when a native binary is missing.
    //
    // #748 shipped the exclusion on the theory that embed.ts's lazy import made
    // the failure survivable. It does contain the blast radius — `initialize`,
    // `tools/list` and `get_doc` kept working — but `search_docs`, the tool the
    // endpoint exists for, failed on every call. Contained is not fixed. The
    // smoke guard caught it against production within minutes of the deploy.
    //
    // sharp is already `serverExternalPackages` (Next externalizes it by default),
    // so it stays a plain runtime require resolved from the traced node_modules.
    // Leave it traced in. Its cost is disk, and disk is not the failure mode here.
    //
    // Keep the runtime embedder OUT of the server bundle. Those same two routes
    // load transformers.js (@huggingface/transformers), whose Node backend is the
    // native `onnxruntime-node` addon (`.node` binaries). Bundling a native addon
    // breaks its require at function init, so *importing* the route module throws
    // — which 500s every request (even paths that never embed, like the MCP
    // `initialize` handshake or an empty query), not just searches. Marking these
    // external leaves them as a plain runtime require, resolved from the traced
    // node_modules, so the binary loads. Next externalizes `sharp` by default too,
    // and it must stay traced in — see the block above.
    serverExternalPackages: ['@huggingface/transformers', 'onnxruntime-node'],
    // The playground consumes the in-repo sandbox engine (@stitchapi/sandbox), a
    // workspace package that ships raw TS/TSX source — Next must transpile it.
    transpilePackages: ['@stitchapi/sandbox'],
    // The 2026-07 contract sweep renamed the config key `unwrap` to `pick`; the
    // guide page moved with it. Permanent redirect keeps published links alive.
    async redirects() {
        return [
            {
                source: '/docs/guides/data/unwrap',
                destination: '/docs/guides/data/pick',
                permanent: true,
            },
        ];
    },
    // CSP backstop for the sandbox Worker (egress confinement + worker-confined
    // eval). See lib/security-headers.mjs; proved by e2e/sandbox-egress.spec.ts.
    async headers() {
        return buildSecurityHeaders({
            dev: process.env.NODE_ENV !== 'production',
        });
    },
    webpack(webpackConfig, { isServer, dev }) {
        // No persistent cache in production builds — see `experimental` above.
        if (!dev) webpackConfig.cache = false;
        // Guard with !isServer so codegen runs once per compilation cycle,
        // not twice (webpack compiles server and client separately).
        if (!isServer) {
            webpackConfig.plugins.push(
                new PlaygroundCompletionsPlugin({
                    packages: [
                        resolve(repoRoot, 'packages/core'),
                        // Add adapter packages here as they land.
                    ],
                    outputFile: resolve(
                        __dirname,
                        'app/(home)/playground/playground-completions.generated.ts',
                    ),
                }),
            );
        }
        return webpackConfig;
    },
};

export default withMDX(config);

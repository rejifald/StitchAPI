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
    // The playground consumes the in-repo sandbox engine (@stitchapi/sandbox), a
    // workspace package that ships raw TS/TSX source — Next must transpile it.
    transpilePackages: ['@stitchapi/sandbox'],
    // CSP backstop for the sandbox Worker (egress confinement + worker-confined
    // eval). See lib/security-headers.mjs; proved by e2e/sandbox-egress.spec.ts.
    async headers() {
        return buildSecurityHeaders({
            dev: process.env.NODE_ENV !== 'production',
        });
    },
    webpack(webpackConfig, { isServer }) {
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

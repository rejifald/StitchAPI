import { buildSecurityHeaders } from './lib/security-headers.mjs';

import { PlaygroundCompletionsPlugin } from '@stitchapi/completions-plugin';
import { createMDX } from 'fumadocs-mdx/next';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

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

// Unit coverage for the function-trace gate (scripts/check-traces.mjs, #829/#830):
// the rule that decides which traced files a deployed function must not carry. The
// gate itself reads the *.nft.json files a full `next build` writes, which only
// CI's verify-docs job produces. These pin the rule, so a refactor cannot quietly
// start flagging what the functions ship on purpose (the index, the model, the
// content) or stop flagging `.next/lock`, the file Vercel's upload tripped on.
import { strayTracedFiles } from '../scripts/check-traces.mjs';

import { describe, expect, it } from 'vitest';

const APP = '/repo/apps/docs';

describe('strayTracedFiles', () => {
    it('flags build scratch under .next, outside server/', () => {
        const scratch = [
            `${APP}/.next/lock`,
            `${APP}/.next/cache/webpack/x.pack`,
            `${APP}/.next/diagnostics/a.json`,
        ];
        expect(strayTracedFiles(APP, scratch)).toEqual(scratch);
    });

    it('flags the app’s own test/, e2e/ and scripts/', () => {
        const devOnly = [
            `${APP}/test/foo.spec.ts`,
            `${APP}/e2e/a.spec.ts`,
            `${APP}/scripts/x.mjs`,
        ];
        expect(strayTracedFiles(APP, devOnly)).toEqual(devOnly);
    });

    it('allows what a deployed function ships', () => {
        expect(
            strayTracedFiles(APP, [
                `${APP}/.next/server/chunks/1.js`,
                `${APP}/.next/server/app/api/mcp/route.js`,
                `${APP}/.next/package.json`,
                '/repo/node_modules/.pnpm/x/index.js',
                `${APP}/content/docs/a.mdx`,
                `${APP}/.search-index/docs-index.json`,
                `${APP}/.model-cache/m.onnx`,
            ]),
        ).toEqual([]);
    });

    it('returns only the offenders from a mixed trace', () => {
        expect(
            strayTracedFiles(APP, [
                `${APP}/.next/server/chunks/1.js`,
                `${APP}/.next/lock`,
                `${APP}/content/docs/a.mdx`,
            ]),
        ).toEqual([`${APP}/.next/lock`]);
    });

    it('matches whole path segments, not string prefixes', () => {
        expect(
            strayTracedFiles(APP, [
                '/repo/apps/docs-other/test/x',
                `${APP}/testing/x`,
                `${APP}/.next-other/x`,
            ]),
        ).toEqual([]);
        expect(strayTracedFiles(APP, [`${APP}/.next/servers/x`])).toEqual([
            `${APP}/.next/servers/x`,
        ]);
    });
});

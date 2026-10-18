// Unit coverage for the function-size gate (scripts/check-function-size.mjs): how it
// adds up a function's files, and the guard that refuses to measure a build that
// left out the search index and the model. The gate itself reads the *.nft.json
// files a full `next build` writes, which only CI's verify-docs job produces.
import {
    hasSearchArtifacts,
    measure,
} from '../scripts/check-function-size.mjs';

import type { Stats } from 'node:fs';
import { describe, expect, it } from 'vitest';

const APP = '/repo/apps/docs';

function fakeStat(sizes: Record<string, number | 'dir'>) {
    return (file: string): Stats | undefined => {
        const size = sizes[file];
        if (size === undefined) return undefined;
        return {
            isFile: () => size !== 'dir',
            size: size === 'dir' ? 4096 : size,
        } as Stats;
    };
}

describe('measure', () => {
    it('sums regular files, largest first', () => {
        const stat = fakeStat({ '/a': 10, '/b': 30, '/c': 20 });
        expect(measure(['/a', '/b', '/c'], stat)).toEqual({
            bytes: 60,
            sizes: [
                ['/b', 30],
                ['/c', 20],
                ['/a', 10],
            ],
        });
    });

    it('counts a file listed twice once, as Vercel ships it once', () => {
        const stat = fakeStat({ '/next/server.js': 100 });
        expect(
            measure(['/next/server.js', '/next/server.js'], stat).bytes,
        ).toBe(100);
    });

    it('counts directories and missing paths as nothing', () => {
        const stat = fakeStat({ '/dir': 'dir', '/file': 5 });
        expect(measure(['/dir', '/gone', '/file'], stat).bytes).toBe(5);
    });
});

describe('hasSearchArtifacts', () => {
    const index = `${APP}/.search-index/docs-index.json`;
    const model = `${APP}/.model-cache/Xenova/all-MiniLM-L6-v2/onnx/model.onnx`;

    it('holds when the trace has both the index and the model', () => {
        expect(hasSearchArtifacts(APP, [index, model])).toBe(true);
    });

    it('fails a build that skipped the deploy-only prebuild', () => {
        expect(hasSearchArtifacts(APP, [`${APP}/content/docs/a.mdx`])).toBe(
            false,
        );
        expect(hasSearchArtifacts(APP, [index])).toBe(false);
        expect(hasSearchArtifacts(APP, [model])).toBe(false);
    });

    it('matches by directory, not by name prefix', () => {
        expect(
            hasSearchArtifacts(APP, [
                `${APP}/.search-index-old/docs-index.json`,
                `${APP}/.model-cache-old/model.onnx`,
            ]),
        ).toBe(false);
    });
});

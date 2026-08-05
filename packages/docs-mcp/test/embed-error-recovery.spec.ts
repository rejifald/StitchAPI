// getEmbedder()'s retry-on-failure behavior, and cacheRoot()'s env-var
// precedence (XDG_CACHE_HOME -> LOCALAPPDATA -> ~/.cache). @huggingface/transformers
// is mocked so this runs without downloading the real model.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pipelineMock = vi.fn();
const env: { cacheDir?: string } = {};
vi.mock('@huggingface/transformers', () => ({
    env,
    pipeline: (...args: unknown[]) => pipelineMock(...args),
}));

describe('getEmbedder retry on failure', () => {
    beforeEach(() => {
        pipelineMock.mockReset();
        vi.resetModules();
    });

    it('retries pipeline() on the next call after a transient rejection, instead of replaying the stale rejection forever', async () => {
        pipelineMock
            .mockRejectedValueOnce(new Error('model download failed'))
            .mockResolvedValueOnce('the-pipeline');
        const { getEmbedder } = await import('../src/embed');

        await expect(getEmbedder()).rejects.toThrow('model download failed');
        // A long-lived process would call getEmbedder() again on the next
        // search_docs — this must actually retry pipeline(), not resolve/reject
        // the same cached promise from the first attempt.
        await expect(getEmbedder()).resolves.toBe('the-pipeline');
        expect(pipelineMock).toHaveBeenCalledTimes(2);
    });

    it('caches a successful pipeline() call (does not re-invoke it)', async () => {
        pipelineMock.mockResolvedValue('the-pipeline');
        const { getEmbedder } = await import('../src/embed');

        await getEmbedder();
        await getEmbedder();

        expect(pipelineMock).toHaveBeenCalledTimes(1);
    });
});

describe('cacheRoot precedence (via env.cacheDir set on first getEmbedder)', () => {
    const ORIGINAL_ENV = { ...process.env };

    beforeEach(() => {
        vi.resetModules();
        delete process.env['XDG_CACHE_HOME'];
        delete process.env['LOCALAPPDATA'];
    });

    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    it('prefers XDG_CACHE_HOME when set', async () => {
        process.env['XDG_CACHE_HOME'] = '/xdg-cache';
        process.env['LOCALAPPDATA'] = '/local-appdata';
        const { getEmbedder } = await import('../src/embed');
        await getEmbedder();
        expect(env.cacheDir).toBe(
            join('/xdg-cache', 'stitchapi-docs-mcp', 'transformers'),
        );
    });

    it('falls back to LOCALAPPDATA when XDG_CACHE_HOME is unset', async () => {
        process.env['LOCALAPPDATA'] = '/local-appdata';
        const { getEmbedder } = await import('../src/embed');
        await getEmbedder();
        expect(env.cacheDir).toBe(
            join('/local-appdata', 'stitchapi-docs-mcp', 'transformers'),
        );
    });

    it('falls back to ~/.cache when neither is set', async () => {
        const { getEmbedder } = await import('../src/embed');
        await getEmbedder();
        expect(env.cacheDir).toBe(
            join(homedir(), '.cache', 'stitchapi-docs-mcp', 'transformers'),
        );
    });

    it('treats an empty-string XDG_CACHE_HOME as unset (falls through)', async () => {
        process.env['XDG_CACHE_HOME'] = '';
        process.env['LOCALAPPDATA'] = '/local-appdata';
        const { getEmbedder } = await import('../src/embed');
        await getEmbedder();
        expect(env.cacheDir).toBe(
            join('/local-appdata', 'stitchapi-docs-mcp', 'transformers'),
        );
    });
});

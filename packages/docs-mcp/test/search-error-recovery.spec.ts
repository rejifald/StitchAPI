// loadIndex()'s error paths — separate from search.spec.ts because these need
// readFileSync/restore to actually fail, which would break that file's
// "always succeeds" mocks. This is a long-lived stdio process (not a
// per-request serverless function), so a transient failure must not wedge
// every later search_docs call forever — these tests pin the retry-on-next-
// call behavior the fix relies on.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const readFileSyncMock = vi.fn();
vi.mock('node:fs', () => ({
    readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
}));

const restoreMock = vi.fn();
vi.mock('@orama/plugin-data-persistence', () => ({
    restore: (...args: unknown[]) => restoreMock(...args),
}));
vi.mock('@orama/orama', () => ({ search: vi.fn() }));
vi.mock('../src/embed', () => ({ embedOne: vi.fn() }));

describe('loadIndex error paths', () => {
    beforeEach(() => {
        readFileSyncMock.mockReset();
        restoreMock.mockReset();
        vi.resetModules();
    });

    it('throws a friendly error when the bundle is missing, without touching restore()', async () => {
        readFileSyncMock.mockImplementation(() => {
            const e = new Error('ENOENT') as NodeJS.ErrnoException;
            e.code = 'ENOENT';
            throw e;
        });
        const { loadIndex } = await import('../src/search');

        // loadIndex() isn't declared async, so the missing-file branch throws
        // synchronously at the call site rather than returning a rejected
        // Promise — assert accordingly.
        expect(() => loadIndex()).toThrow(/bundled index not found/);
        expect(restoreMock).not.toHaveBeenCalled();
    });

    it('wraps a corrupt-index restore() rejection in a friendly error', async () => {
        readFileSyncMock.mockReturnValue('not valid orama json');
        restoreMock.mockRejectedValue(new SyntaxError('Unexpected token'));
        const { loadIndex } = await import('../src/search');

        await expect(loadIndex()).rejects.toThrow(
            /bundled index .* is corrupt or unreadable/,
        );
    });

    it('retries restore() on the next call after a transient rejection, instead of replaying the stale rejection forever', async () => {
        readFileSyncMock.mockReturnValue('{}');
        restoreMock
            .mockRejectedValueOnce(new Error('transient failure'))
            .mockResolvedValueOnce({ ok: true });
        const { loadIndex } = await import('../src/search');

        await expect(loadIndex()).rejects.toThrow(/corrupt or unreadable/);
        // A long-lived process would call loadIndex() again on the next
        // search_docs — this must actually retry restore(), not resolve/reject
        // the same cached promise from the first attempt.
        await expect(loadIndex()).resolves.toEqual({ ok: true });
        expect(restoreMock).toHaveBeenCalledTimes(2);
    });
});

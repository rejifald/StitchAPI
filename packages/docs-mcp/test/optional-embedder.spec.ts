// `@huggingface/transformers` is an OPTIONAL peer: it is unfixably vulnerable in transitive form
// (it pins `onnxruntime-node`, which needs `adm-zip ^0.5.16` — disjoint from the patched 0.6.0 —
// and wants `sharp ^0.34.5`, disjoint from 0.35.x), so a default `npm i @stitchapi/docs-mcp` must
// not install it. These assert the ABSENT-peer path end to end: no throw, no vector, BM25 instead.
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stand in for a consumer who never installed the optional peer. Node reports a missing package
// as ERR_MODULE_NOT_FOUND; `loadTransformers` treats exactly that as "absent" and anything else
// as a real fault worth surfacing.
function moduleNotFound(): Error {
    const e = new Error(
        "Cannot find package '@huggingface/transformers'",
    ) as NodeJS.ErrnoException;
    e.code = 'ERR_MODULE_NOT_FOUND';
    return e;
}

describe('the optional embedder is absent', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('getEmbedder resolves to undefined instead of throwing', async () => {
        vi.doMock('@huggingface/transformers', () => {
            throw moduleNotFound();
        });
        const { getEmbedder } = await import('../src/embed');
        await expect(getEmbedder()).resolves.toBeUndefined();
    });

    it('embed / embedOne report absence rather than inventing a vector', async () => {
        vi.doMock('@huggingface/transformers', () => {
            throw moduleNotFound();
        });
        const { embed, embedOne } = await import('../src/embed');
        await expect(embed(['hello'])).resolves.toBeUndefined();
        await expect(embedOne('hello')).resolves.toBeUndefined();
    });

    it('an empty batch still short-circuits to [] — absence is not the only early return', async () => {
        vi.doMock('@huggingface/transformers', () => {
            throw moduleNotFound();
        });
        const { embed } = await import('../src/embed');
        await expect(embed([])).resolves.toEqual([]);
    });

    it('a NON-absence failure still throws — a broken install must not read as "no peer"', async () => {
        // A corrupt install or an unloadable native binding would otherwise be silently downgraded
        // to worse search results, which is exactly the kind of fault that should be loud.
        vi.doMock('@huggingface/transformers', () => {
            throw new Error('dlopen failed: onnxruntime binding is corrupt');
        });
        const { getEmbedder } = await import('../src/embed');

        // Assert the BEHAVIOUR (it rejects) and that the real cause survives somewhere in the
        // chain — not the top-level message, which the runner's module mocker rewrites with its
        // own wrapper. That wrapping is the same reason `isModuleNotFound` walks `cause`.
        const err = await getEmbedder().then(
            () => undefined,
            (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(Error);
        const chain: string[] = [];
        for (let cur: unknown = err, i = 0; cur && i < 8; i++) {
            chain.push(String((cur as Error).message));
            cur = (cur as { cause?: unknown }).cause;
        }
        expect(chain.join(' | ')).toMatch(/dlopen failed/);
    });
});

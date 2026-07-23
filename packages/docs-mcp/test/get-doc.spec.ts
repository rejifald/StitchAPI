// Unit coverage for getDoc()/loadPages() — the slug/url lookup against the
// bundled data/docs-pages.json, and its error paths. node:fs is mocked so this
// runs without a real bundled install (no build step needed for this test).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const readFileSyncMock = vi.fn();
vi.mock('node:fs', () => ({
    readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
}));

const FIXTURE_PAGES = [
    {
        url: '/docs/guides/resilience/throttle',
        slug: ['guides', 'resilience', 'throttle'],
        title: 'Throttle',
        markdown: '# Throttle\n\nThrottle body.',
    },
    {
        url: '/docs',
        slug: [],
        title: 'Docs',
        markdown: '# Docs\n\nIndex.',
    },
];

describe('getDoc', () => {
    beforeEach(() => {
        readFileSyncMock.mockReset();
        vi.resetModules();
    });

    it('resolves a page by slug', async () => {
        readFileSyncMock.mockReturnValue(JSON.stringify(FIXTURE_PAGES));
        const { getDoc } = await import('../src/get-doc');

        expect(getDoc({ slug: 'guides/resilience/throttle' })).toEqual({
            title: 'Throttle',
            url: '/docs/guides/resilience/throttle',
            markdown: '# Throttle\n\nThrottle body.',
        });
    });

    it('resolves a page by absolute url', async () => {
        readFileSyncMock.mockReturnValue(JSON.stringify(FIXTURE_PAGES));
        const { getDoc } = await import('../src/get-doc');

        expect(
            getDoc({
                url: 'https://stitchapi.dev/docs/guides/resilience/throttle#x',
            }),
        ).toEqual({
            title: 'Throttle',
            url: '/docs/guides/resilience/throttle',
            markdown: '# Throttle\n\nThrottle body.',
        });
    });

    it('resolves the docs root (empty slug)', async () => {
        readFileSyncMock.mockReturnValue(JSON.stringify(FIXTURE_PAGES));
        const { getDoc } = await import('../src/get-doc');

        expect(getDoc({ url: '/docs' })?.title).toBe('Docs');
    });

    it('returns null for an unknown slug (not a throw)', async () => {
        readFileSyncMock.mockReturnValue(JSON.stringify(FIXTURE_PAGES));
        const { getDoc } = await import('../src/get-doc');

        expect(getDoc({ slug: 'nope/not-a-page' })).toBeNull();
    });

    it('returns null for empty input without touching the bundle', async () => {
        readFileSyncMock.mockImplementation(() => {
            throw new Error('should not be called');
        });
        const { getDoc } = await import('../src/get-doc');

        expect(getDoc({})).toBeNull();
        expect(readFileSyncMock).not.toHaveBeenCalled();
    });

    it('throws a friendly error when the bundle is missing', async () => {
        readFileSyncMock.mockImplementation(() => {
            const e = new Error('ENOENT') as NodeJS.ErrnoException;
            e.code = 'ENOENT';
            throw e;
        });
        const { getDoc } = await import('../src/get-doc');

        expect(() => getDoc({ slug: 'x' })).toThrow(/bundled pages not found/);
    });

    it('throws a friendly error when the bundle is corrupt JSON', async () => {
        readFileSyncMock.mockReturnValue('{ not valid json');
        const { getDoc } = await import('../src/get-doc');

        expect(() => getDoc({ slug: 'x' })).toThrow(
            /bundled pages .* are corrupt or unreadable/,
        );
    });
});

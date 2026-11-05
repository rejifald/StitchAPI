import { ogImageUrl } from '@/lib/og-image-url';

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const appDir = fileURLToPath(new URL('..', import.meta.url));

describe('ogImageUrl', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('appends a version query to the route', () => {
        vi.stubEnv('OG_IMAGE_VERSION', 'abc12345');
        expect(ogImageUrl('/og/home')).toMatch(/^\/og\/home\?v=[0-9a-f]{8}$/);
    });

    it('changes when the card design changes', () => {
        vi.stubEnv('OG_IMAGE_VERSION', 'abc12345');
        const before = ogImageUrl('/og/home');
        vi.stubEnv('OG_IMAGE_VERSION', 'def67890');
        expect(ogImageUrl('/og/home')).not.toBe(before);
    });

    it('changes when the text on the card changes', () => {
        vi.stubEnv('OG_IMAGE_VERSION', 'abc12345');
        const card = { title: 'Retries', description: 'Backoff and jitter' };
        expect(ogImageUrl('/og/blog/x', card)).toBe(
            ogImageUrl('/og/blog/x', card),
        );
        expect(ogImageUrl('/og/blog/x', { ...card, title: 'Retry' })).not.toBe(
            ogImageUrl('/og/blog/x', card),
        );
    });
});

// Link previews cache og:image by URL, so an unversioned `/og/...` URL in page
// metadata or JSON-LD freezes whatever image the scraper saw first. Every one
// must go through ogImageUrl().
describe('OG image URLs in metadata', () => {
    const sources = ['app', 'lib']
        .flatMap((dir) =>
            readdirSync(join(appDir, dir), { recursive: true }).map((f) =>
                join(appDir, dir, String(f)),
            ),
        )
        // The /og route handlers themselves, and shared.ts's route-prefix
        // constant (getPageImage versions what it builds from it).
        .filter(
            (f) =>
                /\.tsx?$/.test(f) &&
                !f.includes('/app/og/') &&
                !f.endsWith('/lib/shared.ts'),
        );

    it('has no unversioned /og/ URL', () => {
        const bare = sources.flatMap((file) =>
            readFileSync(file, 'utf8')
                .split('\n')
                .map((line, i) => ({
                    line,
                    at: `${relative(appDir, file)}:${i + 1}`,
                }))
                .filter(
                    ({ line }) =>
                        /['"`]\/og\//.test(line) &&
                        !line.includes('ogImageUrl(') &&
                        !line.trimStart().startsWith('//'),
                )
                .map(({ at }) => at),
        );
        expect(bare).toEqual([]);
    });
});

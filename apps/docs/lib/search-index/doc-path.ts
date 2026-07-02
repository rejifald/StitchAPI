// Normalize a get_doc input (URL or slug) into page slug segments. Pure (no
// fumadocs source import) so it unit-tests without the content graph.

import { docsRoute } from '../shared';

const DOCS_PREFIX = docsRoute.replace(/^\/+/, ''); // 'docs'

/**
 * Accepts an absolute URL (https://stitchapi.dev/docs/guides/throttle#x), a
 * root-relative path (/docs/guides/throttle), or a bare slug (guides/throttle).
 * Returns null only when nothing usable was given; `[]` means the docs index.
 */
export function parseDocPath(input: {
    url?: string;
    slug?: string;
}): string[] | null {
    let path = (input.slug ?? input.url)?.trim();
    if (!path) return null;

    // Drop the origin if it's an absolute URL; ignore parse failures (slug form).
    try {
        path = new URL(path).pathname;
    } catch {
        // not an absolute URL — treat the input as a path/slug
    }

    // Strip query/anchor, surrounding slashes, then the /docs base route.
    path = path.split(/[#?]/)[0].replace(/^\/+/, '');
    if (path === DOCS_PREFIX) return [];
    if (path.startsWith(`${DOCS_PREFIX}/`)) {
        path = path.slice(DOCS_PREFIX.length + 1);
    }

    return path.split('/').filter(Boolean);
}

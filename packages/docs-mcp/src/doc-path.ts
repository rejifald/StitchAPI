// Normalize a get_doc input (URL or slug) into page slug segments. Ported
// verbatim from apps/docs/lib/search-index/doc-path.ts (pure — no fumadocs
// import there either — so this is a straight copy, not a re-derivation) since
// this package can't depend on apps/docs's source. See README.md "Keeping this
// in sync" if that file's normalization rules ever change.

const DOCS_PREFIX = 'docs';

/**
 * Accepts an absolute URL (https://stitchapi.dev/docs/guides/throttle#x), a
 * root-relative path (/docs/guides/throttle), or a bare slug (guides/throttle).
 * Returns null only when nothing usable was given; `[]` means the docs index.
 */
export function parseDocPath(input: {
    url?: string | undefined;
    slug?: string | undefined;
}): string[] | null {
    let path = (input.slug ?? input.url)?.trim();
    if (!path) return null;

    try {
        path = new URL(path).pathname;
    } catch {
        // not an absolute URL — treat the input as a path/slug
    }

    // split() on a string always yields at least one element.
    path = (path.split(/[#?]/)[0] ?? '').replace(/^\/+/, '');
    if (path === DOCS_PREFIX) return [];
    if (path.startsWith(`${DOCS_PREFIX}/`)) {
        path = path.slice(DOCS_PREFIX.length + 1);
    }

    return path.split('/').filter(Boolean);
}

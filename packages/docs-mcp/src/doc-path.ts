// Normalize a get_doc input (URL or slug) into page slug segments. Ported
// from apps/docs/lib/search-index/doc-path.ts (pure — no fumadocs import
// there either — so this is a straight copy, not a re-derivation) since this
// package can't depend on apps/docs's source. Behavior is byte-identical; the
// only local difference is the named `GetDocOptions` interface (CONTRACT P14),
// which apps/docs keeps inline — the docs-mcp-config-parity tether measures
// behavior, not source text. See README.md "Keeping this in sync" if that
// file's normalization rules ever change.

const DOCS_PREFIX = 'docs';

/**
 * A docs-page reference: an absolute URL
 * (https://stitchapi.dev/docs/guides/throttle#x), a root-relative path
 * (/docs/guides/throttle), or a bare slug (guides/throttle). When both fields
 * are set, `slug` wins. `{}` is accepted and resolves to nothing (`getDoc`
 * returns null, `parseDocPath` returns null).
 *
 * The input shape of both `getDoc` and `parseDocPath`.
 */
export interface GetDocOptions {
    url?: string | undefined;
    slug?: string | undefined;
}

/**
 * Accepts an absolute URL (https://stitchapi.dev/docs/guides/throttle#x), a
 * root-relative path (/docs/guides/throttle), or a bare slug (guides/throttle).
 * Returns null only when nothing usable was given; `[]` means the docs index.
 */
export function parseDocPath(input: GetDocOptions): string[] | null {
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

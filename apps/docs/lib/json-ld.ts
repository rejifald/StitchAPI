/**
 * Serialize a JSON-LD value for embedding in a
 * `<script type="application/ld+json" dangerouslySetInnerHTML>`.
 *
 * Why `dangerouslySetInnerHTML` at all: React HTML-escapes string children
 * (`<` → `&lt;`, `&` → `&amp;`, …). Inside a JSON-LD script the body must stay
 * verbatim JSON for a crawler to parse it, so the escaped form is corrupt. Writing
 * the raw body is the Next.js-recommended pattern for JSON-LD — there is no
 * escaping-free alternative (the Metadata API does not cover arbitrary scripts).
 *
 * Why the `<` escape: `JSON.stringify` does NOT escape `<`, so a literal
 * `</script>` appearing in any field (e.g. a doc title) would close the tag early
 * and allow markup injection — the one real vector here. Replacing every `<` with
 * the sequence backslash-u-003c (a JSON-valid escape for `<`) keeps the structured
 * data byte-for-byte valid while making tag breakout impossible. Content is
 * build-time and first-party, so
 * this is defense-in-depth rather than a patched hole — but it costs nothing.
 */
export function jsonLdHtml(data: unknown): string {
    return JSON.stringify(data).replace(/</g, '\\u003c');
}

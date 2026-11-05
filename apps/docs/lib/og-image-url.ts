// Versioned Open Graph image URL: `/og/...?v=<hash>`. Link previews cache the
// image by its URL, so the URL has to change whenever the picture does. The
// hash covers the card's design (OG_IMAGE_VERSION, hashed from the OG sources in
// next.config.mjs) and the text drawn on this particular card, so a retitled
// page gets a fresh preview too. The /og routes ignore the query string.
export function ogImageUrl(
    path: string,
    card: { title?: string; description?: string } = {},
): string {
    const version = fnv1a(
        [process.env.OG_IMAGE_VERSION, card.title, card.description].join('\0'),
    );
    return `${path}?v=${version}`;
}

// 32-bit FNV-1a, hex. Not for security; it only has to change when its input does.
function fnv1a(input: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

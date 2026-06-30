// A faithful re-implementation of github-slugger — the slugger `rehype-slug`
// uses — so the anchors we attach to chunks match the heading ids fumadocs
// actually renders on the page. That is what makes a search hit's
// `url#anchor` a working deep link.
//
// Slugging is stateful per page: a heading that repeats gets `-1`, `-2` …
// suffixes, exactly as on the rendered page. Construct one Slugger per page.

// The punctuation github-slugger strips (its classic character class), built via
// `new RegExp` so the \u escapes stay plain ASCII in source. Anything matched is
// removed; whitespace then collapses to single hyphens. Covers the General and
// Supplemental Punctuation blocks (em dash, smart quotes, …) so a heading like
// "Setup — advanced" slugs the same way the rendered page does.
const SPECIALS = new RegExp(
    "[\\u2000-\\u206F\\u2E00-\\u2E7F\\\\'!\"#$%&()*+,./:;<=>?@\\[\\]^`{|}~]",
    'g',
);
const WHITESPACE = /\s/g;

/** Slug a single string with no de-duplication (github-slugger's `slug()`). */
export function slugSegment(value: string): string {
    return value
        .toLowerCase()
        .trim()
        .replace(SPECIALS, '')
        .replace(WHITESPACE, '-');
}

/** Stateful slugger: repeated slugs gain a numeric suffix, like the rendered page. */
export class Slugger {
    private occurrences = new Map<string, number>();

    slug(value: string): string {
        const base = slugSegment(value);
        let result = base;
        while (this.occurrences.has(result)) {
            const next = (this.occurrences.get(base) ?? 0) + 1;
            this.occurrences.set(base, next);
            result = `${base}-${next}`;
        }
        this.occurrences.set(result, 0);
        return result;
    }

    reset(): void {
        this.occurrences.clear();
    }
}

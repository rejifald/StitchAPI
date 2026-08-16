/* Referral attribution, folded into the page path.

   Vercel Web Analytics already records referrers — the analytics script sends
   `document.referrer` with every initial pageview, and the dashboard's Referrers
   panel breaks it down. That covers GitHub: github.com serves
   `referrer-policy: no-referrer-when-downgrade` and marks README links
   `rel="nofollow"` (NOT `rel="noreferrer"`, the attribute that would suppress it),
   so an HTTPS→HTTPS click from the repo arrives with its referrer intact.

   npm does not. www.npmjs.com serves `referrer-policy: same-origin`, so every click
   from the package page lands as `Direct` — indistinguishable from someone who read
   the README in their editor, ran `npm docs`, or typed the URL. That is the blind
   spot this closes, and npm is plausibly the larger of the two front doors.

   The obvious fixes are all unavailable on the Hobby plan: UTM parameters are a Web
   Analytics Plus feature, custom events via `track()` are Pro-and-up, and a server
   redirect (`/r/npm` → destination) records nothing at all, because Web Analytics is
   a client script and a 308 never renders a page to run it.

   What IS available on every plan is the page path. So a tagged link
   (`?utm_source=npm`) is folded into a synthetic path — `/utm/npm/docs/agents` —
   which lands in the ordinary Pages panel with the destination still legible.

   The param is spelled `utm_source` rather than something private like `from`
   because that is the name Vercel's own `utmSource` dimension reads (see the
   `by`/`filter` vocabulary on /docs/rest-api/web-analytics/aggregates-page-views),
   and the name every other analytics tool reads too. That makes the upgrade path
   free: ON WEB ANALYTICS PLUS, DELETE THIS FOLD — Vercel then captures `utmSource`
   natively and the READMEs need no edit at all. Leaving the fold in place after an
   upgrade would be actively harmful, since it strips the param before Vercel sees it.

   Two consequences worth knowing when reading the dashboard:
     - Only the LANDING pageview carries the tag; soft navigations after it are
       recorded normally. So these rows count referred sessions, not referred views.
     - A referred landing is recorded under `/utm/…` INSTEAD of the bare path. To
       rank pages by true popularity, sum `/docs/x` with every
       `/utm/<source>/docs/x`. */

/* Known sources, named as conventional `utm_source` values so they carry over
   unchanged if the fold is ever removed in favour of native UTM capture.

   These do NOT need to match `referrerHostname` (github.com, …): the tag earns its
   keep precisely where a referrer hostname is absent, so there is nothing to join
   against on the rows that matter.

   An unrecognized value has its param stripped but is NOT folded, so a crawler or a
   spammed `?utm_source=` cannot inflate the Pages panel's cardinality. */
export const REFERRAL_SOURCES: ReadonlySet<string> = new Set([
    'github', // repo README on github.com
    'npm', // package page on npmjs.com
    'hackernews', // Show HN
    'reddit',
    'x', // X / Bluesky posts
    'producthunt',
    'dou', // dou.ua article
    'newsletter',
]);

/** Rewrite a pageview URL so a tagged referral lands on its own `/utm/<source>` path.
 *  Returns the URL unchanged when there is no `utm_source` param. */
export function foldReferralSource(rawUrl: string): string {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        // A malformed URL is not worth losing the pageview over — record it as-is.
        return rawUrl;
    }

    const source = url.searchParams.get('utm_source');
    if (!source) return rawUrl;

    url.searchParams.delete('utm_source');
    if (REFERRAL_SOURCES.has(source)) {
        // `/` would otherwise fold to `/utm/npm/` — keep the root row unsuffixed.
        const path = url.pathname === '/' ? '' : url.pathname;
        url.pathname = `/utm/${source}${path}`;
    }
    return url.toString();
}

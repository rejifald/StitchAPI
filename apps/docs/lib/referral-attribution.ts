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

   What IS available on every plan is the page path. So a tagged link (`?from=npm`)
   is folded into a synthetic path — `/from/npm/docs/agents` — which lands in the
   ordinary Pages panel with the destination still legible in the path.

   Two consequences worth knowing when reading the dashboard:
     - Only the LANDING pageview carries `?from=`; soft navigations after it are
       recorded normally. So these rows count referred sessions, not referred views.
     - A referred landing is recorded under `/from/…` INSTEAD of the bare path. To
       rank pages by true popularity, sum `/docs/x` with every
       `/from/<source>/docs/x`. */

/* Known sources. An unrecognized value has its param stripped but is NOT folded, so
   a crawler or a spammed `?from=` cannot inflate the Pages panel's cardinality. */
export const REFERRAL_SOURCES: ReadonlySet<string> = new Set([
    'gh', // repo README on github.com
    'npm', // package page on npmjs.com
    'hn', // Show HN
    'reddit',
    'x', // X / Bluesky posts
    'ph', // Product Hunt
    'dou', // dou.ua article
    'newsletter',
]);

/** Rewrite a pageview URL so a tagged referral lands on its own `/from/<source>` path.
 *  Returns the URL unchanged when there is no `from` param. */
export function foldReferralSource(rawUrl: string): string {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        // A malformed URL is not worth losing the pageview over — record it as-is.
        return rawUrl;
    }

    const from = url.searchParams.get('from');
    if (!from) return rawUrl;

    url.searchParams.delete('from');
    if (REFERRAL_SOURCES.has(from)) {
        // `/` would otherwise fold to `/from/npm/` — keep the root row unsuffixed.
        const path = url.pathname === '/' ? '' : url.pathname;
        url.pathname = `/from/${from}${path}`;
    }
    return url.toString();
}

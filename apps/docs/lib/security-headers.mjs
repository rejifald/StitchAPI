/**
 * Content-Security-Policy for the docs app — the browser-side backstop for the
 * playground sandbox (RELEASE.md → "Playground browser Phase-2", SEC-10..13).
 *
 * The sandbox runs untrusted user snippets in a dedicated Worker
 * (`/sandbox/sandbox-worker.mjs`, see PlaygroundClient.tsx) which executes the
 * transpiled code via `new Function(...)` (worker-entry.ts). Two invariants:
 *
 *   1. Egress confinement — `connect-src 'self'` means even if the in-worker
 *      fetch shim is bypassed, the browser refuses any cross-origin request.
 *      This is the load-bearing security property the playground depends on.
 *   2. eval is confined to the Worker — the document policy OMITS 'unsafe-eval';
 *      only the worker script's own policy (served on /sandbox/*) grants it, so
 *      a snippet can run but the main page can never eval.
 *
 * NOTE (spike): the document `script-src` uses 'unsafe-inline' as a pragmatic
 * baseline — Next.js inlines hydration bootstrap scripts. Production hardening
 * should move to nonce-based script-src; tracked in RELEASE.md. The security
 * property under test here (egress + worker-confined eval) does not depend on it.
 */

/** Join CSP directives into a single header value. */
function csp(directives) {
    return Object.entries(directives)
        .map(([k, v]) => (v.length ? `${k} ${v.join(' ')}` : k))
        .join('; ');
}

/**
 * Build the Next.js `headers()` entries.
 * @param {{ dev?: boolean }} [opts] dev relaxes script-src (Fast Refresh needs
 *   eval) and connect-src (HMR websocket) so `next dev` keeps working; the
 *   enforced prod posture is what the Playwright harness asserts.
 */
export function buildSecurityHeaders({ dev = false } = {}) {
    // The document (every route except the worker script).
    const documentCsp = csp({
        'default-src': ["'self'"],
        'base-uri': ["'self'"],
        'object-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'img-src': ["'self'", 'data:', 'blob:'],
        'font-src': ["'self'", 'data:'],
        'style-src': ["'self'", "'unsafe-inline'"],
        // No 'unsafe-eval' here — eval stays confined to the sandbox Worker.
        'script-src': dev
            ? ["'self'", "'unsafe-inline'", "'unsafe-eval'"]
            : ["'self'", "'unsafe-inline'"],
        'worker-src': ["'self'", 'blob:'],
        // The egress backstop. dev also allows the HMR websocket.
        'connect-src': dev ? ["'self'", 'ws:', 'wss:'] : ["'self'"],
    });

    // The sandbox Worker script: may eval (it runs user code), but its fetches
    // stay same-origin — the egress backstop applies inside the Worker too.
    const workerCsp = csp({
        'default-src': ["'self'"],
        'script-src': ["'self'", "'unsafe-eval'"],
        'connect-src': ["'self'"],
    });

    return [
        {
            source: '/sandbox/:path*',
            headers: [{ key: 'Content-Security-Policy', value: workerCsp }],
        },
        {
            // Everything EXCEPT /sandbox/* — Next applies every matching rule
            // (header rules accumulate), and two CSP headers are enforced as
            // their intersection, which would strip the Worker's 'unsafe-eval'.
            // The negative lookahead keeps the document policy off the Worker.
            source: '/((?!sandbox/).*)',
            headers: [
                { key: 'Content-Security-Policy', value: documentCsp },
                { key: 'X-Content-Type-Options', value: 'nosniff' },
                {
                    key: 'Referrer-Policy',
                    value: 'strict-origin-when-cross-origin',
                },
            ],
        },
    ];
}

import type { StitchConfig } from 'stitchapi';

// Endpoint resolution for DEDUPE KEYS — "are these two items the same request?" — not for the wire.
// The engine builds the real URL (`buildRequest` in core's engine.ts); this mirrors the endpoint half
// of it so the batch can answer that question BEFORE anything is sent. Deliberately a local dozen
// lines rather than an import: core exports no URL builder, and a dedupe key must not become the
// reason to widen core's public surface.
//
// It matches the engine on the three things that decide identity — `url` is the WHOLE endpoint (never
// joined to `baseUrl`), an absolute `path` wins outright, and a thunk resolves — and diverges on two:
//
//   • `{param}` templates are NOT expanded, and a `{?q}` operator is not treated as a query. The
//     batch passes no `input.params`, so expansion could only erase slots; leaving templates raw
//     keeps two different ones apart. Their spelling is then compared verbatim, which costs a
//     conservative MISS (two templates that would erase to one URL fetch twice) and never a wrong
//     hit — the direction that matters, since a wrong hit hands an item another item's bytes.
//   • the query is SORTED, which the engine has no reason to do. That is the point: `?a=1&b=2` and
//     `?b=2&a=1` are one request, so they have to be one key.

const resolveStr = (v: string | (() => string) | undefined): string =>
    typeof v === 'function' ? v() : (v ?? '');

/**
 * The request target an item resolves to, canonicalised so two spellings of ONE request give one
 * string: `url` when set (it is the complete endpoint), else `baseUrl` + `path`, with the query
 * sorted. `URLSearchParams.sort()` is stable, so repeated keys keep their relative order and only
 * the key order is normalised.
 */
export function resolveTarget(cfg: Partial<StitchConfig>): string {
    const whole = cfg.url !== undefined;
    const tail = whole ? resolveStr(cfg.url) : (cfg.path ?? '');
    // No base for a `url`, and none for an already-absolute `path` — it is its own endpoint.
    let base =
        whole || /^https?:\/\//i.test(tail) ? '' : resolveStr(cfg.baseUrl);
    // Trailing-slash run trimmed by endsWith rather than `/\/+$/`: that regex backtracks
    // polynomially on an all-slashes string (js/polynomial-redos), this is linear.
    while (base.endsWith('/')) base = base.slice(0, -1);
    const endpoint =
        base && !tail.startsWith('/') ? `${base}/${tail}` : base + tail;

    const q = endpoint.indexOf('?');
    if (q < 0) return endpoint;
    const query = new URLSearchParams(endpoint.slice(q + 1));
    query.sort();
    return `${endpoint.slice(0, q)}?${String(query)}`;
}

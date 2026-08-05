// USER CODE — the assembled answer this scenario arrives at, and the subject of C9's line count.
//
// It is ONE seam: a `Surface` whose only hook is `execute` (ADR 0008). `execute` replaces the
// transport at engine.ts:666-674 — inside the resilience chain, so `retry`/`throttle`/`circuit`/
// `timeout`/`trace` still wrap it — and it is the only position in the library that sees a request
// AND its own response in one function call. That is what the rest of the pieces need:
//
//   • the REQUEST, after `cfg.auth.apply` (engine.ts:649), so the store can be keyed by the
//     resolved credential. `Surface.buildRequest` runs before auth and cannot; `ResolvedStitchConfig`
//     carries no `principal` at all (C6).
//   • the RESPONSE, so a 304 can be answered with the stored body. The substituted body rides back
//     on a response whose status is STILL 304, and `httpInterpret` hands it to the caller unchanged,
//     because 304 was never a failure (C1). No custom `interpret` is needed, and the status stays
//     honest: `.inspect().status` reports 304 while `.data` is the resource.
//   • both together, so a response is correlated with ITS OWN request rather than with whatever a
//     closure variable last held (C6 case f measured that pairing losing entries under concurrency).
//
// The cost is that a surface with `execute` ignores `StitchConfig.adapter` (surface.ts:116), so the
// transport is passed in here instead of configured on the stitch.
import type { Surface } from '../../../../packages/core/src/surface';
import type {
    Adapter,
    AdapterRequest,
    AdapterResponse,
} from '../../../../packages/core/src/types';

/** What is stored per key: the two halves that must never be separated. */
export interface ValidatorEntry {
    /** The server's opaque validator, byte-exact — `"v1"` or `W/"v1"` (C7). */
    etag: string;
    /** The body that validator describes. This is what a 304 means "you already have". */
    body: unknown;
}

export interface RevalidateOptions {
    /** The real transport. Required: a surface with `execute` ignores `StitchConfig.adapter`. */
    transport: Adapter;
    /**
     * Key derivation. The default folds in the resolved `Authorization` header, because ETags are
     * per-credential: replaying principal A's validator on principal B's request returns a 304 from
     * a server whose validators are content-derived, and the client then serves A's body to B (C6).
     */
    keyOf?: (req: AdapterRequest) => string;
    /** Cap on stored entries, oldest-first. Default 500 — a poller runs for weeks. */
    entries?: number;
}

/** Counters, so a caller can assert the thing is working rather than assume it. */
export interface RevalidateStats {
    /** 304s answered from the store — the polls that cost nothing. */
    revalidated: number;
    /** 200s whose ETag+body were stored. */
    stored: number;
    /** 304s that arrived with NO stored body (an orphan validator), refetched unconditionally. */
    orphans: number;
    /** 200s carrying no `ETag` — the server is not minting validators, so nothing can be saved. */
    unvalidatable: number;
    /** Live entries. */
    size: number;
}

/** The resolved `Authorization` header, or `''`. The engine never case-folds header names. */
const credentialOf = (headers: Record<string, string>): string => {
    for (const [k, v] of Object.entries(headers))
        if (k.toLowerCase() === 'authorization') return v;
    return '';
};

/** Remove any casing of `If-None-Match` — the engine keeps whatever spelling was written (C7). */
const clearValidator = (headers: Record<string, string>): void => {
    for (const k of Object.keys(headers))
        if (k.toLowerCase() === 'if-none-match') delete headers[k];
};

/**
 * A conditional-request surface: replay the stored validator, and answer a 304 with the stored body.
 *
 * ```ts
 * const issues = stitch({
 *     url: 'https://api.github.com/repos/o/r/issues',
 *     kind: revalidating({ transport: fetchAdapter() }),
 *     auth: bearer(env('GITHUB_TOKEN')),
 * });
 * ```
 */
export function revalidating(
    opts: RevalidateOptions,
): Surface & { readonly stats: RevalidateStats } {
    const { transport } = opts;
    const max = opts.entries ?? 500;
    const keyOf =
        opts.keyOf ??
        ((req: AdapterRequest): string =>
            `${req.method} ${req.url} ${credentialOf(req.headers)}`);
    // Insertion-ordered, so the oldest key is `keys().next()` — the LRU shape `cache` uses too.
    const store = new Map<string, ValidatorEntry>();
    const stats: RevalidateStats = {
        revalidated: 0,
        stored: 0,
        orphans: 0,
        unvalidatable: 0,
        size: 0,
    };

    /** Record what a fresh 200 taught us — or forget the key when it taught us nothing. */
    const learn = (key: string, res: AdapterResponse): void => {
        if (res.status !== 200) return;
        const etag = res.headers['etag'];
        if (etag === undefined) {
            stats.unvalidatable++;
            store.delete(key);
        } else {
            if (store.has(key)) store.delete(key);
            store.set(key, { etag, body: res.body });
            stats.stored++;
            while (store.size > max) {
                const oldest = store.keys().next().value;
                if (oldest === undefined) break;
                store.delete(oldest);
            }
        }
        stats.size = store.size;
    };

    return {
        id: 'http+revalidate',
        stats,
        execute: async (req) => {
            const key = keyOf(req);
            const entry = store.get(key);
            if (entry) req.headers['If-None-Match'] = entry.etag;
            else clearValidator(req.headers);

            const res = await transport(req);

            if (res.status !== 304) {
                learn(key, res);
                return res;
            }
            if (entry) {
                stats.revalidated++;
                // The status stays 304 on purpose — `.inspect()` should not be lied to.
                return { ...res, body: entry.body };
            }
            // ORPHAN VALIDATOR: a stored ETag whose body we no longer have (a restarted process,
            // an evicted entry, a validator persisted without its payload). Returning the 304 as-is
            // would rebuild the C1 bug by hand, so refetch unconditionally. One extra request, once.
            stats.orphans++;
            store.delete(key);
            stats.size = store.size;
            clearValidator(req.headers);
            const fresh = await transport(req);
            learn(key, fresh);
            return fresh;
        },
    };
}

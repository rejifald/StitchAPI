// Derived-key response cache + in-process request coalescing (ADR 0003), shipped behind the
// `stitchapi/cache` subpath so `import { stitch }` pulls none of it (bundle-frugal gate). The
// engine reaches this module by a LAZY dynamic import, only when a stitch carries a `cache`
// block — so the hot path of a cache-free stitch never touches a byte of it.
//
// Browser-first: no `node:*`, no WebCrypto (`crypto.subtle.digest` is async and a JS crypto
// hash is bundle weight). The key is a 128-bit SYNCHRONOUS non-cryptographic digest. It reuses
// the `StitchStore` get/set/increment contract — no new vendor surface — exactly like throttle and
// the circuit breaker, so a shared store makes the cache distributed for free.
import { resolveFingerprint } from './fingerprint';
import type { CachePolicy } from './fingerprint';
import { xxh128 } from './hash';
import type { ResolvedCacheOptions, StitchInput, StitchStore } from './types';
import { parseDuration } from './util';

// The 128-bit synchronous non-crypto key hash now lives in the shared `./hash` module so the cache
// key (ADR 0003) and the schema fingerprint (ADR 0004) ride one well-tested primitive. Re-exported
// here to keep the `stitchapi/cache` surface (and `cache-internals.spec`) importing it from `cache`.
export { xxh128 } from './hash';

// ---------------------------------------------------------------------------
// canonicalisation
// ---------------------------------------------------------------------------
// A deterministic string for semantically-identical requests, so they collide intentionally:
// object keys sorted recursively; arrays + query-param order preserved (both ordered, and we
// build the query ourselves); `null` kept, `undefined` dropped (== absent); Dates as ISO. A
// value that can't be canonicalised deterministically (function, Blob, FormData, stream, …)
// throws Unhashable so the caller can warn-and-pass-through rather than store a wrong key.

class Unhashable extends Error {}

function stable(value: unknown): string {
    if (value === null) return 'null';
    const t = typeof value;
    if (t === 'string') return JSON.stringify(value);
    if (t === 'number')
        return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    if (t === 'boolean') return value ? 'true' : 'false';
    // A type tag (`bigint:`) — NOT a JSON-stringified `"…n"` — so a bigint never collides with a
    // plain string of the same digits-plus-`n` (`42n` ≠ the string `'42n'`). The tag's leading
    // letter also keeps it clear of every other token shape (quoted strings, bare numbers,
    // `true`/`false`/`null`), so `42n` still stays distinct from the number `42`.
    if (t === 'bigint') return `bigint:${(value as bigint).toString()}`;
    if (t === 'undefined') return 'null'; // only reached for an array hole; objects drop it
    if (value instanceof Date) return JSON.stringify(value.toISOString());
    if (Array.isArray(value))
        return `[${value.map((v) => (v === undefined ? 'null' : stable(v))).join(',')}]`;
    if (t === 'object') {
        const proto: unknown = Object.getPrototypeOf(value);
        // Only plain objects (or null-proto) canonicalise deterministically; anything else
        // (Blob/FormData/Map/Set/typed arrays/streams) is treated as unhashable.
        if (proto !== null && proto !== Object.prototype)
            throw new Unhashable('unhashable object');
        const obj = value as Record<string, unknown>;
        const keys = Object.keys(obj)
            .filter((k) => obj[k] !== undefined)
            .sort();
        return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`).join(',')}}`;
    }
    throw new Unhashable(`unhashable value: ${t}`); // function, symbol
}

/** Normalise a URL through the platform `URL` only — lower-cased host, default port dropped,
 *  dot-segments resolved, fragment dropped. A non-absolute URL (custom adapter) passes through. */
function normalizeUrl(raw: string): string {
    try {
        const u = new URL(raw);
        return `${u.protocol}//${u.host}${u.pathname}${u.search}`;
    } catch {
        return raw;
    }
}

// Headers that must never enter the key: secrets (covered by principal scope instead) and
// per-request volatile values that would make every call a miss.
const NEVER_VARY = new Set([
    'authorization',
    'proxy-authorization',
    'cookie',
    'set-cookie',
    'x-api-key',
    'traceparent',
    'tracestate',
    'x-request-id',
    'x-correlation-id',
    'date',
]);

function findHeader(
    headers: Record<string, string> | undefined,
    lowerName: string,
): string | undefined {
    if (!headers) return undefined;
    for (const k of Object.keys(headers))
        if (k.toLowerCase() === lowerName) return headers[k];
    return undefined;
}

function varyHeaderObject(
    headers: Record<string, string> | undefined,
    names: string[],
): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of names) {
        const lc = name.toLowerCase();
        if (NEVER_VARY.has(lc)) continue;
        const val = findHeader(headers, lc);
        if (val !== undefined) out[lc] = val;
    }
    return out;
}

/** The resolved request the key is derived from. `principal` here is already scope-resolved
 *  (absent under `tenancy: 'app'`). */
export interface RequestDescriptor {
    method: string;
    url: string;
    body?: unknown;
    headers?: Record<string, string>;
    principal?: string;
}

/** The frozen key-schema version. Folded into the hashed content AND prefixed onto the stored
 *  key, so any canonicalisation change is a mass self-healing miss, never a stale-key hit.
 *  `k2`: bigint canonicalisation changed from `"<n>n"` to the `bigint:<n>` type tag (it had
 *  collided with the plain string `"<n>n"`), so old bigint-bearing keys must miss, not cross-hit. */
export const KEY_VERSION = 'k2';

function canonicalRequest(
    d: RequestDescriptor,
    varyNames: string[] | undefined,
): string {
    const parts: Record<string, unknown> = {
        x: KEY_VERSION,
        m: d.method.toUpperCase(),
        u: normalizeUrl(d.url),
    };
    // The body is the resolved request payload (for graphql, the { query, variables } the surface
    // packed) — keyed uniformly; canonicalised by stable().
    if (d.body !== undefined) parts['b'] = d.body;
    if (varyNames?.length) {
        const h = varyHeaderObject(d.headers, varyNames);
        if (Object.keys(h).length) parts['h'] = h;
    }
    if (d.principal !== undefined) parts['p'] = d.principal; // canonicalised like a body
    return stable(parts);
}

/** Derive the opaque 128-bit key from a resolved request, or `undefined` when the request is
 *  not hashable (an unserialisable body) — the caller then warns and passes through. With a
 *  `userKey` (the `cache.keyOf` sugar) the request canonicalisation is replaced, but the version
 *  and principal still fold in so scope isolation is never lost. */
export function deriveCacheKey(
    d: RequestDescriptor,
    varyNames: string[] | undefined,
    userKey?: string,
): string | undefined {
    try {
        const seed =
            userKey !== undefined
                ? stable({ x: KEY_VERSION, k: userKey, p: d.principal })
                : canonicalRequest(d, varyNames);
        return xxh128(seed);
    } catch (e) {
        if (e instanceof Unhashable) return undefined;
        throw e;
    }
}

// ---------------------------------------------------------------------------
// in-process request coalescing
// ---------------------------------------------------------------------------
// A process-local map of in-flight runs keyed by the derived key: the first caller is the
// LEADER and runs the request; concurrent identical callers are FOLLOWERS that await the
// leader's one shared promise. A leader failure is NOT shared (the engine catches the rejection
// and re-runs independently). Aborts are ref-counted: the shared run is dropped — and `onCancel`
// fired — only when the LAST participant aborts (the bounded slice of cancellation ADR 0002
// deferred). A `Promise` can't cross processes, so this is in-process by nature (cross-process
// coalescing is the deferred cluster mode).

interface Inflight<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (err: unknown) => void;
    refs: number;
    onCancel?: () => void;
}

/** Options for {@link InflightCoalescer.join}: ref-count this participant via `signal`; the
 *  leader may set `onCancel` to be told when the LAST participant aborts. */
export interface CoalesceJoinOptions {
    signal?: AbortSignal;
    onCancel?: () => void;
}

/** The WRITE end of a shared run: the leader runs the chain and reports the real error to its own
 *  caller. `promise` is here for symmetry only — a leader must never await it (doing so before
 *  `settle`/`fail` deadlocks on itself), which is why rejecting it must be safe with no audience. */
export interface LeaderClaim<T> {
    leader: true;
    promise: Promise<T>;
    settle: (value: T) => void;
    fail: (err: unknown) => void;
}
/** The READ end: a follower has nothing to run, only the leader's one result to await. */
export interface FollowerClaim<T> {
    leader: false;
    promise: Promise<T>;
}

export class InflightCoalescer<T> {
    private readonly map = new Map<string, Inflight<T>>();

    get size(): number {
        return this.map.size;
    }

    /** Join (or start) the in-flight run for `key`. The first caller leads; the rest follow.
     *  Pass a `signal` to ref-count this participant: when every participant has aborted, the
     *  run is dropped and `onCancel` (set by the leader) is invoked. */
    join(
        key: string,
        opts?: CoalesceJoinOptions,
    ): LeaderClaim<T> | FollowerClaim<T> {
        let entry = this.map.get(key);
        const leading = entry === undefined;
        if (!entry) {
            let resolve!: (value: T) => void;
            let reject!: (err: unknown) => void;
            const promise = new Promise<T>((res, rej) => {
                resolve = res;
                reject = rej;
            });
            // The shared promise is an OFFER a follower may take up, not a result anyone is
            // obliged to consume: the leader never awaits it (it owns and throws the real
            // error itself), so with no follower a `fail()` rejects a promise nobody observes
            // — an unhandled rejection that kills the process under Node's default
            // `--unhandled-rejections=throw` (#670). Marking it handled in the same breath as
            // creating it makes that structural rather than dependent on who happens to join.
            // This attaches to a DERIVED promise and discards it; `promise` is untouched, so a
            // follower's `await` still sees the same rejection, same tick, same error identity.
            promise.catch(() => {
                /* an audience of nobody is not an error */
            });
            entry = { promise, resolve, reject, refs: 0 };
            if (opts?.onCancel) entry.onCancel = opts.onCancel;
            this.map.set(key, entry);
        }
        const self = entry;
        self.refs += 1;
        if (opts?.signal) {
            const onAbort = (): void => {
                self.refs -= 1;
                if (self.refs <= 0 && this.map.get(key) === self) {
                    this.map.delete(key);
                    self.onCancel?.();
                }
            };
            if (opts.signal.aborted) onAbort();
            else opts.signal.addEventListener('abort', onAbort, { once: true });
        }
        if (leading) {
            return {
                leader: true,
                promise: self.promise,
                settle: (value: T) => {
                    if (this.map.get(key) === self) this.map.delete(key);
                    self.resolve(value);
                },
                fail: (err: unknown) => {
                    if (this.map.get(key) === self) this.map.delete(key);
                    self.reject(err);
                },
            };
        }
        return { leader: false, promise: self.promise };
    }
}

// ---------------------------------------------------------------------------
// the read-through cache controller
// ---------------------------------------------------------------------------
// One controller per stitch. It owns: key derivation, the TTL read-through over the store under
// the `cache:` namespace, the generation prefixes that power bulk invalidation, the in-process
// LRU cap, and the coalescer. Memory bounding lives HERE, not in the store (a BYO Redis store
// inherits no eviction obligation).

const NS = 'cache:';
const GEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // generation counters effectively never expire
const cacheGenKey = `${NS}gen`;
const stitchGenKey = (id: string): string => `${NS}gen:${id}`;

/** Stable per-stitch id used to namespace its entries and target `seam.invalidate(stitch)`. */
export function cacheStitchId(cfg: { name?: string; path?: string }): string {
    return cfg.name ?? cfg.path ?? 'stitch';
}

/** Bulk invalidation primitive used by the seam surface: bump the cache-wide generation (no id)
 *  or one stitch's generation. Every prior-generation entry becomes unreachable and TTLs out —
 *  no key enumeration, no SCAN, no store-contract extension. */
export async function bumpCacheGeneration(
    store: StitchStore,
    stitchId?: string,
): Promise<void> {
    await store.increment(
        stitchId ? stitchGenKey(stitchId) : cacheGenKey,
        GEN_TTL_MS,
    );
}

const asNum = (v: unknown): number => (typeof v === 'number' ? v : 0);

// The stored shape. A direct value entry: `{ v, s, vary: [] }`. A learned-Vary pointer (no
// value): `{ vary: [names] }`, with the real value living at a secondary key derived from the
// request's values for those headers.
interface StoredEntry {
    v?: unknown;
    s?: number;
    vary?: string[];
}

export interface CacheHit {
    data: unknown;
    status: number;
}

/** A captured cache operation for one logical call: the generation prefix is read once and
 *  reused across `get`/`set`/`delete`, so a hit costs the generation reads + one value read. */
export interface CacheOp {
    get(): Promise<CacheHit | null>;
    set(
        value: unknown,
        status: number,
        varyHeader: string | undefined,
    ): Promise<void>;
    delete(): Promise<void>;
}

export interface CacheController {
    /** Is `method` in the cacheable set (and so eligible for coalescing)? */
    cacheableMethod(method: string): boolean;
    /** Derive the base key for a resolved request, or `undefined` when it is not hashable (CONTRACT.md P6). */
    keyOf(d: RequestDescriptor, input: StitchInput): string | undefined;
    /** Open a cache operation for `baseKey` (reads the live generation prefix once). */
    open(baseKey: string, d: RequestDescriptor): Promise<CacheOp>;
    /**
     * The fingerprint-resolved caching policy (ADR 0004), computed once at controller creation:
     * `'fast'` (serve a hit without re-validating), `'revalidate'` (cache, but re-validate the
     * stored value on each hit), or `'refuse'` (do not cache — the engine passes through).
     */
    readonly policy: CachePolicy;
    /** Why {@link policy} was chosen — surfaced as a trace `reason` (observability, not swallowed). */
    readonly reason: string;
    /** Should a hit be re-validated against the output schema? True exactly when policy is 'revalidate'. */
    readonly revalidateOnHit: boolean;
    /** Join (or start) the in-process coalesced run for `key`. */
    join(key: string): LeaderClaim<CacheHit> | FollowerClaim<CacheHit>;
    /** Coalescing mode after resolving the v1 store-aware default. */
    readonly coalesce: 'process' | false;
    /** Bulk-invalidate every entry this stitch produced (per-stitch generation bump). */
    invalidate(): Promise<void>;
}

export interface CacheControllerOptions {
    /** The stitch's cache block, post-`compose` — list fields are always arrays. */
    config: ResolvedCacheOptions;
    store: StitchStore;
    stitchId: string;
    principal?: string;
    /** The stitch's raw `output` schema (un-wrapped from the Validator), for fingerprinting. */
    output?: unknown;
    /** The stitch's `transform` closure — opaque, so it forces a version/trust decision (ADR 0004). */
    transform?: ((body: unknown) => unknown) | undefined;
    /** The stitch's `pick` dot-path — serialisable, always folds soundly into the generation. */
    pick?: string | undefined;
}

export function createCache(opts: CacheControllerOptions): CacheController {
    const { config, store, stitchId } = opts;
    const ttlMs = parseDuration(config.ttl) ?? 0;
    const tenancy = config.tenancy ?? 'principal';
    const methods = (config.methods ?? ['GET', 'HEAD']).map((m) =>
        m.toUpperCase(),
    );
    const maxEntries = config.entries ?? 1000;
    // Both list fields arrive as arrays: `compose` widened the P7 bare string on the way in, so the
    // controller reads one settled shape rather than re-normalising per key.
    const explicitVary = config.vary?.length
        ? config.vary
              .map((n) => n.toLowerCase())
              .filter((n) => !NEVER_VARY.has(n))
        : undefined;
    // Fold the Standard Schema fingerprint (ADR 0004) ONCE, here at controller creation (which is
    // once per stitch — `ensureCache` memoises it). It resolves three things from the stitch's
    // output/transform/pick + cache options: the GENERATION token (a changed output schema /
    // pick / versioned transform yields a new token → a new bucket → old entries unreachable),
    // the POLICY (fast / revalidate / refuse), and a human-readable REASON for traces. The token is
    // folded into the namespace ALONGSIDE the per-stitch generation counter (decision 8) — it does
    // not replace it: bulk-invalidate bumps the counter, a schema change bumps this token.
    const fp = resolveFingerprint({
        output: opts.output,
        transform: opts.transform,
        pick: opts.pick,
        version: config.fingerprint?.version,
        transformVersion: config.fingerprint?.transform?.version,
        transformTrust: config.fingerprint?.transform?.trust,
        fallback: config.fingerprint?.fallback,
    });
    const fpTag = `f${fp.generation}:`;
    // 'cluster' is reserved for the deferred cross-process protocol; v1 degrades it to process.
    const coalesce: 'process' | false =
        config.coalesce === false ? false : 'process';
    const principalForScope = tenancy === 'app' ? undefined : opts.principal;
    const coalescer = new InflightCoalescer<CacheHit>();
    // In-process LRU of keys THIS process has written; insertion order = recency (Map preserves
    // it; a re-touch deletes+re-sets to move the key to the most-recent end).
    const lru = new Map<string, true>();

    const remember = (k: string): void => {
        if (lru.has(k)) lru.delete(k);
        lru.set(k, true);
        while (lru.size > maxEntries) {
            const oldest = lru.keys().next().value;
            if (oldest === undefined) break;
            lru.delete(oldest);
            // evict from the store (best-effort); a rejecting async store (e.g. Redis) must never
            // become an unhandled rejection — swallow it (matches pipe.ts / postmessage.ts).
            void store.set(oldest, undefined).catch(() => undefined);
        }
    };

    const varySuffix = (d: RequestDescriptor, names: string[]): string =>
        `:h${xxh128(stable(varyHeaderObject(d.headers, names)))}`;

    const varyNamesFrom = (varyHeader: string | undefined): string[] => {
        if (!varyHeader) return [];
        const parts = varyHeader
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
        if (parts.includes('*')) return ['*']; // Vary:* — uncacheable
        return parts.filter((p) => !NEVER_VARY.has(p));
    };

    const genPrefix = async (): Promise<string> => {
        const [cg, sg] = await Promise.all([
            store.get(cacheGenKey),
            store.get(stitchGenKey(stitchId)),
        ]);
        return `g${asNum(cg)}.${asNum(sg)}.${stitchId}.`;
    };

    return {
        policy: fp.policy,
        reason: fp.reason,
        revalidateOnHit: fp.policy === 'revalidate',
        coalesce,

        cacheableMethod(method) {
            return methods.includes(method.toUpperCase());
        },

        keyOf(d, input) {
            // Scope handling lives here: fold the bound principal in under 'principal' scope,
            // omit it under 'app'. The descriptor itself carries no principal (engine concern).
            const scoped: RequestDescriptor =
                principalForScope !== undefined
                    ? { ...d, principal: principalForScope }
                    : d;
            const userKeyOf = config.keyOf;
            const userKey = userKeyOf ? userKeyOf(input) : undefined;
            return deriveCacheKey(scoped, explicitVary, userKey);
        },

        join(key) {
            return coalescer.join(key);
        },

        async invalidate() {
            await bumpCacheGeneration(store, stitchId);
        },

        async open(baseKey, d) {
            const prefix = await genPrefix();
            // The stored key is prefixed with the frozen key-schema version (a derivation change is
            // a mass self-healing miss, never a stale-key hit — ADR 0003 follow-up) and the
            // fingerprint generation token `fpTag` (an output-schema/pick/transform change moves
            // the bucket — ADR 0004). For the 'revalidate' policy the token is empty and freshness
            // comes from re-validation on the hit path instead.
            const valueKey = (suffix = ''): string =>
                `${NS}${KEY_VERSION}:${prefix}${fpTag}${baseKey}${suffix}`;

            const hitFrom = (
                entry: StoredEntry,
                k: string,
            ): CacheHit | null => {
                if (entry.v === undefined) return null;
                remember(k);
                return { data: entry.v, status: entry.s ?? 200 };
            };

            return {
                async get() {
                    const raw = await store.get(valueKey());
                    if (raw == null) return null;
                    const entry = raw as StoredEntry;
                    // Explicit-vary mode folds the headers into baseKey already → single level.
                    if (explicitVary) return hitFrom(entry, valueKey());
                    if (!entry.vary || entry.vary.length === 0)
                        return hitFrom(entry, valueKey());
                    // Learned-Vary pointer: the value lives at a header-derived secondary key.
                    const sk = valueKey(varySuffix(d, entry.vary));
                    const sraw = await store.get(sk);
                    if (sraw == null) return null;
                    return hitFrom(sraw, sk);
                },

                async set(value, status, varyHeader) {
                    const names = explicitVary ? [] : varyNamesFrom(varyHeader);
                    if (names.includes('*')) return; // Vary:* — never store
                    if (explicitVary || names.length === 0) {
                        const k = valueKey();
                        await store.set(
                            k,
                            {
                                v: value,
                                s: status,
                                vary: [],
                            } satisfies StoredEntry,
                            ttlMs || undefined,
                        );
                        remember(k);
                        return;
                    }
                    // Learned Vary: a pointer at the base key + the value at the secondary key.
                    await store.set(
                        valueKey(),
                        { vary: names } satisfies StoredEntry,
                        ttlMs || undefined,
                    );
                    const sk = valueKey(varySuffix(d, names));
                    await store.set(
                        sk,
                        {
                            v: value,
                            s: status,
                            vary: names,
                        } satisfies StoredEntry,
                        ttlMs || undefined,
                    );
                    remember(sk);
                },

                async delete() {
                    if (!explicitVary) {
                        const raw = await store.get(valueKey());
                        const entry = raw as StoredEntry | null | undefined;
                        if (entry?.vary?.length)
                            await store.set(
                                valueKey(varySuffix(d, entry.vary)),
                                undefined,
                            );
                    }
                    await store.set(valueKey(), undefined);
                    lru.delete(valueKey());
                },
            };
        },
    };
}

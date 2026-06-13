// `seam`: a long-lived entity that stitches BELONG to (ADR 0002). Unlike a plain config fragment
// or factory (which shares config only), a seam shares **runtime**: one `store`, one `vault`, one
// trace sink, and one throttle bucket, plus a registry/lifecycle (`flush`/`close`). Its decisive
// job is the trusted principal boundary: `seam.as(req.user.id)` binds identity in the closure, so
// a caller can never name another principal (the principal is never in `StitchInput`). Auth is
// principal-scoped (separate sessions, no bleed); throttle stays shared (one bucket).
import {
    type SharedRuntime,
    compose,
    makeStitch,
    redactConfig,
    resolveTrace,
} from './stitch';
import {
    type Throttle,
    chainThrottle,
    createStoreThrottle,
    memoryStore,
    vaultView,
} from './store';
import type {
    Seam,
    SeamOptions,
    Stitch,
    StitchConfig,
    StitchStore,
    ThrottleOptions,
    TraceSink,
} from './types';

// Per-seam id so the shared bucket's store-counter key never collides across seams sharing a store.
let seamCounter = 0;

/**
 * The seam's shared throttle bucket. Member stitches all acquire it under ONE seam-stable key, so
 * the budget (rate + in-process concurrency) pools across every stitch — "one shared bucket"
 * (ADR 0002 §3). `scope: 'host'` keeps the engine's per-host key instead (pools per host).
 */
function seamBucket(
    opts: ThrottleOptions | undefined,
    store: StitchStore,
    seamId: string,
): Throttle {
    const inner = createStoreThrottle(opts, store);
    if (opts?.scope === 'host') return inner; // the host key already pools across the seam
    const key = `seam:${seamId}`;
    return {
        acquire: () => inner.acquire(key),
        release: () => {
            inner.release(key);
        },
    };
}

// The runtime + registry shared by a seam and all the principal handles derived from it.
interface SharedSeam {
    fragment: Partial<StitchConfig>;
    store: StitchStore;
    secretStore?: StitchStore; // raw backend behind the vault, when separate from `store`
    vault: StitchStore;
    trace: TraceSink;
    throttle: Throttle;
    stitches: Stitch[]; // registry of root-created stitches (lifecycle/introspection)
}

function makeHandle(shared: SharedSeam, principal: string | undefined): Seam {
    const build = <T>(
        config: string | Partial<StitchConfig>,
        isGql = false,
    ): Stitch<T> => {
        const own: Partial<StitchConfig> =
            typeof config === 'string' ? { path: config } : { ...config };
        // A member's OWN throttle STACKS on the seam bucket (tighten-only, ADR 0002 §5): the engine
        // keys it per-stitch, so it limits just this stitch ON TOP OF the shared budget — it can
        // add a stricter gate but never replace or escape the seam's.
        const local = own.throttle
            ? createStoreThrottle(own.throttle, shared.store)
            : undefined;
        const throttle = local
            ? chainThrottle([shared.throttle, local])
            : shared.throttle;

        const cfg: Partial<StitchConfig> = {
            ...own,
            extends: [shared.fragment, ...(own.extends ?? [])],
        };
        if (isGql) {
            cfg.kind = 'graphql';
            cfg.method = 'POST';
            cfg.unwrap = own.unwrap ?? 'data';
        }

        const runtime: SharedRuntime = {
            store: shared.store,
            vault: shared.vault,
            trace: shared.trace,
            throttle,
        };
        if (principal !== undefined) runtime.principal = principal;
        // Only the root seam accrues a registry; per-principal handles are ephemeral (one per
        // request), so they don't retain their stitches — that would grow unbounded.
        if (principal === undefined)
            runtime.register = (s) => {
                shared.stitches.push(s);
            };
        return makeStitch<T>(cfg, runtime);
    };

    return {
        stitch: (config) => build(config),
        graphql: (config) => build(config, true),
        as: (p) => makeHandle(shared, p),
        async flush() {
            await shared.trace.flush?.();
        },
        async close() {
            await shared.trace.flush?.();
            await shared.store.close?.();
            if (shared.secretStore && shared.secretStore !== shared.store)
                await shared.secretStore.close?.();
            shared.stitches.length = 0;
        },
        // The shared fragment, redacted (no live store/vault/auth/adapter) — exfil-at-rest (§4/§6).
        get __config() {
            return redactConfig(compose(shared.fragment));
        },
        __seam: true,
    };
}

/**
 * Create a seam — the primitive for any **shared surface** (a third-party API, an internal
 * service). Pass the shared defaults its stitches inherit (baseUrl, headers, throttle, retry,
 * auth, sink) and, optionally, a hardened `secretStore` for the vault. Members are created with
 * `.stitch()` / `.graphql()`; bind a principal with `.as(id)`; flush/close via the lifecycle.
 */
export function seam(options: SeamOptions = {}): Seam {
    const { secretStore, ...rest } = options;
    const fragment = rest as Partial<StitchConfig>;
    const store = fragment.store ?? memoryStore();
    const vault = vaultView(secretStore ?? store);
    const trace = resolveTrace(fragment.trace);
    const seamId = `s${(seamCounter += 1)}`;
    const shared: SharedSeam = {
        fragment,
        store,
        vault,
        trace,
        throttle: seamBucket(fragment.throttle, store, seamId),
        stitches: [],
        ...(secretStore ? { secretStore } : {}),
    };
    return makeHandle(shared, undefined);
}

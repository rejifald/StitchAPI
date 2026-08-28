// The public API surface of the package. smoke.spec.ts exercises `stitch` end-to-end but nothing
// pins the EXPORT surface itself, so an accidental removal/rename of a public symbol would slip
// past the test suite (only attw/build catches it, late). This guards the contract: the documented
// value exports are present and of the expected kind.
//
// Scope is the root barrel (src/index.ts) plus the subpaths whose surface is a DECISION rather
// than an implementation detail — `stitchapi/auth`, split off deliberately (ADR 0021), and
// `stitchapi/fingerprint`, whose registry folded into one namespace. Both directions of each fold
// live here on purpose: the members that must be present, and the spellings they replaced pinned
// ABSENT beside `REMOVED_PARSERS` and `REMOVED_SECRET_FUNCTIONS`, so "did an old name drift back
// as an alias?" is one file to read rather than three.
import * as api from '../src';
import * as authApi from '../src/auth';
import * as fingerprintApi from '../src/fingerprint';
import type { SchemaFingerprinter } from '../src/fingerprint';
import type { AdapterResponse } from '../src/types';

// Every documented function/guard export (systemClock is an object; the error classes are below).
const FUNCTIONS = [
    'stitch',
    'drift',
    'graphql',
    'seam',
    'fetchAdapter',
    'axiosAdapter',
    'xhrAdapter',
    'createTrace',
    'consoleSink',
    'fileSink',
    'multiplex',
    'loggerSink',
    'otlpSink',
    'otlpHttpExporter',
    'toOtlpJson',
    'memoryStore',
    'validate',
    'compile',
    'isStitch',
    'isSeam',
    // The `exactOptionalPropertyTypes` companion: public because config authoring under that flag
    // otherwise needs the `...(key !== undefined ? { key } : {})` spread dance at every call site,
    // and a peer package building a `StitchConfig` hits it as often as core does.
    'compact',
    // The verdict (ADR 0022 Decision 2), public because a surface author must compose it: an
    // `interpret` hook REPLACES the default rather than layering on it, so a surface with its own
    // body rules needs this to keep the caller's `verdict` config working. The one composition
    // point — its narrower and wider siblings are pinned ABSENT below.
    'verdictOf',
] as const;

// The three house token grammars (CONTRACT.md P17/P25, ADR 0023), one namespace per dimension.
// Each is public for one reason — a peer package that takes an authored duration / size / rate
// handles it the way core does instead of mirroring the grammar and drifting from it — and that
// reason only holds while they stay on the barrel.
//
// Pinned as a PAIR, not as two independent members. A namespace that kept `parse` and lost
// `format` would still pass a "is it exported?" check while silently dropping half the contract,
// and the encode direction is the half with no other caller inside core to notice it missing.
const TOKEN_GRAMMARS = ['duration', 'size', 'rate'] as const;

// The verb-prefixed functions these namespaces REPLACED, pinned absent so they cannot drift back.
// `parseDuration` / `parseBytes` / `parseRate` were the whole grammar surface until the pair
// landed; re-adding one as an alias would put two spellings of one call on the barrel, which is
// the same "three names for one decision" trap the verdict scopes below are pinned against.
const REMOVED_PARSERS = ['parseDuration', 'parseBytes', 'parseRate'] as const;

// The trace-redaction escape hatch (ADR 0018; ADR 0021's export table deliberately keeps it on the
// ROOT rather than moving it to `stitchapi/auth` with the strategies that register into it).
// Public for the one credential the built-in denylist/stems don't catch, and load-bearing for a
// real cross-package consumer: `@stitchapi/query-core` imports it from this barrel to extend its
// header denylist rather than fork a parallel list that would drift.
//
// Pinned as a WHOLE, not as three members: `register` without `has` leaves a caller unable to
// audit what it just widened, and `redact` is the only one core's own engine would notice missing.
const SECRET_NAMESPACE_MEMBERS = ['register', 'has', 'redact'] as const;

// The three verb-prefixed functions `secrets` REPLACED, pinned absent for the same reason as the
// parsers above — one dimension, one name, the verb at the call site.
const REMOVED_SECRET_FUNCTIONS = [
    'registerSecretKey',
    'isSecretKey',
    'redactSecretsDeep',
] as const;

// The other two scopes of the same decision, pinned ABSENT from the root. `classifyStatus` (the
// status alone) answers the engine's transport-health question and has no surface-author use;
// `httpInterpret` is the http surface's own hook, reachable as `httpSurface.interpret`. Three names
// on the barrel for one decision invites composing the wrong one — which is precisely the mistake
// that put a flag-failed `200` through the circuit's transport-failure path.
const INTERNAL_VERDICT_SCOPES = ['classifyStatus', 'httpInterpret'] as const;

// The per-vendor fingerprint-strategy registry on `stitchapi/fingerprint` (ADR 0004), one
// namespace over one process-local `Map`.
//
// Pinned as a WHOLE, like `secrets` above: `register` without `get` leaves a host unable to check
// what it just registered or to see why a stitch it expected to cache is refusing, and `clear` is
// the one member with no in-app caller at all — every conformance suite in the five
// `@stitchapi/fingerprint-*` packages resets through it, and nothing inside core would notice it
// missing.
const FINGERPRINTER_NAMESPACE_MEMBERS = [
    'register',
    'get',
    'list',
    'clear',
] as const;

// The four verb-prefixed functions `fingerprinters` REPLACED, pinned absent for the same reason as
// the parsers and the secret trio — one dimension, one name, the verb at the call site. This
// subpath makes the pin sharper than either: `src/fingerprint.ts` IS the entry, so re-exporting one
// of these puts it straight back on the published surface with no barrel in between to stop it.
const REMOVED_FINGERPRINTER_FUNCTIONS = [
    'registerFingerprinter',
    'getFingerprinter',
    'listFingerprinters',
    'clearFingerprinters',
] as const;

// The auth surface moved to its own subpath (ADR 0021). Pinned in BOTH directions: present on
// `stitchapi/auth`, and ABSENT from the root — a re-export there would quietly put oauth2 and
// cookieSession back on every consumer's `import { stitch }` path, which is the point of the split.
const AUTH_FUNCTIONS = [
    'bearer',
    'apiKey',
    'basic',
    'cookieSession',
    'oauth2',
    'env',
    'optionalEnv',
    'secretsFile',
    'secretFrom',
] as const;

describe('public API surface (src/index.ts)', () => {
    test.each(FUNCTIONS)('exports %s as a function', (name) => {
        expect(typeof (api as Record<string, unknown>)[name]).toBe('function');
    });

    test.each(TOKEN_GRAMMARS)('exports %s as a parse/format pair', (name) => {
        const ns = (api as Record<string, unknown>)[name] as
            Record<string, unknown> | undefined;
        expect(typeof ns).toBe('object');
        expect(typeof ns?.['parse']).toBe('function');
        expect(typeof ns?.['format']).toBe('function');
    });

    // The property suite proves the round-trip across the whole input space; this pins that the
    // exported pair is the one that has it, so a barrel wired to some other encoder fails here.
    test('the exported pairs round-trip through the barrel', () => {
        expect(api.duration.parse(api.duration.format(90_000))).toBe(90_000);
        expect(api.size.parse(api.size.format(1536))).toBe(1536);
        expect(
            api.rate.parse(api.rate.format({ count: 2, per: 1000 })),
        ).toEqual({ count: 2, per: 1000 });
    });

    test.each(REMOVED_PARSERS)(
        'does NOT export %s — the namespace pair replaced it',
        (name) => {
            expect(name in (api as Record<string, unknown>)).toBe(false);
        },
    );

    test.each(SECRET_NAMESPACE_MEMBERS)(
        'exports secrets.%s as a function',
        (member) => {
            expect(
                typeof (api.secrets as Record<string, unknown>)[member],
            ).toBe('function');
        },
    );

    // The pin is behavioural, not just structural: a barrel wired to some other predicate — or to
    // a `redact` that does not read the registry `register` writes — passes the typeof checks
    // above and fails here. `register` is process-wide and additive by contract, so the name is
    // namespaced to this spec to stay inert for every other test in the run.
    test('the exported namespace is the one backing the shared denylist', () => {
        const key = 'x_public_api_surface_spec_cred';
        expect(api.secrets.has(key)).toBe(false);
        api.secrets.register(key);
        expect(api.secrets.has(key)).toBe(true);
        expect(api.secrets.redact({ [key]: 'live', page: 2 })).toEqual({
            [key]: 'REDACTED',
            page: 2,
        });
    });

    test.each(REMOVED_SECRET_FUNCTIONS)(
        'does NOT export %s — the namespace replaced it',
        (name) => {
            expect(name in (api as Record<string, unknown>)).toBe(false);
        },
    );

    test.each(INTERNAL_VERDICT_SCOPES)(
        'does NOT export %s — one composition point, not three',
        (name) => {
            expect(name in (api as Record<string, unknown>)).toBe(false);
        },
    );

    test('httpInterpret stays reachable as the http surface’s own hook', () => {
        expect(typeof api.httpSurface.interpret).toBe('function');
    });

    test.each(AUTH_FUNCTIONS)('does NOT re-export %s from the root', (name) => {
        expect(name in (api as Record<string, unknown>)).toBe(false);
    });

    test('exports the built-in surfaces with their stable ids', () => {
        expect(api.httpSurface.id).toBe('http');
        expect(api.graphqlSurface.id).toBe('graphql');
    });

    test('exports systemClock with the Clock shape', () => {
        expect(typeof api.systemClock.now).toBe('function');
        expect(typeof api.systemClock.sleep).toBe('function');
        expect(typeof api.systemClock.setTimer).toBe('function');
        expect(typeof api.systemClock.clearTimer).toBe('function');
    });

    test('exports the error classes (RateLimitError extends StitchError extends Error)', () => {
        const response: AdapterResponse = {
            status: 429,
            headers: {},
            body: {},
        };
        const rate = new api.RateLimitError({ status: 429, response });
        expect(rate).toBeInstanceOf(Error);
        // CONTRACT.md P10: one taxonomy, parity by inheritance rather than a hand-kept copy.
        expect(rate).toBeInstanceOf(api.StitchError);
        expect(rate.status).toBe(429);
        expect(rate.name).toBe('RateLimitError');
        expect(new api.StitchError('x')).toBeInstanceOf(Error);
        // ...but not the other way round: the base is not a rate limit.
        expect(new api.StitchError('x')).not.toBeInstanceOf(api.RateLimitError);
    });
});

describe('public API surface (src/auth.ts → stitchapi/auth)', () => {
    test.each(AUTH_FUNCTIONS)('exports %s as a function', (name) => {
        expect(typeof (authApi as Record<string, unknown>)[name]).toBe(
            'function',
        );
    });

    // The subpath carries the auth surface and nothing else — no accidental re-export of the
    // engine, which would defeat the split from the other direction.
    test('exports exactly the auth surface, nothing more', () => {
        expect(Object.keys(authApi).sort()).toEqual([...AUTH_FUNCTIONS].sort());
    });
});

describe('public API surface (src/fingerprint.ts → stitchapi/fingerprint)', () => {
    // The registry is process-local and this spec registers into it, so leave it as found.
    beforeEach(() => {
        fingerprintApi.fingerprinters.clear();
    });
    afterEach(() => {
        fingerprintApi.fingerprinters.clear();
    });

    test.each(FINGERPRINTER_NAMESPACE_MEMBERS)(
        'exports fingerprinters.%s as a function',
        (member) => {
            expect(
                typeof (
                    fingerprintApi.fingerprinters as Record<string, unknown>
                )[member],
            ).toBe('function');
        },
    );

    // The pin is behavioural, not just structural, and it pins the FACADE specifically. The four
    // implementations stay plain module functions — `resolveFingerprint` calls the lookup directly
    // rather than through the namespace, so that a consumer importing `fingerprinters` is the only
    // one who pays for all four (esbuild will not split an object literal to drop a dead member).
    // That split is only safe while both halves read one `Map`: a namespace built over its own
    // registry passes every typeof check above, and fails here, because the strategy it accepted
    // never reaches the resolver that is supposed to use it.
    test('the exported namespace is the one the resolver reads', () => {
        const schema = {
            '~standard': {
                version: 1,
                vendor: 'x-public-api-surface-spec',
                validate: (value: unknown) => ({ value }),
            },
        } as const;
        const strategy: SchemaFingerprinter = {
            vendor: 'x-public-api-surface-spec',
            range: '*',
            fingerprint: () => ({ token: 'pinned', strength: 'strong' }),
        };

        // Unregistered → the resolver refuses, and the namespace agrees nothing is there.
        expect(
            fingerprintApi.fingerprinters.get(strategy.vendor),
        ).toBeUndefined();
        expect(
            fingerprintApi.resolveFingerprint({ output: schema }).policy,
        ).toBe('refuse');

        fingerprintApi.fingerprinters.register(strategy);
        expect(fingerprintApi.fingerprinters.get(strategy.vendor)).toBe(
            strategy,
        );
        expect(fingerprintApi.fingerprinters.list()).toContain(strategy);
        // The registration the FACADE took is the one the resolver's own call site sees.
        expect(
            fingerprintApi.resolveFingerprint({ output: schema }),
        ).toMatchObject({
            policy: 'fast',
            reason: 'sound structural fingerprint',
        });

        fingerprintApi.fingerprinters.clear();
        expect(
            fingerprintApi.fingerprinters.get(strategy.vendor),
        ).toBeUndefined();
        expect(
            fingerprintApi.resolveFingerprint({ output: schema }).policy,
        ).toBe('refuse');
    });

    test.each(REMOVED_FINGERPRINTER_FUNCTIONS)(
        'does NOT export %s — the namespace replaced it',
        (name) => {
            expect(name in (fingerprintApi as Record<string, unknown>)).toBe(
                false,
            );
        },
    );
});

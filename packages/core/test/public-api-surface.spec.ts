// The public API surface of the package (src/index.ts). smoke.spec.ts exercises `stitch` end-to-end
// but nothing pins the EXPORT surface itself, so an accidental removal/rename of a public symbol
// would slip past the test suite (only attw/build catches it, late). This guards the contract: the
// documented value exports are present and of the expected kind.
import * as api from '../src';
import { memoryStore } from '../src';
import * as authApi from '../src/auth';
import * as testingApi from '../src/testing';
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

// The vendor-facing conformance kit on `stitchapi/testing`, one namespace over the four pluggable
// seams. `ContractReport.seam` was already the discriminator; the exports refused to be, so a
// third-party seam author read four `verify<Seam>Contract` names off one entry to make one
// decision. This is the export-surface reading of the same rule the token grammars and `secrets`
// applied on the root: one name per dimension, the dimension named at the call site.
//
// Pinned as a WHOLE, not as six members. The seams are load-bearing for real out-of-repo
// consumers — every `@stitchapi/fingerprint-*`, `@stitchapi/redis`, `deno-kv`, `cloudflare-kv`,
// `react-native` and `expo` package proves compliance through them in its own CI — and `assert` is
// the only one core's own suites would notice missing, since a verifier that returns a report
// nobody throws on is a spec that always passes.
const CONFORMANCE_MEMBERS = [
    'assert',
    'store',
    'adapter',
    'sink',
    'fingerprint',
    'fixture',
] as const;

// The six names `conformance` REPLACED, pinned absent for the same reason as the parsers and the
// secret functions on the root. `adapterContractFixture` is in this list deliberately: it is not a
// verifier, but it is not an independent capability either — it is the server half of the adapter
// contract, unusable apart from `conformance.adapter`, so leaving it standalone would have kept one
// loose `*Contract*` name beside the namespace that replaced the other five.
const REMOVED_CONFORMANCE_FUNCTIONS = [
    'assertConformance',
    'verifyStoreContract',
    'verifyAdapterContract',
    'verifySinkContract',
    'verifyFingerprintContract',
    'adapterContractFixture',
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

// The third entry this spec guards. `stitchapi/testing` is not size-gated and never reaches a
// production bundle, so nothing else in the build would notice a member going missing — and its
// consumers are the packages LEAST able to absorb a silent break, since a vendor's CI is the whole
// point of the kit. The pins live here rather than in conformance-kit.spec.ts (which exercises what
// the verifiers DO) so that all three entries' export surfaces are pinned in one file, and a fourth
// entry has an obvious place to land.
describe('public API surface (src/testing.ts → stitchapi/testing)', () => {
    test.each(CONFORMANCE_MEMBERS)(
        'exports conformance.%s as a function',
        (member) => {
            expect(
                typeof (testingApi.conformance as Record<string, unknown>)[
                    member
                ],
            ).toBe('function');
        },
    );

    // The namespace carries the kit and nothing beyond it: an extra member here is a capability
    // that skipped the "is this a seam?" question the four names answer.
    test('the namespace is exactly the kit, nothing more', () => {
        expect(Object.keys(testingApi.conformance).sort()).toEqual(
            [...CONFORMANCE_MEMBERS].sort(),
        );
    });

    // Behavioural, not just structural: a namespace wired to some other function — or to a `store`
    // that reports on a seam it did not run — passes the typeof checks above and fails here. The
    // report's `seam` is the discriminator the namespace is keyed by, so this is the pin that says
    // the key and the report agree.
    test('each member reports the seam its name claims', async () => {
        const store = await testingApi.conformance.store(memoryStore, {
            ttl: '80ms',
        });
        expect(store.seam).toBe('store');
        expect(store.ok).toBe(true);

        const seen: string[] = [];
        const sink = await testingApi.conformance.sink(() => ({
            handle: (event) => {
                seen.push(event.type);
            },
        }));
        expect(sink.seam).toBe('sink');
        expect(sink.ok).toBe(true);
        expect(seen.length).toBeGreaterThan(0);

        // `assert` is a no-op on a clean report and throws a listing on a dirty one.
        expect(() => {
            testingApi.conformance.assert(store);
        }).not.toThrow();
        expect(() => {
            testingApi.conformance.assert({
                seam: 'store',
                ok: false,
                passed: [],
                violations: [{ rule: 'r', detail: 'd' }],
            });
        }).toThrow(/store contract: 1 violation/);

        // The fixture is the adapter contract's server half — the one member that is not a
        // verifier, pinned as the echo function it is.
        expect(
            testingApi.conformance.fixture({
                method: 'GET',
                path: '/text',
                headers: {},
            }).body,
        ).toBe('stitch-conformance-text');
    });

    test.each(REMOVED_CONFORMANCE_FUNCTIONS)(
        'does NOT export %s — the namespace replaced it',
        (name) => {
            expect(name in (testingApi as Record<string, unknown>)).toBe(false);
        },
    );
});

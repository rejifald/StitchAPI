// CJS entries share the registries that must agree across them (#898).
//
// The ESM build code-splits, so every entry imports one shared chunk and a module-level `Map`/`Set`
// is one object. The CJS build does not: each `lib/*.js` entry bundles its own copy of every module
// it reaches, so a module-level registry exists once PER ENTRY. A host that registers into one
// entry and reads through another then sees an empty registry — for the secret-key denylist that is
// a credential in a trace (`require('stitchapi/auth').apiKey({ in: 'query', name })` registers in
// auth.js; the engine in index.js and the sink in otlp.js scrub against their own copies).
//
// These tests load the BUILT CJS entries with a real `require`, the way a CommonJS consumer does,
// and drive one entry through another. They need the build, so — like mcp-e2e.spec.ts — they skip
// cleanly in a src-only run and run once core is built (CI builds it before `pnpm test`).
//
// The state under test is the set `processWide` (src/process-wide.ts) backs: the secret-key
// denylist, the fingerprinter registry, the host-pooled rate budget and the seam-id counter.
import type { Adapter, Stitch } from '../src';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const LIB = join(import.meta.dirname, '..', 'lib');
const ENTRIES = ['index', 'auth', 'otlp', 'fingerprint', 'cache', 'graphql'];
const BUILT = ENTRIES.every((name) => existsSync(join(LIB, `${name}.js`)));

const requireCjs = createRequire(import.meta.url);

// One `require` per entry: each is its own module instance, which is the point. The cast names the
// entry's source module, which is what the build was made from.
const load = (entry: string): unknown => requireCjs(join(LIB, `${entry}.js`));
const root = (): typeof import('../src') =>
    load('index') as typeof import('../src');
const auth = (): typeof import('../src/auth') =>
    load('auth') as typeof import('../src/auth');
const otlpEntry = (): typeof import('../src/otlp') =>
    load('otlp') as typeof import('../src/otlp');
const fingerprintEntry = (): typeof import('../src/fingerprint') =>
    load('fingerprint') as typeof import('../src/fingerprint');
const cacheEntry = (): typeof import('../src/cache') =>
    load('cache') as typeof import('../src/cache');
const graphqlEntry = (): typeof import('../src/graphql') =>
    load('graphql') as typeof import('../src/graphql');

// A name no other test or default registers, so a leftover registration cannot mask a failure.
const unique = (label: string): string =>
    `x-cjs-${label}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!BUILT)('CJS entries share process-wide registries', () => {
    test('the CJS build really does duplicate module state per entry (the premise)', () => {
        // Two `require`s of different entries return different module objects; the registries they
        // would hold are only shared because `processWide` puts them on globalThis. If a future
        // build starts splitting CJS this premise goes away and the suite can be retired.
        expect(root()).not.toBe(auth());
        expect(requireCjs(join(LIB, 'index.js'))).toBe(root());
    });

    test('a key registered through the root is scrubbed by the otlp entry', async () => {
        const { stitch, secrets } = root();
        const { otlp } = otlpEntry();
        const name = unique('root');
        secrets.register(name);

        const spans: { attributes: Record<string, unknown> }[] = [];
        const sink = otlp.sink({
            exporter: {
                export(batch) {
                    spans.push(...batch);
                },
            },
        });
        const ok: Adapter = () =>
            Promise.resolve({ status: 200, headers: {}, body: { ok: true } });
        const call = stitch({
            name: 'cjsLeak',
            url: `http://api.example.test/p?${name}=hunter2`,
            adapter: ok,
            trace: sink,
        });
        await call();
        await sink.flush?.();

        const urls = spans
            .map((s) => s.attributes['url.full'])
            .filter((u): u is string => typeof u === 'string');
        expect(urls.length).toBeGreaterThan(0);
        for (const url of urls) expect(url).not.toContain('hunter2');
    });

    test('a key registered by `apiKey({ in: "query" })` in the auth entry reaches the root denylist', () => {
        const { secrets } = root();
        const name = unique('auth');
        expect(secrets.has(name)).toBe(false);

        auth().apiKey({ in: 'query', name, secret: 'tok' });

        expect(secrets.has(name)).toBe(true);
    });

    test('a fingerprinter registered through the fingerprint entry is seen by the cache entry', () => {
        const vendor = unique('vendor');
        fingerprintEntry().fingerprinters.register({
            vendor,
            range: '*',
            fingerprint: () => ({
                token: 'structural-token',
                strength: 'strong',
            }),
        });
        const output = {
            '~standard': {
                version: 1,
                vendor,
                validate: () => ({ value: {} }),
            },
        };

        const cache = cacheEntry().createCache({
            config: { ttl: 0 },
            store: root().memoryStore(),
            stitchId: 'cjs',
            output,
        });

        // With the registry split the cache entry would find no strategy for the vendor and refuse.
        expect(cache.policy).toBe('fast');
        expect(cache.reason).toBe('sound structural fingerprint');
    });

    describe('rate budgets over a real socket', () => {
        let server: MockServer;
        beforeAll(async () => {
            server = await startMockServer();
            server.route('POST', '/pool', { body: { data: { ok: true } } });
        });
        afterAll(async () => {
            await server.close();
        });

        // 1 when the call was held back by a throttle wait, else 0.
        const paced = async (s: Stitch): Promise<number> => {
            let throttled = 0;
            for await (const ev of s.stream()) {
                if (
                    ev.type === 'progress' &&
                    ev.phase === 'throttled' &&
                    (ev.waited ?? 0) > 0
                )
                    throttled = 1;
            }
            return throttled;
        };

        test("a pool:'host' rate budget is one budget across the root and graphql entries", async () => {
            // Two entries, one host: a 20/s budget paces exactly one of two concurrent calls (50 ms).
            // With a registry per entry each call would draw from a budget of its own and neither wait.
            const throttle = { rate: '20/s', pool: 'host' } as const;
            const viaRoot = root().stitch({
                baseUrl: server.url,
                path: '/pool',
                method: 'POST',
                throttle,
            });
            const viaGraphql = graphqlEntry().graphql({
                baseUrl: server.url,
                path: '/pool',
                document: '{ ok }',
                throttle,
            });

            const [a, b] = await Promise.all([
                paced(viaRoot),
                paced(viaGraphql),
            ]);

            expect(a + b).toBe(1);
        });

        test('seams built by different entries do not share a bucket id', async () => {
            // Each seam names its throttle bucket `seam:s<n>` in the (shared) store. A counter per
            // entry hands two seams the same `<n>`, so they would split ONE budget between them; one
            // process-wide counter keeps them apart and neither call waits.
            const store = root().memoryStore();
            const throttle = { rate: '20/s' } as const;
            const viaRoot = root()
                .seam({ store, throttle })
                .stitch({ baseUrl: server.url, path: '/pool', method: 'POST' });
            const viaGraphql = graphqlEntry()
                .graphql.bind({ store, throttle })
                .stitch({
                    baseUrl: server.url,
                    path: '/pool',
                    document: '{ ok }',
                });

            const [a, b] = await Promise.all([
                paced(viaRoot),
                paced(viaGraphql),
            ]);

            expect(a + b).toBe(0);
        });
    });
});

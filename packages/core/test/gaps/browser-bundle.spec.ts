// Pins docs/GAP-AUDIT.md §1.5: the core entry and every browser-legit subpath must bundle for
// the browser — no node:* imports, no `Buffer`, no unguarded process.env on the call path — and
// the bundle must actually RUN where only fetch exists. Server-tier subpaths (serve/mcp/registry)
// must stay server-only: they must NOT bundle for the browser.
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

const ROOT = join(import.meta.dirname, '../..');

// ---------------------------------------------------------------------------
// esbuild resolution
// ---------------------------------------------------------------------------
// esbuild is not a direct dependency of this package — it is a transitive
// dependency of tsup. Under pnpm a bare `import 'esbuild'` does not resolve
// from here, so we hop through tsup's package.json to reach its copy.

interface EsbuildMessage {
    text: string;
}
interface EsbuildBuildResult {
    errors: EsbuildMessage[];
    outputFiles?: { text: string }[];
}
type EsbuildBuild = (
    options: Record<string, unknown>,
) => Promise<EsbuildBuildResult>;

function loadEsbuild(): { build: EsbuildBuild } {
    const requireFromHere = createRequire(import.meta.url);
    try {
        return requireFromHere('esbuild') as { build: EsbuildBuild };
    } catch {
        const tsupPkg = requireFromHere.resolve('tsup/package.json');
        const requireFromTsup = createRequire(tsupPkg);
        return requireFromTsup('esbuild') as { build: EsbuildBuild };
    }
}

// Bundle one entry for platform "browser". Never throws — esbuild's rejection is
// folded into `errorTexts` so a test can assert on success OR on failure.
async function bundleForBrowser(
    entry: string,
    format: 'esm' | 'cjs' = 'esm',
    // Inline entry source, for the cases that must pull from MORE than one entry in a single
    // runnable bundle (the root barrel plus `src/auth.ts`, now that auth is subpath-only).
    // Relative specifiers inside it resolve from the package root.
    inline?: string,
): Promise<{ errorTexts: string[]; output: string }> {
    const { build } = loadEsbuild();
    return build({
        ...(inline
            ? { stdin: { contents: inline, resolveDir: ROOT, loader: 'ts' } }
            : { entryPoints: [join(ROOT, entry)] }),
        bundle: true,
        platform: 'browser',
        format,
        write: false,
        logLevel: 'silent',
    }).then(
        (result) => ({
            errorTexts: result.errors.map((e) => e.text),
            output: result.outputFiles?.[0]?.text ?? '',
        }),
        (error: unknown) => {
            const failed = error as { errors?: EsbuildMessage[] };
            return {
                errorTexts: (failed.errors ?? [{ text: String(error) }]).map(
                    (e) => e.text,
                ),
                output: '',
            };
        },
    );
}

// ---------------------------------------------------------------------------
// browser bundle contract
// ---------------------------------------------------------------------------

const NODE_SPECIFIER = /from\s*["']node:|require\(["']node:/;
const BUFFER = /\bBuffer\b/;

// The published surface that MUST run in the browser: the root barrel plus every
// browser-usable subpath export (ADR 0005 Decision 10). `xhr` is browser-native.
const BROWSER_LEGIT = [
    'src/index.ts',
    'src/graphql.ts',
    'src/sse.ts',
    'src/stream.ts',
    'src/download.ts',
    'src/postmessage.ts',
    'src/llm.ts',
    'src/pipe.ts',
    'src/cache.ts',
    'src/fingerprint.ts',
    'src/xhr-adapter.ts',
    'src/testing.ts',
    // Split out of the root barrel, so each now needs its own pin: `basic()` base64-encodes
    // without Buffer (the §1.5 regression site) and `secretsFile()` reaches node:fs only through
    // the guarded `nodeFs()`, which resolves absent in a browser build.
    'src/auth.ts',
    'src/bindings.ts',
];

// Server-tier subpaths: genuinely Node-coupled (node:http / stdio / node:fs) and
// deliberately NOT browser-safe. They must stay that way — and must never leak into
// the root graph (which would flip the BROWSER_LEGIT pins above).
const SERVER_TIER = ['src/serve.ts', 'src/mcp.ts', 'src/registry.ts'];

describe('browser bundle (GAP-AUDIT §1.5)', () => {
    test.each(BROWSER_LEGIT)(
        '%s bundles for "browser" with no node:* specifiers and no Buffer',
        async (entry) => {
            const { errorTexts, output } = await bundleForBrowser(entry);

            // Pin 1: the browser-platform bundle must succeed (no unshimmed node:* import).
            expect(errorTexts).toEqual([]);
            // Pin 2: no node: module specifier in the emitted bundle. The narrow regex
            // ignores the getBuiltinModule("node:fs") string literal, which is browser-safe.
            expect(output).not.toMatch(NODE_SPECIFIER);
            // Pin 3: no `Buffer` — a Node global, undefined in browsers/Workers/edge.
            expect(output).not.toMatch(BUFFER);
            expect(output.length).toBeGreaterThan(0);
        },
        15_000,
    );

    test.each(SERVER_TIER)(
        '%s stays server-tier: does NOT bundle for "browser"',
        async (entry) => {
            const { errorTexts } = await bundleForBrowser(entry);

            // These reach node:http / stdio / node:fs; a browser build must fail to
            // resolve them. If this flips, a server-only surface became browser-reachable
            // (or a node import leaked into a module the root graph also pulls).
            expect(errorTexts.length).toBeGreaterThan(0);
            expect(errorTexts.join('\n')).toMatch(/node:/);
        },
        15_000,
    );

    // The mechanical "assert no shims" guard: bundle the root for the browser and run it in
    // a vm context that has ONLY real browser primitives — no process, no Buffer, no require —
    // then execute a stitch with basic() auth (the §1.5 regression site, which used Buffer).
    test('the browser bundle executes a stitch with zero Node globals', async () => {
        // `basic` is subpath-only now, so the runnable bundle pulls the root barrel AND
        // `src/auth.ts` — the same two imports a browser consumer would write.
        const { output } = await bundleForBrowser(
            'src/index.ts',
            'cjs',
            "export { stitch } from './src/index';\nexport { basic } from './src/auth';",
        );
        expect(output.length).toBeGreaterThan(0);

        let captured:
            | { url: string; headers: Record<string, string> }
            | undefined;
        const moduleObj: { exports: Record<string, unknown> } = { exports: {} };
        const sandbox: Record<string, unknown> = {
            module: moduleObj,
            exports: moduleObj.exports,
            // Real browser / Web Worker globals only — no Node shims:
            crypto: webcrypto,
            TextEncoder,
            TextDecoder,
            URL,
            URLSearchParams,
            btoa,
            atob,
            Response,
            Headers,
            Request,
            Blob,
            AbortController,
            ReadableStream,
            setTimeout,
            clearTimeout,
            queueMicrotask,
            console,
            fetch: async (
                url: string,
                init?: { headers?: Record<string, string> },
            ) => {
                captured = { url, headers: init?.headers ?? {} };
                return new Response(JSON.stringify({ ok: true }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            },
        };

        // "assert no shims": none of the Node-only globals were injected into the scope.
        for (const banned of [
            'process',
            'Buffer',
            'require',
            'global',
            '__dirname',
            '__filename',
        ]) {
            expect(banned in sandbox).toBe(false);
        }

        createContext(sandbox);
        runInContext(output, sandbox);
        const { stitch, basic } = moduleObj.exports as {
            stitch: (cfg: unknown) => () => Promise<unknown>;
            basic: (o: { user: string; pass: string }) => unknown;
        };

        const call = stitch({
            url: 'https://api.test/x',
            method: 'GET',
            auth: basic({ user: 'u', pass: 'p' }),
        });
        const out = await call();

        // It ran Node-free: returned the parsed body and set a correct Basic header.
        expect(out).toEqual({ ok: true });
        expect(captured?.headers['authorization']).toBe(`Basic ${btoa('u:p')}`);
    }, 15_000);
});

// ---------------------------------------------------------------------------
// ADR 0005 Stage 5 — streaming surfaces hold the browser-first + bundle-frugal gates
// ---------------------------------------------------------------------------

describe('streaming surfaces are browser-first (ADR 0005 Decisions 4-5)', () => {
    // Each surface subpath must bundle for the browser on fetch + Web Streams alone — no node:*
    // dep transitively, and never `EventSource` (Decision 4 rejects it: GET-only, no headers,
    // Node-absent).
    // postmessage carries a streaming surface (its `events` verb), so it joins this matrix: it must
    // bundle on Web Streams + postMessage alone — no node:*, and never EventSource (ADR 0009).
    test.each(['src/sse.ts', 'src/stream.ts', 'src/postmessage.ts'])(
        '%s bundles for "browser" with no node:* specifiers and no EventSource',
        async (entry) => {
            const { errorTexts, output } = await bundleForBrowser(entry);

            expect(errorTexts).toEqual([]);
            expect(output).not.toMatch(NODE_SPECIFIER);
            expect(output).not.toMatch(/\bEventSource\b/);
            expect(output.length).toBeGreaterThan(0);
        },
        15_000,
    );
});

describe('streaming surfaces are bundle-frugal (ADR 0005 Decision 10)', () => {
    // `import { stitch }` must pull in NO streaming code: the root entry and the engine reach a
    // streaming surface only through `cfg.kind.stream` at runtime, never a static import of the
    // surface modules or the shared line reader. (The parser/decoders live behind the subpaths.)
    test.each(['src/index.ts', 'src/engine.ts'])(
        '%s does not statically import a streaming surface module',
        (rel) => {
            const src = readFileSync(join(ROOT, rel), 'utf8');
            expect(src).not.toMatch(/['"]\.\/(sse|stream|line-reader)['"]/);
        },
    );
});

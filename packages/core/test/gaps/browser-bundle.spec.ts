// Pins docs/GAP-AUDIT.md §1.5: The core entry must bundle for the browser — no node:* imports or unguarded process.env on the call path
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

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

// ---------------------------------------------------------------------------
// browser bundle contract
// ---------------------------------------------------------------------------

const NODE_SPECIFIER = /from\s*["']node:|require\(["']node:/;

describe('browser bundle (GAP-AUDIT §1.5)', () => {
    test('src/index.ts bundles for platform "browser" without node:* specifiers', async () => {
        const { build } = loadEsbuild();

        // Collect bundle errors instead of letting esbuild's rejection
        // crash the test — the assertion below is the pin.
        const outcome = await build({
            entryPoints: [join(ROOT, 'src/index.ts')],
            bundle: true,
            platform: 'browser',
            format: 'esm',
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
                    errorTexts: (
                        failed.errors ?? [{ text: String(error) }]
                    ).map((e) => e.text),
                    output: '',
                };
            },
        );

        // Pin 1: the browser-platform bundle must succeed. Today this
        // reports "Could not resolve node:crypto / node:fs / ..." errors.
        expect(outcome.errorTexts).toEqual([]);

        // Pin 2: the emitted bundle must not reference any node: module.
        expect(outcome.output).not.toMatch(NODE_SPECIFIER);
        expect(outcome.output.length).toBeGreaterThan(0);
    }, 15_000);
});

// ---------------------------------------------------------------------------
// ADR 0005 Stage 5 — streaming surfaces hold the browser-first + bundle-frugal gates
// ---------------------------------------------------------------------------

describe('streaming surfaces are browser-first (ADR 0005 Decisions 4-5)', () => {
    // Each surface subpath must bundle for the browser on fetch + Web Streams alone — no node:*
    // dep transitively, and never `EventSource` (Decision 4 rejects it: GET-only, no headers,
    // Node-absent).
    test.each(['src/sse.ts', 'src/stream.ts'])(
        '%s bundles for "browser" with no node:* specifiers and no EventSource',
        async (entry) => {
            const { build } = loadEsbuild();
            const outcome = await build({
                entryPoints: [join(ROOT, entry)],
                bundle: true,
                platform: 'browser',
                format: 'esm',
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
                        errorTexts: (
                            failed.errors ?? [{ text: String(error) }]
                        ).map((e) => e.text),
                        output: '',
                    };
                },
            );

            expect(outcome.errorTexts).toEqual([]);
            expect(outcome.output).not.toMatch(NODE_SPECIFIER);
            expect(outcome.output).not.toMatch(/\bEventSource\b/);
            expect(outcome.output.length).toBeGreaterThan(0);
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

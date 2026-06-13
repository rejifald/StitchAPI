// Self-tests for the stitchapi/testing conformance kit (the "contract, not
// dependency" gate — docs/GAP-AUDIT.md §2.9): the in-repo defaults must pass
// their own contracts, deliberately broken implementations must yield NAMED
// violations in a report (not throws), and the entry itself must stay
// browser-bundleable.
import { fetchAdapter, memoryStore } from '../src';
import {
    adapterContractFixture,
    assertConformance,
    verifyAdapterContract,
    verifySinkContract,
    verifyStoreContract,
} from '../src/testing';
import type { ContractReport, FixtureRequest } from '../src/testing';
import type {
    Adapter,
    StitchEvent,
    StitchStore,
    TraceSink,
} from '../src/types';

import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-conformance-${process.pid}.jsonl`,
);

const ROOT = join(import.meta.dirname, '..');

// ---------------------------------------------------------------------------
// fixture host: mount the PURE adapterContractFixture on raw node:http
// ---------------------------------------------------------------------------

interface FixtureHost {
    url: string;
    close(): Promise<void>;
}

const collectHeaders = (req: IncomingMessage): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
        out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : (v ?? '');
    }
    return out;
};

function mountFixture(): Promise<FixtureHost> {
    const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            const fixtureReq: FixtureRequest = {
                method: req.method ?? 'GET',
                path: req.url ?? '/',
                headers: collectHeaders(req),
                ...(raw === '' ? {} : { body: raw }),
            };
            const out = adapterContractFixture(fixtureReq);
            const respond = (): void => {
                res.writeHead(out.status, out.headers);
                res.end(out.body);
            };
            if (out.delayMs) setTimeout(respond, out.delayMs);
            else respond();
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            resolve({
                url: `http://127.0.0.1:${port}`,
                close: () =>
                    new Promise<void>((done) =>
                        server.close(() => {
                            done();
                        }),
                    ),
            });
        });
    });
}

// ---------------------------------------------------------------------------
// store contract
// ---------------------------------------------------------------------------

// Deliberately broken store: set() ignores ttlMs (entries never expire) and
// incr() awaits between read and write (concurrent calls collide).
function brokenStore(): StitchStore {
    const data = new Map<string, unknown>();
    return {
        async get(key) {
            return data.get(key);
        },
        async set(key, value) {
            data.set(key, value);
        },
        async incr(key) {
            const base = (data.get(key) as number | undefined) ?? 0;
            await new Promise((resolve) => setTimeout(resolve, 1));
            data.set(key, base + 1);
            return base + 1;
        },
    };
}

describe('verifyStoreContract', () => {
    test('memoryStore passes the store contract', async () => {
        const report = await verifyStoreContract(memoryStore);
        expect(report.seam).toBe('store');
        expect(report.violations).toEqual([]);
        expect(report.ok).toBe(true);
        expect(report.passed).toContain(
            'incr: 20 concurrent calls net exactly +20',
        );
        expect(() => {
            assertConformance(report);
        }).not.toThrow();
    });

    test('a broken store yields the expected NAMED violations without throwing', async () => {
        const report = await verifyStoreContract(brokenStore);
        expect(report.ok).toBe(false);
        const failed = report.violations.map((v) => v.rule);
        expect(failed).toContain('set: a ttlMs entry expires');
        expect(failed).toContain('incr: the counter expires after ttlMs');
        expect(failed).toContain('incr: 20 concurrent calls net exactly +20');
        // Independent rules: violations do not mask the healthy behaviors.
        expect(report.passed).toContain('set/get: round-trips a value');
        expect(report.passed).toContain(
            'get: a missing key resolves to undefined',
        );
        expect(report.passed).toContain('incr: increments an existing counter');
    });
});

// ---------------------------------------------------------------------------
// adapter contract
// ---------------------------------------------------------------------------

describe('verifyAdapterContract', () => {
    let host: FixtureHost;
    beforeAll(async () => {
        host = await mountFixture();
    });
    afterAll(async () => {
        await host.close();
    });

    test('fetchAdapter passes the adapter contract against adapterContractFixture', async () => {
        const report = await verifyAdapterContract(fetchAdapter(), {
            baseUrl: host.url,
        });
        expect(report.seam).toBe('adapter');
        expect(report.violations).toEqual([]);
        expect(report.ok).toBe(true);
        expect(report.passed).toContain(
            'abort: an in-flight abort rejects promptly',
        );
        expect(() => {
            assertConformance(report);
        }).not.toThrow();
    });

    test('an adapter that throws on non-2xx yields the named status violations', async () => {
        const throwing: Adapter = async (req) => {
            const res = await fetchAdapter()(req);
            if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
            return res;
        };
        const report = await verifyAdapterContract(throwing, {
            baseUrl: host.url,
        });
        expect(report.ok).toBe(false);
        const failed = report.violations.map((v) => v.rule);
        expect(failed).toContain('status: 404 resolves without throwing');
        expect(failed).toContain('status: 500 resolves without throwing');
        // The other rules still pass — one violation never masks another.
        expect(report.passed).toContain(
            'response: JSON body round-trips as parsed data',
        );
    });
});

// ---------------------------------------------------------------------------
// sink contract
// ---------------------------------------------------------------------------

describe('verifySinkContract', () => {
    test('a recording TraceSink passes and receives all 7 event variants', async () => {
        const events: StitchEvent[] = [];
        let flushed = false;
        const makeSink = (): TraceSink => ({
            handle(event) {
                events.push(event);
            },
            flush() {
                flushed = true;
            },
        });
        const report = await verifySinkContract(makeSink);
        expect(report.seam).toBe('sink');
        expect(report.violations).toEqual([]);
        expect(report.ok).toBe(true);
        expect(flushed).toBe(true);
        expect(events.map((e) => e.type)).toEqual([
            'start',
            'progress',
            'drift',
            'delta',
            'result',
            'error',
            'done',
        ]);
    });

    test("a sink that rejects 'delta' yields that named violation only", async () => {
        const makeSink = (): TraceSink => ({
            handle(event) {
                if (event.type === 'delta') {
                    throw new Error('unknown event type: delta');
                }
            },
        });
        const report = await verifySinkContract(makeSink);
        expect(report.ok).toBe(false);
        expect(report.violations).toEqual([
            {
                rule: "handle: accepts a 'delta' event",
                detail: 'unknown event type: delta',
            },
        ]);
        expect(report.passed).toContain("handle: accepts a 'done' event");
    });
});

// ---------------------------------------------------------------------------
// assertConformance
// ---------------------------------------------------------------------------

describe('assertConformance', () => {
    test('throws one readable Error listing EVERY violation', () => {
        const failing: ContractReport = {
            seam: 'adapter',
            ok: false,
            passed: ['something healthy'],
            violations: [
                { rule: 'rule-one', detail: 'first detail' },
                { rule: 'rule-two', detail: 'second detail' },
            ],
        };
        let message = '';
        try {
            assertConformance(failing);
        } catch (error) {
            message = (error as Error).message;
        }
        expect(message).toContain('adapter');
        expect(message).toContain('rule-one');
        expect(message).toContain('first detail');
        expect(message).toContain('rule-two');
        expect(message).toContain('second detail');
    });
});

// ---------------------------------------------------------------------------
// browser bundle: the kit itself must pass gate 1 (dogfooding)
// ---------------------------------------------------------------------------

// esbuild is a transitive dependency of tsup; under pnpm a bare import does
// not resolve from here, so hop through tsup's package.json to reach its copy
// (same technique as test/gaps/browser-bundle.spec.ts).

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

const NODE_SPECIFIER = /from\s*["']node:|require\(["']node:/;

describe('browser bundle', () => {
    test('src/testing.ts bundles for platform "browser" without node:* specifiers', async () => {
        const { build } = loadEsbuild();

        const outcome = await build({
            entryPoints: [join(ROOT, 'src/testing.ts')],
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
        expect(outcome.output.length).toBeGreaterThan(0);
    }, 15_000);
});

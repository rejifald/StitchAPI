// `stitch mcp` end-to-end over a real subprocess (DESIGN.md §10 — the agent-native surface).
//
// mcp.spec.ts covers two layers: createMcpServer().handle() (transport-agnostic) and
// serveStdio({...}, { input, output }) over in-memory PassThrough streams. What neither
// touches is the *actual* `bin/stitch mcp` process — the bin shim → lib/cli.js → real
// process stdio — driven through a full agent conversation that includes a run_stitch
// round-trip against an *executing* stitch. This spec is that missing seam: it spawns the
// real CLI as a child, speaks newline-delimited JSON-RPC 2.0 over its stdin/stdout, and
// asserts the validated result comes back from a stitch the child actually ran against a
// hermetic local server.
//
// Build-dependent: the bin requires ../lib/cli.js and the temp stitch module imports the
// built ESM entry (lib/index.mjs), so it only runs once core is built. Like the `sandbox`
// and `e2e` jobs in verify.yml, it has its own CI job (`mcp-e2e`) that builds core first;
// the src-only `pnpm test` gate finds no lib/ and skips this suite cleanly (the guard below).
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CORE = join(import.meta.dirname, '..');
const LIB = join(CORE, 'lib');
const BIN = join(CORE, 'bin', 'stitch');
const ENTRY_URL = pathToFileURL(join(LIB, 'index.mjs')).href;

// Gate on the build: the child needs lib/cli.js and the temp module imports lib/index.mjs.
// Absent (the src-only `pnpm test` gate), the whole suite skips rather than red-failing.
const BUILT =
    existsSync(join(LIB, 'cli.js')) && existsSync(join(LIB, 'index.mjs'));

const READY_MARKER = 'run_stitch tool ready';
const READY_TIMEOUT_MS = 15_000;
const RPC_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

// ---- shapes we read out of the JSON-RPC replies --------------------------

interface RpcResponse {
    jsonrpc: '2.0';
    id: number | string | null;
    result?: unknown;
    error?: { code: number; message: string };
}
interface ToolListResult {
    tools: { name: string; description: string; inputSchema: unknown }[];
}
interface ToolCallResult {
    content: { type: string; text: string }[];
    isError?: boolean;
}
interface StitchListing {
    name: string;
    method: string;
    path: string;
}

interface FakeApi {
    url: string;
    hits: () => number;
    close: () => Promise<void>;
}

// ---- the hermetic fake API (node:http, no external network) ---------------

// GET /users/{id} → { data: { id, name } } (so a stitch's unwrap:'data' has something to peel);
// GET /health → { ok: true }. Every response is `Connection: close` so no keep-alive socket
// lingers in the child and wedges its exit — that is what makes the "no hang" assertion sound.
function startFakeApi(): Promise<FakeApi> {
    let hits = 0;
    const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        res.setHeader('Connection', 'close');
        const userMatch = /^\/users\/(\d+)$/.exec(url.pathname);
        if (req.method === 'GET' && userMatch) {
            hits++;
            const id = Number(userMatch[1]);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ data: { id, name: `user-${id}` } }));
            return;
        }
        if (req.method === 'GET' && url.pathname === '/health') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
    });

    return new Promise<FakeApi>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            resolve({
                url: `http://127.0.0.1:${port}`,
                hits: () => hits,
                close: () =>
                    new Promise<void>((done) => {
                        server.closeAllConnections();
                        server.close(() => {
                            done();
                        });
                    }),
            });
        });
    });
}

// The temp stitch module the CLI loads via import(pathToFileURL(path)). Plain ESM (.mjs, no
// TS/bundler in the child): it imports the *built* entry by absolute file URL — the real
// "agent imports stitchapi and points it at an API" path — and declares its output validator
// as a hand-rolled Standard Schema so the module stays zero-dependency (no zod to resolve from
// a tmp dir). stitch() coerces it through toValidator() exactly like a real schema.
function moduleSource(entryUrl: string, baseUrl: string): string {
    return `import { stitch } from ${JSON.stringify(entryUrl)};

const userSchema = {
    '~standard': {
        version: 1,
        vendor: 'stitchapi-e2e',
        validate(value) {
            if (
                value &&
                typeof value === 'object' &&
                typeof value.id === 'number' &&
                typeof value.name === 'string'
            ) {
                return { value };
            }
            return { issues: [{ message: 'not a user' }] };
        },
    },
};

export const getUser = stitch({
    baseUrl: ${JSON.stringify(baseUrl)},
    path: '/users/{id}',
    unwrap: 'data',
    output: userSchema,
});

export const health = stitch({
    baseUrl: ${JSON.stringify(baseUrl)},
    path: '/health',
});
`;
}

// ---- small async utilities ------------------------------------------------

// Reject (instead of hanging until the test timeout) if a promise overruns. The timer is
// unref'd so it never keeps the test process alive on the happy path.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            reject(new Error(`timed out after ${ms}ms waiting for ${label}`));
        }, ms);
        timer.unref();
    });
    return Promise.race([p, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

// Resolve once the child's startup notice (on stderr — stdout stays pure JSON-RPC) shows the
// MCP server is ready, so we never write a request before the stdin reader is attached. Rejects
// if the child dies first (e.g. a module-load error) with its stderr for diagnosis.
function waitForReady(
    proc: ChildProcess,
    marker: string,
    ms: number,
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const stderr = proc.stderr;
        if (!stderr) {
            reject(new Error('child has no stderr stream'));
            return;
        }
        stderr.setEncoding('utf8');
        let buf = '';
        let settled = false;
        const settle = (fn: () => void): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn();
        };
        const timer = setTimeout(() => {
            settle(() => {
                reject(
                    new Error(
                        `timed out waiting for MCP ready.\nstderr:\n${buf}`,
                    ),
                );
            });
        }, ms);
        timer.unref();
        stderr.on('data', (chunk: string) => {
            buf += chunk;
            if (buf.includes(marker)) settle(resolve);
        });
        proc.once('exit', (code) => {
            settle(() => {
                reject(
                    new Error(
                        `MCP child exited early (code ${String(code)}) before ready.\nstderr:\n${buf}`,
                    ),
                );
            });
        });
    });
}

// describe.skipIf so the src-only `pnpm test` run (no build) reports this suite as skipped,
// while the build-dependent `mcp-e2e` CI job runs it for real.
describe.skipIf(!BUILT)(
    'stitch mcp subprocess (stdio JSON-RPC, real run_stitch)',
    () => {
        let api: FakeApi | undefined;
        let child: ChildProcess | undefined;
        let tmpDir: string | undefined;

        // Newline-delimited reader over the child's stdout: hand back the next complete JSON line,
        // queueing if it arrives before a reader asks. A child exit fails any pending read.
        let stdoutBuf = '';
        const lineQueue: string[] = [];
        const lineWaiters: {
            resolve: (line: string) => void;
            reject: (err: Error) => void;
        }[] = [];

        function attachReader(proc: ChildProcess): void {
            const stdout = proc.stdout;
            if (!stdout) throw new Error('child has no stdout stream');
            stdout.setEncoding('utf8');
            stdout.on('data', (chunk: string) => {
                stdoutBuf += chunk;
                let nl = stdoutBuf.indexOf('\n');
                while (nl >= 0) {
                    const line = stdoutBuf.slice(0, nl).trim();
                    stdoutBuf = stdoutBuf.slice(nl + 1);
                    if (line) {
                        const waiter = lineWaiters.shift();
                        if (waiter) waiter.resolve(line);
                        else lineQueue.push(line);
                    }
                    nl = stdoutBuf.indexOf('\n');
                }
            });
            proc.once('exit', (code) => {
                const err = new Error(
                    `child exited (code ${String(code)}) with a read still pending`,
                );
                let waiter = lineWaiters.shift();
                while (waiter) {
                    waiter.reject(err);
                    waiter = lineWaiters.shift();
                }
            });
        }

        function nextLine(): Promise<string> {
            const queued = lineQueue.shift();
            if (queued !== undefined) return Promise.resolve(queued);
            return new Promise<string>((resolve, reject) => {
                lineWaiters.push({ resolve, reject });
            });
        }

        let nextId = 1;
        async function rpc(
            method: string,
            params?: unknown,
        ): Promise<RpcResponse> {
            const id = nextId++;
            const message = JSON.stringify({
                jsonrpc: '2.0',
                id,
                method,
                params,
            });
            child?.stdin?.write(`${message}\n`);
            const line = await withTimeout(
                nextLine(),
                RPC_TIMEOUT_MS,
                `${method} response`,
            );
            const res = JSON.parse(line) as RpcResponse;
            // Correlation holds over the real transport, not just in-memory.
            expect(res.id).toBe(id);
            return res;
        }

        beforeAll(async () => {
            api = await startFakeApi();
            tmpDir = await mkdtemp(join(tmpdir(), 'stitch-mcp-e2e-'));
            const modulePath = join(tmpDir, 'stitches.mjs');
            await writeFile(
                modulePath,
                moduleSource(ENTRY_URL, api.url),
                'utf8',
            );

            // Hermetic + deterministic: strip any inherited trace env so the child writes no JSONL.
            const env = { ...process.env };
            delete env['STITCH_TRACE_FILE'];
            delete env['STITCH_TRACE_CONSOLE'];

            child = spawn(
                process.execPath,
                [BIN, 'mcp', '--module', modulePath],
                {
                    stdio: ['pipe', 'pipe', 'pipe'],
                    env,
                },
            );
            attachReader(child);
            await waitForReady(child, READY_MARKER, READY_TIMEOUT_MS);
        }, 30_000);

        afterAll(async () => {
            if (child?.exitCode === null && child.signalCode === null) {
                child.kill('SIGKILL');
            }
            await api?.close();
            if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
        });

        test('drives an agent conversation over stdio: initialize → tools/list → list_stitches → run_stitch', async () => {
            // initialize: the server echoes the client's protocol version and advertises tools.
            const init = await rpc('initialize', { protocolVersion: 'x' });
            const initResult = init.result as {
                protocolVersion: string;
                capabilities: { tools?: unknown };
                serverInfo: { name: string };
            };
            expect(initResult.protocolVersion).toBe('x');
            expect(initResult.capabilities.tools).toBeDefined();
            expect(initResult.serverInfo.name).toBe('stitchapi');

            // tools/list: the two code-mode tools, not one-per-endpoint.
            const list = await rpc('tools/list');
            const toolNames = (list.result as ToolListResult).tools.map(
                (t) => t.name,
            );
            expect(toolNames).toContain('run_stitch');
            expect(toolNames).toContain('list_stitches');

            // list_stitches: the agent discovers what the loaded module exposes.
            const ls = await rpc('tools/call', { name: 'list_stitches' });
            const listing = JSON.parse(
                (ls.result as ToolCallResult).content[0]!.text,
            ) as StitchListing[];
            expect(listing.map((s) => s.name)).toEqual(['getUser', 'health']);
            expect(listing[0]).toMatchObject({
                method: 'GET',
                path: '/users/{id}',
            });

            // run_stitch: the headline — the child actually executes the stitch against the live
            // local server, unwraps `data`, validates the body, and returns it as content[0].text.
            const run = await rpc('tools/call', {
                name: 'run_stitch',
                arguments: { name: 'getUser', input: { params: { id: 42 } } },
            });
            const runResult = run.result as ToolCallResult;
            expect(runResult.isError).toBeFalsy();
            expect(JSON.parse(runResult.content[0]!.text)).toEqual({
                id: 42,
                name: 'user-42',
            });
            // Proof the round-trip actually hit the network seam (not a stub): exactly one call.
            expect(api?.hits()).toBe(1);
        }, 20_000);

        test('shuts down cleanly when its stdin closes (no hang)', async () => {
            const exited = new Promise<number | null>((resolve) => {
                child?.once('exit', (code) => {
                    resolve(code);
                });
            });
            child?.stdin?.end();
            const code = await withTimeout(
                exited,
                SHUTDOWN_TIMEOUT_MS,
                'child exit',
            );
            expect(code).toBe(0);
        }, 15_000);
    },
);

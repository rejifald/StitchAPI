// Smoke test for the sandbox MCP server (stdio). Spawns the BUILT server
// (dist/mcp.mjs — run `build:mcp` first), drives it over JSON-RPC, and asserts
// the three tools work end-to-end against the simulator plus the version it
// reports. Exits non-zero on failure so it is CI-usable:
// `pnpm --filter @stitchapi/sandbox run test:mcp`.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const server = resolve(here, '../dist/mcp.mjs');
if (!existsSync(server)) {
    console.error(`missing ${server} — run \`build:mcp\` first.`);
    process.exit(2);
}

// The canonical version, read straight from packages/core/package.json on disk — the
// same trick as packages/core/test/mcp.spec.ts, and for the same reason: reading the
// manifest rather than the build-time `__PKG_VERSION__` define asserts the reported
// version actually TRACKS the release, instead of testing the define against itself.
// It is core's version because `createSandboxMcp` overrides only `name`, so the
// version reaching the wire is core's `SERVER_VERSION` — the define that
// build-sandbox-mcp.mjs substitutes. Un-substituted, this whole bundle fails to
// import; substituted with the WRONG value, only this check catches it.
const CORE_VERSION = JSON.parse(
    readFileSync(resolve(here, '../../../packages/core/package.json'), 'utf8'),
).version;

const child = spawn('node', [server], { stdio: ['pipe', 'pipe', 'pipe'] });
let out = '';
let err = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (err += d));

const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
            name: 'run_in_sandbox',
            arguments: {
                code: "const u = stitch('https://api.example.com/users/2'); console.log(await u());",
            },
        },
    },
    {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
            name: 'run_stitch',
            arguments: { name: 'getUser', input: { params: { id: 2 } } },
        },
    },
    {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
            name: 'run_in_sandbox',
            arguments: { code: "throw new Error('boom')" },
        },
    },
    {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
            name: 'run_in_sandbox',
            arguments: { code: 'while (true) {}', timeoutMs: 500 },
        },
    },
];
for (const m of messages) child.stdin.write(JSON.stringify(m) + '\n');

const replies = () => out.split('\n').filter(Boolean).map(JSON.parse);
const deadline = Date.now() + 10_000;
const iv = setInterval(() => {
    let got;
    try {
        got = replies();
    } catch {
        return; // partial line; wait
    }
    if (got.length < 6 && Date.now() < deadline) return;
    clearInterval(iv);
    try {
        child.stdin.end();
    } catch {}
    child.kill();
    finish(got);
}, 100);

function finish(got) {
    const byId = Object.fromEntries(got.map((p) => [p.id, p]));
    const text = (id) => byId[id]?.result?.content?.[0]?.text ?? '';
    const fail = [];
    const check = (cond, msg) => {
        if (!cond) fail.push(msg);
    };

    check(got.length === 6, `expected 6 replies, got ${got.length}`);
    check(
        byId[1]?.result?.serverInfo?.name === 'stitchapi-sandbox',
        'initialize serverInfo.name',
    );
    const reportedVersion = byId[1]?.result?.serverInfo?.version;
    check(
        reportedVersion === CORE_VERSION,
        `initialize serverInfo.version: reported ${JSON.stringify(reportedVersion)}, ` +
            `packages/core/package.json says ${JSON.stringify(CORE_VERSION)} — the ` +
            `build's __PKG_VERSION__ define has drifted from the manifest`,
    );
    const tools = (byId[2]?.result?.tools ?? []).map((t) => t.name);
    for (const t of ['run_in_sandbox', 'run_stitch', 'list_stitches'])
        check(tools.includes(t), `tools/list missing ${t}`);
    check(
        text(3).includes('Bob Hoskins'),
        'run_in_sandbox snippet did not return sim data (Bob Hoskins)',
    );
    check(
        text(4).includes('Bob Hoskins'),
        'run_stitch (sim mode) did not return sim data (Bob Hoskins)',
    );
    check(
        byId[5]?.result?.isError === true && text(5).includes('"throw"'),
        'thrown snippet not reported as a contained error',
    );
    check(
        byId[6]?.result?.isError === true && text(6).includes('"timeout"'),
        'infinite loop not killed at timeoutMs',
    );

    if (fail.length) {
        console.error('FAIL:\n - ' + fail.join('\n - '));
        console.error('\n--- server stderr ---\n' + err.trim());
        process.exit(1);
    }
    console.log(
        'PASS — sandbox MCP: run_in_sandbox + run_stitch (sim) + list_stitches, ' +
            'error containment, and timeout kill all verified against the simulator; ' +
            `reported version ${CORE_VERSION} matches packages/core/package.json.`,
    );
    process.exit(0);
}

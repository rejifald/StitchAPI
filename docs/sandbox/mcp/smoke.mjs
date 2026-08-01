// Smoke test for the sandbox MCP server (stdio). Spawns the BUILT server
// (dist/mcp.mjs — run `build:mcp` first), drives it over JSON-RPC, and asserts
// the three tools work end-to-end against the simulator. Exits non-zero on
// failure so it is CI-usable: `pnpm --filter @stitchapi/sandbox run test:mcp`.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const server = resolve(here, '../dist/mcp.mjs');
if (!existsSync(server)) {
    console.error(`missing ${server} — run \`build:mcp\` first.`);
    process.exit(2);
}

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
            'error containment, and timeout kill all verified against the simulator.',
    );
    process.exit(0);
}

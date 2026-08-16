// Production smoke test for the hosted docs MCP server (/api/mcp).
//
// WHY THIS EXISTS, AND WHY IT IS NOT A CI TEST
//
// From 2026-07-31 to 2026-08-10 this endpoint returned an error on every
// request — ~946 "Failed to load external module @huggingface/transformers:
// Could not load the 'sharp' module using the linux-x64 runtime" across 89
// distinct clients — and nothing noticed for ten days. No test in this repo
// could have caught it: the bug was in Vercel's file tracing (the deployed
// function bundle was missing a native binary), NOT in the source. CI runs the
// search library out of a normal, complete node_modules, so it passes while the
// deployed artifact is broken. `check-search-relevance` loads the same model on
// the same OS and still would not have flagged it.
//
// The only place a tracing bug is observable is the deployment. So this probe
// talks to a real base URL over the wire and asserts the things that actually
// broke:
//
//   1. the route's module graph loads at all       (the sharp/ERR_DLOPEN class)
//   2. the tool surface is still what agents bind  (a silent rename/removal)
//   3. search_docs returns real ranked results     (index missing or empty)
//   4. get_doc returns real Markdown               (the non-embedding path,
//      which must keep working even if embeddings fail — see embed.ts on why
//      the transformers import is lazy)
//   5. every call stays well inside maxDuration    (the cold-start timeout
//      class: 25 "Task timed out after 60 seconds" errors through 2026-08-16)
//
// Assertion 5 is why the workflow runs on a schedule rather than only after a
// deploy: a scheduled probe usually lands on a COLD instance, which is the only
// condition under which the cold-start regression is visible at all.
//
// Usage:
//   node --import tsx/esm scripts/smoke-mcp.mts [baseUrl]
//   MCP_SMOKE_URL=https://staging.example.com node --import tsx/esm scripts/smoke-mcp.mts
//
// Exits non-zero with a specific message on the first failed assertion.

const DEFAULT_BASE = 'https://stitchapi.dev';

// Well under the route's `maxDuration = 60`. A cold instance that needs the
// embedding model should now serve from the bundled copy (see embed.ts's
// localModelPath), so anything approaching this budget means the vendored model
// is not being found and something is falling back to a network fetch.
const BUDGET_MS = 25_000;

// The tools agents actually bind to. A rename or removal is a breaking change
// for every configured client, so it fails here rather than silently degrading.
const EXPECTED_TOOLS = ['search_docs', 'get_doc'] as const;

const baseUrl = (
    process.argv[2] ??
    process.env.MCP_SMOKE_URL ??
    DEFAULT_BASE
).replace(/\/$/, '');
const endpoint = `${baseUrl}/api/mcp`;

let sessionId: string | undefined;
let failures = 0;

function fail(check: string, detail: string): void {
    failures += 1;
    console.error(`  ✗ ${check}\n      ${detail}`);
}

function pass(check: string, detail: string): void {
    console.log(`  ✓ ${check} — ${detail}`);
}

/**
 * One JSON-RPC round trip. The transport is MCP Streamable HTTP, so a response
 * is SSE-framed (`event: message\ndata: {…}`) even for a single reply — parse
 * the last `data:` line rather than assuming a bare JSON body.
 */
async function rpc(
    method: string,
    params: Record<string, unknown> = {},
): Promise<{ result?: any; error?: any; ms: number }> {
    const started = Date.now();
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    });
    const ms = Date.now() - started;

    // Stateless today (no redisUrl), but honour a session id if one appears so
    // this keeps working if the server gains state.
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;

    const body = await res.text();
    if (!res.ok) {
        return { error: `HTTP ${res.status}: ${body.slice(0, 300)}`, ms };
    }

    const dataLines = body
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim());
    const payload = dataLines.at(-1) ?? body;

    try {
        const parsed = JSON.parse(payload);
        return { result: parsed.result, error: parsed.error, ms };
    } catch {
        return { error: `unparseable response: ${payload.slice(0, 300)}`, ms };
    }
}

function checkBudget(label: string, ms: number): void {
    if (ms > BUDGET_MS) {
        fail(
            `${label} latency`,
            `${ms}ms exceeds the ${BUDGET_MS}ms budget — the route is heading back toward its 60s maxDuration ceiling`,
        );
    }
}

console.log(`\nMCP smoke → ${endpoint}\n`);

/* 1. initialize — proves the route's module graph loaded at all. ------------ */
{
    const { result, error, ms } = await rpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'stitchapi-mcp-smoke', version: '1.0.0' },
    });
    if (error) {
        fail('initialize', String(error));
    } else if (!result?.serverInfo?.name) {
        fail('initialize', `no serverInfo in response: ${JSON.stringify(result)?.slice(0, 200)}`);
    } else {
        pass('initialize', `${result.serverInfo.name} v${result.serverInfo.version} (${ms}ms)`);
        checkBudget('initialize', ms);
    }
}

/* 2. tools/list — the surface agents bind to. ------------------------------ */
{
    const { result, error, ms } = await rpc('tools/list');
    if (error) {
        fail('tools/list', String(error));
    } else {
        const names: string[] = (result?.tools ?? []).map((t: any) => t.name);
        const missing = EXPECTED_TOOLS.filter((t) => !names.includes(t));
        if (missing.length > 0) {
            fail(
                'tools/list',
                `missing tool(s): ${missing.join(', ')} — got [${names.join(', ')}]. Every configured client binds these names.`,
            );
        } else {
            pass('tools/list', `${names.join(', ')} (${ms}ms)`);
            checkBudget('tools/list', ms);
        }
    }
}

/* 3. search_docs — the embedding path, and the index behind it. ------------ */
{
    const { result, error, ms } = await rpc('tools/call', {
        name: 'search_docs',
        arguments: { query: 'retry with exponential backoff', limit: 3 },
    });
    if (error) {
        fail('search_docs', String(error));
    } else if (result?.isError) {
        fail('search_docs', `tool reported an error: ${JSON.stringify(result.content)?.slice(0, 300)}`);
    } else {
        let hits: any[] = [];
        try {
            hits = JSON.parse(result?.content?.[0]?.text ?? '[]');
        } catch {
            /* falls through to the empty check below */
        }
        if (hits.length === 0) {
            fail(
                'search_docs',
                'returned zero results for a query that must match the retry guide — the index is missing, empty, or not bundled into the function',
            );
        } else if (!hits[0]?.url?.startsWith('http')) {
            fail('search_docs', `result shape changed — first hit has no absolute url: ${JSON.stringify(hits[0])?.slice(0, 200)}`);
        } else {
            pass('search_docs', `${hits.length} hits, top: ${hits[0].title} (${ms}ms)`);
            checkBudget('search_docs', ms);
        }
    }
}

/* 4. get_doc — must work even when embeddings do not (lazy-import scoping). */
{
    const { result, error, ms } = await rpc('tools/call', {
        name: 'get_doc',
        arguments: { slug: 'guides/resilience/retry' },
    });
    if (error) {
        fail('get_doc', String(error));
    } else if (result?.isError) {
        fail('get_doc', `tool reported an error: ${JSON.stringify(result.content)?.slice(0, 300)}`);
    } else {
        const md: string = result?.content?.[0]?.text ?? '';
        if (md.length < 200) {
            fail('get_doc', `returned ${md.length} chars — expected a full Markdown page`);
        } else {
            pass('get_doc', `${md.length} chars of Markdown (${ms}ms)`);
            checkBudget('get_doc', ms);
        }
    }
}

console.log('');
if (failures > 0) {
    console.error(`MCP smoke FAILED — ${failures} check(s) failed against ${endpoint}\n`);
    process.exit(1);
}
console.log(`MCP smoke passed — ${endpoint} is healthy\n`);

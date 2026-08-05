// C6 — is there a confirmation seam for an irreversible call?
//
// The capture calls human confirmation "the one control that survives prompt injection", so this
// asks two separate questions:
//
//   1. Can the SERVER ask? MCP's 2025-06-18 revision — the version this server reports — has
//      `elicitation`, a server-initiated request for user input. Measured below: the server neither
//      advertises it nor could implement it, because `McpServer` is `{ handle }` (one response per
//      request) and `serveStdio` never hands user code the outbound stream. There is no channel
//      from the server to the human.
//   2. Can the CLIENT ask? Every MCP host has a "confirm before a destructive tool" policy, driven
//      by the tool's `annotations` (`readOnlyHint`, `destructiveHint`). Measured below: the tool
//      descriptors carry no annotations at all — and code-mode means one tool name covers a GET of
//      an order and a POST of a refund, so even a client that annotated perfectly could not tell
//      them apart without parsing arguments it has no schema for.
//
// Then it measures what a determined operator CAN do in user code, and where each seam sits
// relative to the request: `hooks.onRequest` (after auth, retried), a `Surface.execute` (replaces
// the transport), and the `adapter` (last). All three can refuse; none can ask.
//
//   pnpm exec tsx docs/scenarios/proofs/agent-holds-the-tool/c6-confirmation.ts
import { bearer, env } from '../../../../packages/core/src/auth';
import { seam } from '../../../../packages/core/src/index';
import type {
    AdapterRequest,
    AdapterResponse,
} from '../../../../packages/core/src/types';
import { inProcess, loadMcp } from './client';
import { check, checkSeq, finish, heading, note } from './harness';
import { buildRegistry } from './stitches';
import { BASE, ENV, Wire, installSecrets, route } from './vendor';

interface ToolDescriptor {
    name: string;
    description: string;
    inputSchema: unknown;
    annotations?: unknown;
}

async function main(): Promise<void> {
    installSecrets();
    const wire = new Wire(route);
    const registry = buildRegistry(wire);
    const client = await inProcess(registry);

    heading('C6 (a) — can the SERVER ask the human? (elicitation / sampling)');
    const init = await client.send('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: { elicitation: {}, sampling: {} },
    });
    const result = init.message.result as {
        protocolVersion: string;
        capabilities: Record<string, unknown>;
    };
    check('the server reports', result.protocolVersion, '2025-06-18');
    checkSeq('server capabilities', Object.keys(result.capabilities), [
        'tools',
    ]);
    check(
        'elicitation is advertised',
        Object.keys(result.capabilities).includes('elicitation'),
        false,
    );
    note(
        'the client offered elicitation and sampling; the server ignored both',
        'pickProtocol reads only `protocolVersion` (mcp.ts:132-136) — the client’s capabilities object is never read',
    );

    const { createMcpServer, serveStdio } = await loadMcp();
    const server = createMcpServer(registry);
    checkSeq('the McpServer interface', Object.keys(server), ['handle']);
    const stdinLess = serveStdio(registry, {
        stdin: new (await import('node:stream')).PassThrough(),
        stdout: new (await import('node:stream')).PassThrough(),
    });
    checkSeq('what serveStdio hands back', Object.keys(stdinLess).sort(), [
        'close',
        'server',
    ]);
    stdinLess.close();
    note(
        'there is no outbound channel',
        '`handle(message) => response | null` is request/response only, and `serveStdio` keeps `stdout` private — user code cannot send a server-initiated request',
    );

    heading('C6 (b) — can the CLIENT ask? What the tool descriptors say');
    const tools = (
        (await client.send('tools/list')).message.result as {
            tools: ToolDescriptor[];
        }
    ).tools;
    for (const tool of tools)
        check(`${tool.name}.annotations`, tool.annotations === undefined, true);
    note(
        'no readOnlyHint, no destructiveHint, no idempotentHint, no openWorldHint',
        'the four MCP tool annotations a host uses to decide whether to prompt',
    );
    wire.reset();
    const read = await client.callTool('run_stitch', {
        name: 'getOrder',
        input: { params: { id: '77' } },
    });
    const write = await client.callTool('run_stitch', {
        name: 'refund',
        input: { body: { amount: 25_000 } },
    });
    check(
        'a read and a refund use the SAME tool name',
        read.label,
        write.label,
    );
    checkSeq(
        'and the wire saw both',
        wire.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`),
        ['GET /v1/orders/77', 'POST /v1/refunds'],
    );
    note(
        'this is the cost of code-mode',
        'one tool for every endpoint keeps the model’s context small AND makes the host’s destructive-tool prompt undecidable — the method is inside an argument the host has no schema for',
    );
    check(
        'does `list_stitches` at least surface the method?',
        JSON.parse((await client.callTool('list_stitches')).text).length > 0 &&
            (
                JSON.parse((await client.callTool('list_stitches')).text) as {
                    name: string;
                    method: string;
                }[]
            ).some((s) => s.name === 'refund' && s.method === 'POST'),
        true,
    );
    note(
        'it does — but a host would have to CALL a tool to learn it',
        'and the annotation it needs is on the tool descriptor, which is fetched once, before any call',
    );

    heading('C6 (c) — what a REFUSAL seam can do, and where each one sits');
    // `hooks.onRequest` — engine.ts:652, after auth, inside the attempt loop.
    const hookWire = new Wire(route);
    const hookApi = seam({ baseUrl: BASE, adapter: hookWire.adapter() });
    const hookSeen: string[] = [];
    const hookClient = await inProcess({
        refund: hookApi.stitch({
            name: 'refund',
            method: 'POST',
            path: '/v1/refunds',
            auth: bearer(env(ENV.bearer)),
            retry: { attempts: 3, backoff: { base: 1 } },
            hooks: {
                onRequest: (ctx) => {
                    // `req` is optional on `HookContext` (it is shared with onResponse/onError);
                    // on the onRequest arm the engine always supplies it (engine.ts:652).
                    const req = ctx.req as AdapterRequest;
                    hookSeen.push(
                        `attempt ${String(ctx.attempt)} ${req.method} ${new URL(req.url).pathname}`,
                    );
                    throw new Error('refund requires human approval');
                },
            },
        }),
    });
    const blocked = await hookClient.callTool('run_stitch', {
        name: 'refund',
        input: { body: { amount: 25_000 } },
    });
    check('the write was refused', blocked.isError, true);
    check(
        'the model was told why',
        blocked.text,
        'refund requires human approval',
    );
    check('no request reached the vendor', hookWire.count, 0);
    // The hook lives inside the attempt loop (engine.ts:652), so a `retry: { attempts: 3 }` could
    // have asked it three times. It did not: a refusal is not a retryable failure.
    checkSeq('and it was asked exactly once, despite retry ×3', hookSeen, [
        'attempt 1 POST /v1/refunds',
    ]);
    note(
        'onRequest sees the FINAL request — url, method, and the credential header',
        'the only seam that sees all three; it sits inside the attempt loop but a throw from it does not burn a retry',
    );

    // The `adapter` — the last seam before the transport, and outside the retry loop's hook.
    const gateWire = new Wire(route);
    const approvals: string[] = [];
    const gated =
        (allow: (req: AdapterRequest) => boolean) =>
        async (req: AdapterRequest): Promise<AdapterResponse> => {
            approvals.push(`${req.method} ${new URL(req.url).pathname}`);
            if (!allow(req))
                throw new Error(
                    'blocked: a write needs approval that this server cannot ask for',
                );
            return gateWire.adapter()(req);
        };
    const gateApi = seam({
        baseUrl: BASE,
        adapter: gated((req) => req.method === 'GET'),
    });
    const gateClient = await inProcess({
        getOrder: gateApi.stitch({
            name: 'getOrder',
            path: '/v1/orders/{id}',
            auth: bearer(env(ENV.bearer)),
        }),
        refund: gateApi.stitch({
            name: 'refund',
            method: 'POST',
            path: '/v1/refunds',
            auth: bearer(env(ENV.bearer)),
        }),
    });
    const allowed = await gateClient.callTool('run_stitch', {
        name: 'getOrder',
        input: { params: { id: '77' } },
    });
    const denied = await gateClient.callTool('run_stitch', {
        name: 'refund',
        input: { body: { amount: 1 } },
    });
    check('the read passed the gate', allowed.isError, false);
    check('the write was denied', denied.isError, true);
    check(
        'the model was told why',
        denied.text,
        'blocked: a write needs approval that this server cannot ask for',
    );
    checkSeq('the gate saw both', approvals, [
        'GET /v1/orders/77',
        'POST /v1/refunds',
    ]);
    check('and only the read reached the vendor', gateWire.count, 1);

    finish(
        'C6',
        "NO CONFIRMATION SEAM, IN EITHER DIRECTION — AND CODE-MODE TAKES THE CLIENT'S ONE AWAY TOO. The server cannot ask: it reports protocol `2025-06-18`, whose `elicitation` is the standard's server-initiated request for user input, but it advertises `capabilities: { tools }` and nothing else, ignores the elicitation and sampling capabilities the client offers, and structurally could not use them — `McpServer` is `{ handle }`, a pure request/response mapping, and `serveStdio` returns `{ server, close }` while keeping `stdout` private, so no user code can originate a message. The client cannot ask either: all three tool descriptors carry NO `annotations`, so `readOnlyHint`/`destructiveHint` — the fields a host reads to decide whether to prompt — are absent; and because code-mode puts every endpoint behind ONE tool name, the read of an order and a 25,000 refund arrive at the host as the same `run_stitch` call, with the method buried in an argument the host has no schema for. `list_stitches` does report `POST /v1/refunds`, but a host would have to call a tool to learn it, and the annotation it needs is fixed at `tools/list` time. WHAT USER CODE CAN DO IS REFUSE, NOT ASK, and there are two useful seats: `hooks.onRequest` sees the final URL, method and credential header and can throw — measured, the vendor got zero requests, the model got the reason, and despite `retry: { attempts: 3 }` the gate was asked exactly once, because a refusal is not a retryable failure; an `adapter` wrapper sits one layer further out and gated a POST while letting a GET through, at one function and no per-stitch config. Both are policy, not approval: nothing in the process can reach a human",
    );
}

void main();

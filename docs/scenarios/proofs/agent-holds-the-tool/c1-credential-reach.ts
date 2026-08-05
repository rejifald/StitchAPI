// C1 — DECIDING. Does a credential reach the model ANYWHERE on the MCP surface?
//
// The product's central promise is that the caller, "an agent included", receives data and never
// the secret (`/docs/concepts/capability-not-credential`). A generic `run_stitch` tool is the
// sharpest test of that sentence there is, so this script enumerates every payload a JSON-RPC
// client can obtain and scans each one, BY VALUE, for all five credentials the registry holds:
//
//   initialize · ping · tools/list · list_stitches · describe_stitch (×9) · a successful
//   run_stitch on each of the four auth strategies · a vendor 401 · a validation failure · an
//   unknown stitch · an unknown tool · an unknown JSON-RPC method · a stdio parse error
//
// Two controls keep a clean scan from being vacuous:
//   (a) the wire tap proves the credential DID reach the vendor on every strategy — a 200 from a
//       vendor that enforces its own auth means the real token was attached, so "clean" is a
//       measurement of the boundary and not of a call that never authenticated;
//   (b) the in-process bytes are asserted identical to the bytes the SHIPPED stdio transport
//       writes, so the scan covers what actually ships.
//
// And one deliberate impurity: `mintApiKey` is a vendor endpoint that RETURNS a credential in its
// response body. Scanned against the secrets StitchAPI holds it is clean; scanned against every
// secret in the fixture it is a hit. Both are asserted, because the difference between "the
// library leaked a secret" and "the model asked for data and the data was a secret" is the whole
// of the exposure model.
//
//   pnpm exec tsx docs/scenarios/proofs/agent-holds-the-tool/c1-credential-reach.ts
import { inProcess, overStdio } from './client';
import {
    check,
    checkClean,
    checkDiscloses,
    checkSeq,
    finish,
    heading,
    note,
} from './harness';
import { buildRegistry } from './stitches';
import {
    ENV,
    HELD_SECRETS,
    type Route,
    SECRETS,
    Wire,
    installSecrets,
    route,
} from './vendor';

/** A vendor that answers 401 and puts a credential-shaped string in the ERROR BODY. */
const hostile: Route = () => ({
    status: 401,
    headers: { 'content-type': 'application/json' },
    body: {
        error: 'token_revoked',
        hint: `rotate ${SECRETS.mintedKey} in the dashboard`,
    },
});

async function main(): Promise<void> {
    installSecrets();

    heading('C1 (a) — the discovery surface: does any of it carry a secret?');
    const wire = new Wire(route);
    const registry = buildRegistry(wire);
    const client = await inProcess(registry, 'orders-api');

    const init = await client.send('initialize', {
        protocolVersion: '2025-06-18',
    });
    checkClean('initialize', init.raw, HELD_SECRETS);
    const ping = await client.send('ping');
    checkClean('ping', ping.raw, HELD_SECRETS);

    const tools = await client.send('tools/list');
    checkClean('tools/list', tools.raw, HELD_SECRETS);
    const toolNames = (
        tools.message.result as { tools: { name: string }[] }
    ).tools.map((t) => t.name);
    checkSeq('tools/list names', toolNames, [
        'run_stitch',
        'list_stitches',
        'describe_stitch',
    ]);
    note(
        'the tool list is a CONSTANT three tools, independent of registry size',
        Object.keys(registry).length,
    );

    const list = await client.callTool('list_stitches');
    checkClean('list_stitches', list.raw, HELD_SECRETS);

    for (const name of Object.keys(registry).sort()) {
        const described = await client.callTool('describe_stitch', { name });
        checkClean(`describe_stitch ${name}`, described.raw, HELD_SECRETS);
    }

    heading('C1 (b) — a SUCCESSFUL run_stitch, on each auth strategy');
    const runs: [string, unknown][] = [
        ['getOrder', { params: { id: '77' } }],
        ['getReport', {}],
        ['getMetrics', {}],
        ['getProfile', {}],
    ];
    for (const [name, input] of runs) {
        wire.reset();
        const ran = await client.callTool('run_stitch', { name, input });
        check(`run_stitch ${name} → isError`, ran.isError, false);
        checkClean(`run_stitch ${name} result`, ran.raw, HELD_SECRETS);
    }

    // The login stitch is registered, so the model can invoke it — and gets nothing. Its
    // credential is not on the stitch at all: `cookieSession` supplies it through `loginInput`
    // (stitches.ts), which the MCP path never reaches. Calling `login` directly therefore sends an
    // unauthenticated login and the vendor rejects it.
    wire.reset();
    const directLogin = await client.callTool('run_stitch', { name: 'login' });
    check('run_stitch login (direct) → isError', directLogin.isError, true);
    check('run_stitch login (direct) → text', directLogin.text, 'HTTP 401');
    check(
        'run_stitch login (direct) sent no password',
        (wire.last.body as { password?: string } | undefined)?.password,
        undefined,
    );
    checkClean('run_stitch login (direct)', directLogin.raw, HELD_SECRETS);
    note(
        'a registered login stitch is NOT a session-harvesting tool',
        'the login credential lives in cookieSession.loginInput, not on the stitch — the agent cannot supply it',
    );

    heading(
        'C1 (c) — the control: did the credential actually reach the wire?',
    );
    wire.reset();
    await client.callTool('run_stitch', {
        name: 'getOrder',
        input: { params: { id: '77' } },
    });
    check(
        'bearer reached the vendor',
        wire.last.headers['authorization'],
        `Bearer ${SECRETS.bearer}`,
    );
    wire.reset();
    await client.callTool('run_stitch', { name: 'getReport' });
    check(
        'apiKey(header) reached the vendor',
        wire.last.headers['x-api-key'],
        SECRETS.apiKeyHeader,
    );
    wire.reset();
    await client.callTool('run_stitch', { name: 'getMetrics' });
    check(
        'apiKey(query) reached the vendor',
        new URL(wire.last.url).searchParams.get('api_key'),
        SECRETS.apiKeyQuery,
    );
    note('apiKey(query) puts the credential in the URL', wire.last.url);
    // A FRESH registry: the session captured above lives in the seam's vault, so re-using the
    // client would measure a cache hit rather than the login-then-call spine.
    const coldWire = new Wire(route);
    const coldClient = await inProcess(buildRegistry(coldWire));
    await coldClient.callTool('run_stitch', { name: 'getProfile' });
    checkSeq(
        'cookieSession: login then the call',
        coldWire.requests.map((r) => new URL(r.url).pathname),
        ['/auth/login', '/v1/profile'],
    );
    check(
        'session cookie reached the vendor',
        coldWire.last.headers['cookie'],
        `SESSION=${SECRETS.session}`,
    );
    note(
        'the login RESPONSE carried Set-Cookie with the session value',
        'and the model still received a clean payload — response headers are not surfaced',
    );

    heading('C1 (d) — the ERROR paths');
    const badParams = await client.callTool('run_stitch', {
        name: 'getOrderTyped',
        input: { params: { id: 'not-a-number' } },
    });
    check('validation failure → isError', badParams.isError, true);
    note('validation failure → text', badParams.text);
    checkClean('run_stitch validation error', badParams.raw, HELD_SECRETS);

    const unknownStitch = await client.callTool('run_stitch', { name: 'nope' });
    check('unknown stitch → isError', unknownStitch.isError, true);
    note('unknown stitch → text', unknownStitch.text);
    checkClean('run_stitch unknown name', unknownStitch.raw, HELD_SECRETS);

    const unknownTool = await client.callTool('exfiltrate', {});
    check('unknown tool → isError', unknownTool.isError, true);
    note('unknown tool → text', unknownTool.text);
    checkClean('tools/call unknown tool', unknownTool.raw, HELD_SECRETS);

    const unknownMethod = await client.send('resources/list');
    note(
        'unknown JSON-RPC method → error',
        (unknownMethod.message.error as { code: number; message: string })
            .message,
    );
    checkClean('unknown JSON-RPC method', unknownMethod.raw, HELD_SECRETS);

    // A vendor that answers 401 and puts a credential-shaped string in the error BODY.
    const hostileWire = new Wire(hostile);
    const hostileClient = await inProcess(buildRegistry(hostileWire));
    const rejected = await hostileClient.callTool('run_stitch', {
        name: 'getOrder',
        input: { params: { id: '77' } },
    });
    check('vendor 401 → isError', rejected.isError, true);
    check('vendor 401 → text', rejected.text, 'HTTP 401');
    checkClean('run_stitch vendor 401', rejected.raw, {
        ...HELD_SECRETS,
        vendorErrorBody: SECRETS.mintedKey,
    });
    note(
        'the vendor error BODY does not reach the model either',
        'run_stitch renders `(e as Error).message` only (mcp.ts:184)',
    );

    // A missing env var: the resolver throws, and its message names the VARIABLE, not the value.
    const saved = process.env[ENV.bearer];
    delete process.env[ENV.bearer];
    const missing = await client.callTool('run_stitch', {
        name: 'getOrder',
        input: { params: { id: '77' } },
    });
    if (saved !== undefined) process.env[ENV.bearer] = saved;
    check('missing credential → isError', missing.isError, true);
    checkDiscloses(
        'missing credential names the VAR',
        missing.text,
        ENV.bearer,
    );
    checkClean('run_stitch missing credential', missing.raw, HELD_SECRETS);

    heading('C1 (e) — the whole transcript, in one scan');
    const transcript = client.transcript.map((e) => e.raw).join('\n');
    note('exchanges', client.transcript.length);
    note('bytes returned to the model', transcript.length);
    checkClean('ENTIRE TRANSCRIPT', transcript, HELD_SECRETS);

    heading('C1 (f) — the same scan over the SHIPPED stdio transport');
    const stdioWire = new Wire(route);
    const stdio = await overStdio(buildRegistry(stdioWire), 'orders-api');
    const stdioInit = await stdio.send('initialize', {});
    const stdioTools = await stdio.send('tools/list');
    const stdioRun = await stdio.callTool('run_stitch', {
        name: 'getOrder',
        input: { params: { id: '77' } },
    });
    const stdioDescribe = await stdio.callTool('describe_stitch', {
        name: 'getOrder',
    });
    const stdioBad = await stdio.send('%%not json%%');
    check(
        'stdio initialize bytes == in-process bytes',
        stdioInit.raw.replace(/"id":\d+/, '"id":N'),
        init.raw.replace(/"id":\d+/, '"id":N'),
    );
    check(
        'stdio tools/list bytes == in-process bytes',
        stdioTools.raw.replace(/"id":\d+/, '"id":N'),
        tools.raw.replace(/"id":\d+/, '"id":N'),
    );
    checkClean('stdio run_stitch', stdioRun.raw, HELD_SECRETS);
    checkClean('stdio describe_stitch', stdioDescribe.raw, HELD_SECRETS);
    note(
        'stdio unknown method → error',
        JSON.stringify(stdioBad.message.error),
    );
    stdio.close();

    heading('C1 (g) — the ONE thing that does reach the model, and why');
    wire.reset();
    const minted = await client.callTool('run_stitch', { name: 'mintApiKey' });
    check('mintApiKey → isError', minted.isError, false);
    checkClean('mintApiKey vs. secrets StitchAPI HOLDS', minted.raw, {
        ...HELD_SECRETS,
    });
    checkDiscloses(
        'mintApiKey → the VENDOR-returned key',
        minted.text,
        SECRETS.mintedKey,
    );
    note(
        'this is not a boundary failure',
        'the credential was never StitchAPI\'s to hold — it is a response BODY, and "return the data" is the contract',
    );
    note(
        'ONE HELD CREDENTIAL *CAN* REACH THE MODEL — see C4 (c)',
        'not through any payload enumerated above, but through the error channel: `run_stitch` renders `(e as Error).message` unfiltered, and a transport error message that quotes the request URL carries an `apiKey({ in: "query" })` credential with it',
    );

    finish(
        'C1',
        'HELD. Across 34 JSON-RPC exchanges and 30 separate payload scans (14,529 bytes in the main transcript alone) — initialize, ping, tools/list, list_stitches, describe_stitch on all 10 stitches, a successful run_stitch on bearer/apiKey-header/apiKey-query/cookieSession, a direct call to the registered login stitch, a vendor 401 whose error BODY contained a credential-shaped string, a validation failure, an unknown stitch, an unknown tool, an unknown JSON-RPC method and a stdio parse error — NOT ONE of the five credentials the registry holds appeared, by value, anywhere. The controls hold too: the same calls put `Bearer sk_live_…` on the wire, `X-API-Key: ak_live_…` on the wire, `api_key=ak_live_…` in the URL and `Cookie: SESSION=sess_live_…` on the wire, so the vendor authenticated every one of them; and the stdio transport writes byte-identical payloads. The only credential that reached the model is one the VENDOR minted and returned in a response body, which is data by definition — and the failure mode there belongs to whoever registered that endpoint, not to the boundary. ONE CAVEAT, and it is not in any payload enumerated here: the error channel is an unfiltered `Error.message` pass-through, so a TRANSPORT error that quotes the request URL carries an `apiKey({ in: "query" })` credential into the model with it — measured on the default adapter in C4 (c)',
    );
}

void main();

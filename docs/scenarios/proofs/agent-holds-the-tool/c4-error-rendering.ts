// C4 — what does a FAILURE tell the model?
//
// `run_stitch` renders a failure as `errorResult((e as Error).message)` (mcp.ts:184) — the error's
// message string, and nothing else. That one line decides this claim in both directions:
//
//   the good half — a `StitchError` carries `.status`, `.attempts`, `.body` (the vendor's error
//   payload) and `.url` (the final request URL), and NONE of them are rendered. The vendor's
//   `{"error":"token_revoked","hint":"rotate ak_live_… in the dashboard"}` never reaches the model;
//   it gets `HTTP 401`. StitchAPI's own messages are uniformly terse and carry no request detail.
//
//   the bad half — it is an UNFILTERED PASS-THROUGH. Any error that reaches the top of the stack
//   hands its message to the model verbatim, including one the TRANSPORT wrote. Node's built-in
//   `fetch` writes `Failed to parse URL from <the whole URL>`, and on an `apiKey({ in: 'query' })`
//   stitch the whole URL contains the credential. That is measured below, on the default adapter,
//   with no user code and no network.
//
// Everything here is offline: the "network failure" is a port outside the valid range, so `fetch`
// rejects the URL before opening a socket.
//
//   pnpm exec tsx docs/scenarios/proofs/agent-holds-the-tool/c4-error-rendering.ts
import { apiKey, bearer, env } from '../../../../packages/core/src/auth';
import { seam, stitch } from '../../../../packages/core/src/index';
import type { Adapter } from '../../../../packages/core/src/types';
import { inProcess } from './client';
import {
    check,
    checkClean,
    checkDiscloses,
    finish,
    heading,
    note,
} from './harness';
import { buildRegistry, schema } from './stitches';
import {
    BASE,
    ENV,
    HELD_SECRETS,
    type Route,
    SECRETS,
    Wire,
    installSecrets,
    route,
} from './vendor';

/** A vendor that answers 500 with a detailed internal error body. */
const leaky: Route = () => ({
    status: 500,
    headers: {
        'content-type': 'application/json',
        'x-internal-node': 'shard-7.internal',
    },
    body: {
        error: 'internal',
        stack: 'at OrderService.load (/srv/vendor/src/orders.ts:88)',
        db: 'postgres://vendor:hunter2@db-primary.internal:5432/orders',
    },
});

/**
 * A `node-fetch`-shaped adapter error. node-fetch (and `got`, and several house wrappers) put the
 * FULL REQUEST URL in the message of every network failure — `request to <url> failed, reason: …`
 * — which is what makes the pass-through matter in production rather than only under a typo.
 */
const nodeFetchShaped: Adapter = (req) => {
    throw new Error(
        `request to ${req.url} failed, reason: getaddrinfo ENOTFOUND api.vendor.test`,
    );
};

async function main(): Promise<void> {
    installSecrets();

    heading('C4 (a) — the failure taxonomy: what text does the model get?');
    const wire = new Wire(route);
    const client = await inProcess(buildRegistry(wire));

    const leakyWire = new Wire(leaky);
    const leakyClient = await inProcess(buildRegistry(leakyWire));
    const http500 = await leakyClient.callTool('run_stitch', {
        name: 'getOrder',
        input: { params: { id: '77' } },
    });
    check('a vendor 500 → text', http500.text, 'HTTP 500');
    check(
        'the vendor’s error BODY is absent',
        http500.raw.includes('shard-7.internal') ||
            http500.raw.includes('postgres://') ||
            http500.raw.includes('orders.ts:88'),
        false,
    );
    note(
        'StitchError carries .status/.attempts/.body/.url',
        'run_stitch renders `.message` and drops all four (mcp.ts:184)',
    );

    // A transport that never settles, so the timeout is what ends the call.
    const timeoutApi = seam({
        baseUrl: BASE,
        adapter: () =>
            new Promise(() => {
                /* never settles */
            }),
    });
    const timeoutClient = await inProcess({
        slowOrders: timeoutApi.stitch({
            name: 'slowOrders',
            path: '/v1/orders',
            auth: bearer(env(ENV.bearer)),
            timeout: { each: 25 },
        }),
    });
    const timedOut = await timeoutClient.callTool('run_stitch', {
        name: 'slowOrders',
    });
    check('a timeout → text', timedOut.text, 'timed out after 25ms');

    const flakyWire = new Wire(leaky);
    const flakyApi = seam({ baseUrl: BASE, adapter: flakyWire.adapter() });
    const breakerClient = await inProcess({
        brittle: flakyApi.stitch({
            name: 'brittle',
            path: '/v1/orders',
            auth: bearer(env(ENV.bearer)),
            circuit: { failures: 1, cooldown: '1m' },
        }),
    });
    await breakerClient.callTool('run_stitch', { name: 'brittle' });
    const opened = await breakerClient.callTool('run_stitch', {
        name: 'brittle',
    });
    check('an open circuit → text', opened.text, 'circuit open');

    const badInput = await client.callTool('run_stitch', {
        name: 'getOrderTyped',
        input: { params: { id: 'DROP TABLE' } },
    });
    check(
        'an input contract breach → text',
        badInput.text,
        'invalid params: expected { id: numeric string }',
    );
    note(
        'the schema’s own issue text is rendered',
        'a message that echoes the offending value would reach the model with it',
    );

    const strictApi = seam({ baseUrl: BASE, adapter: wire.adapter() });
    const outputClient = await inProcess({
        strictOrders: strictApi.stitch({
            name: 'strictOrders',
            path: '/v1/orders',
            auth: bearer(env(ENV.bearer)),
            output: schema('{ nothing like this }', () => false),
        }),
    });
    const badOutput = await outputClient.callTool('run_stitch', {
        name: 'strictOrders',
    });
    note('an output contract breach → text', badOutput.text);
    check(
        'the vendor’s response is not quoted back',
        badOutput.raw.includes('acme') || badOutput.raw.includes('o_1'),
        false,
    );

    const unknown = await client.callTool('run_stitch', { name: 'orders' });
    checkDiscloses(
        'an unknown name → the whole route table',
        unknown.text,
        'getMetrics, getOrder, getOrderTyped, getProfile, getReport, listOrders, login, mintApiKey, refund, searchOrders',
    );

    heading('C4 (b) — is any of that a credential leak? No.');
    for (const ex of [http500, timedOut, opened, badInput, badOutput, unknown])
        checkClean(`${ex.label} ${ex.text.slice(0, 18)}`, ex.raw, HELD_SECRETS);

    heading('C4 (c) — THE LEAK: the message is an unfiltered pass-through');
    // The DEFAULT transport. No adapter, no network: port 99999 is outside the valid range, so
    // undici rejects the URL string before opening a socket — and puts that string in the message.
    const defaultTransport = await inProcess({
        metrics: stitch({
            baseUrl: 'http://api.vendor.test:99999',
            path: '/v1/metrics',
            auth: apiKey({ in: 'query', secret: env(ENV.apiKeyQuery) }),
        }),
    });
    const parseFail = await defaultTransport.callTool('run_stitch', {
        name: 'metrics',
    });
    check('isError', parseFail.isError, true);
    note('the text the model received', parseFail.text);
    checkDiscloses(
        'the model’s payload now holds the KEY',
        parseFail.raw,
        SECRETS.apiKeyQuery,
    );
    note(
        'nothing here is user code',
        'built-in fetchAdapter, built-in apiKey({ in: "query" }), a mistyped port — and the credential is in the model’s context',
    );

    // The realistic trigger: a third-party adapter that names the URL on EVERY network error.
    const nodeFetchClient = await inProcess({
        metrics: stitch({
            baseUrl: BASE,
            path: '/v1/metrics',
            auth: apiKey({ in: 'query', secret: env(ENV.apiKeyQuery) }),
            adapter: nodeFetchShaped,
        }),
    });
    const dnsFail = await nodeFetchClient.callTool('run_stitch', {
        name: 'metrics',
    });
    note('a node-fetch-shaped DNS failure → text', dnsFail.text);
    checkDiscloses(
        'the KEY again, on a routine DNS failure',
        dnsFail.raw,
        SECRETS.apiKeyQuery,
    );

    // The control: the SAME transport failure on a bearer stitch discloses the URL and no secret.
    const bearerClient = await inProcess({
        orders: stitch({
            baseUrl: BASE,
            path: '/v1/orders',
            auth: bearer(env(ENV.bearer)),
            adapter: nodeFetchShaped,
        }),
    });
    const bearerFail = await bearerClient.callTool('run_stitch', {
        name: 'orders',
    });
    checkClean('the same failure under bearer', bearerFail.raw, HELD_SECRETS);
    checkDiscloses(
        '…discloses the URL, but the URL holds nothing',
        bearerFail.text,
        `${BASE}/v1/orders`,
    );
    note(
        'the leak is a PROPERTY OF apiKey({ in: "query" }), not of MCP',
        'the auth guide already warns a key in the URL leaks wherever URLs go — this measures one more place it goes: the model’s context',
    );

    finish(
        'C4',
        "NO LEAK FROM StitchAPI'S OWN ERRORS, AND ONE REAL LEAK THROUGH THEM. `run_stitch` renders `(e as Error).message` and drops everything else a `StitchError` carries — `.status`, `.attempts`, `.body`, `.url` — so a vendor 500 whose body held an internal hostname, a stack frame and a `postgres://vendor:hunter2@…` DSN reached the model as the four characters `HTTP 500`. The whole built-in taxonomy is terse and request-free: `HTTP 500`, `timed out after 25ms`, `circuit open`, `invalid params: <the schema's own issue text>`, `contract violation (drift)`. The one disclosure that is by design is name enumeration — an unknown stitch answers with every registered name. BUT THE CHANNEL IS UNFILTERED, and that is a genuine hole in C1's promise: any message written by the TRANSPORT reaches the model verbatim. On the DEFAULT `fetchAdapter`, with an `apiKey({ in: 'query' })` stitch and a mistyped port, the model received `Failed to parse URL from http://api.vendor.test:99999/v1/metrics?api_key=ak_live_qry_8899aabbccddeeff` — the credential, in its context, from zero lines of user code. With a `node-fetch`-shaped adapter (`request to <url> failed, reason: …`) the same thing happens on any DNS failure, which is a routine production event rather than a typo. The control pins the cause: the identical failure on a `bearer` stitch disclosed the URL and no secret. This is `apiKey({ in: 'query' })` leaking where URLs go — the auth guide already says so — and the MCP error channel is one more place URLs go",
    );
}

void main();

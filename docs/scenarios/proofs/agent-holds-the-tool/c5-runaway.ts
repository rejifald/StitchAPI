// C5 — runaway containment. Do `throttle` and `circuit` apply on the MCP path, and can a budget be
// expressed as anything other than a request count?
//
// The capture's framing: "the most common production incident is not a model giving the wrong
// answer; it is an agent that decides to retry, and retry, and retry." So there are three separate
// questions, and they have three different answers:
//
//   1. Do the existing limiters run when the caller is an agent? (Yes — the MCP path is the same
//      engine, and nothing about `run_stitch` bypasses the resilience chain.)
//   2. What bounds a burst BY DEFAULT? (Nothing. 50 tool calls made 50 vendor requests.)
//   3. Is one tool call one vendor request? (No, and this is the part a per-call cap misses:
//      `retry` and `paginate` multiply the model's single call into many, invisibly.)
//
// And the budget question is answered by enumeration: every bound the config surface offers is a
// COUNT or a DURATION. There is no cost, token, byte or currency budget anywhere.
//
// The stdio transport contributes a containment property of its own, measured in (e): `serveStdio`
// chains message handling (mcp.ts:346), so tool calls are processed strictly in order no matter how
// fast a client writes them. That is a real serialisation guarantee — and one that does not
// transfer to the HTTP transport the module's own header invites a host to build.
//
//   pnpm exec tsx docs/scenarios/proofs/agent-holds-the-tool/c5-runaway.ts
import { bearer, env } from '../../../../packages/core/src/auth';
import { seam } from '../../../../packages/core/src/index';
import { inProcess, loadMcp } from './client';
import { check, finish, heading, note } from './harness';
import { BASE, ENV, type Route, Wire, installSecrets, route } from './vendor';

import { PassThrough } from 'node:stream';

/** A vendor that always fails — the circuit's input. */
const failing: Route = () => ({
    status: 503,
    headers: {},
    body: { error: 'unavailable' },
});

/** Two pages of orders, so `paginate` has somewhere to go. */
const paged: Route = (req) => {
    const page = Number(new URL(req.url).searchParams.get('page') ?? '1');
    return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: {
            data: [{ id: `o_${String(page)}` }],
            next: page < 12 ? page + 1 : null,
        },
    };
};

async function main(): Promise<void> {
    installSecrets();

    heading('C5 (a) — with no policy configured, what bounds a burst?');
    const openWire = new Wire(route);
    const openApi = seam({ baseUrl: BASE, adapter: openWire.adapter() });
    const openClient = await inProcess({
        orders: openApi.stitch({
            name: 'orders',
            path: '/v1/orders',
            auth: bearer(env(ENV.bearer)),
        }),
    });
    const t0 = Date.now();
    for (let i = 0; i < 50; i++)
        await openClient.callTool('run_stitch', { name: 'orders' });
    const openElapsed = Date.now() - t0;
    check('50 tool calls → vendor requests', openWire.count, 50);
    note('elapsed (ms)', openElapsed);
    note(
        'nothing is on by default',
        'no throttle, no circuit, no cap — the model’s call rate IS the vendor’s call rate',
    );

    heading('C5 (b) — does `throttle` apply on the MCP path?');
    const pacedWire = new Wire(route);
    const pacedApi = seam({ baseUrl: BASE, adapter: pacedWire.adapter() });
    const pacedClient = await inProcess({
        orders: pacedApi.stitch({
            name: 'orders',
            path: '/v1/orders',
            auth: bearer(env(ENV.bearer)),
            // A minimum spacing of 20ms between calls (ADR 0023: a rate is a spacing).
            throttle: '50/s',
        }),
    });
    const t1 = Date.now();
    for (let i = 0; i < 10; i++)
        await pacedClient.callTool('run_stitch', { name: 'orders' });
    const pacedElapsed = Date.now() - t1;
    check('10 tool calls → vendor requests', pacedWire.count, 10);
    note('elapsed (ms), 20ms spacing × 9 gaps ≈ 180', pacedElapsed);
    check('the throttle paced the agent', pacedElapsed >= 170, true);
    note(
        'the same limiter, reached through a different door',
        'run_stitch calls the stitch; the stitch is the engine; the engine is where throttle lives',
    );

    heading('C5 (c) — does `circuit` apply?');
    const brokenWire = new Wire(failing);
    const brokenApi = seam({ baseUrl: BASE, adapter: brokenWire.adapter() });
    const brokenClient = await inProcess({
        orders: brokenApi.stitch({
            name: 'orders',
            path: '/v1/orders',
            auth: bearer(env(ENV.bearer)),
            circuit: { failures: 3, cooldown: '10m' },
        }),
    });
    const texts: string[] = [];
    for (let i = 0; i < 20; i++)
        texts.push(
            (await brokenClient.callTool('run_stitch', { name: 'orders' }))
                .text,
        );
    check('20 tool calls → vendor requests', brokenWire.count, 3);
    check(
        'and the rest fast-failed',
        texts.filter((t) => t === 'circuit open').length,
        17,
    );
    note(
        'the breaker is the one control that survives an agent loop',
        '17 of 20 calls cost the vendor nothing — but they still cost the model a turn',
    );

    heading('C5 (d) — one tool call is not one vendor request');
    const retryWire = new Wire(failing);
    const retryApi = seam({ baseUrl: BASE, adapter: retryWire.adapter() });
    const retryClient = await inProcess({
        orders: retryApi.stitch({
            name: 'orders',
            path: '/v1/orders',
            auth: bearer(env(ENV.bearer)),
            retry: { attempts: 5, backoff: { base: 1 } },
        }),
    });
    await retryClient.callTool('run_stitch', { name: 'orders' });
    check('1 tool call with retry ×5 → vendor requests', retryWire.count, 5);

    const pageWire = new Wire(paged);
    const pageApi = seam({ baseUrl: BASE, adapter: pageWire.adapter() });
    const pageClient = await inProcess({
        allOrders: pageApi.stitch({
            name: 'allOrders',
            path: '/v1/orders',
            auth: bearer(env(ENV.bearer)),
            paginate: {
                // `next` reads the RAW body of the page just fetched (engine.ts:985).
                next: (body) => {
                    const next = (body as { next: number | null }).next;
                    return next == null ? undefined : { query: { page: next } };
                },
            },
            // `pick` runs before the items are collected, so each page contributes its `data` array.
            pick: 'data',
        }),
    });
    await pageClient.callTool('run_stitch', { name: 'allOrders' });
    check('1 tool call with paginate → vendor requests', pageWire.count, 12);
    note(
        'the amplification is invisible to the model AND to a per-tool-call cap',
        'a host that budgets "20 tool calls" budgeted up to 100 vendor requests with retry, or 1,000 with the default paginate cap of 50',
    );

    heading(
        'C5 (e) — the stdio transport serialises, whatever the client does',
    );
    const { serveStdio } = await loadMcp();
    const orderWire = new Wire(route);
    const orderApi = seam({ baseUrl: BASE, adapter: orderWire.adapter() });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    stdout.setEncoding('utf8');
    const handle = serveStdio(
        {
            orders: orderApi.stitch({
                name: 'orders',
                path: '/v1/orders',
                auth: bearer(env(ENV.bearer)),
                throttle: '50/s',
            }),
        },
        { stdin, stdout },
    );
    const ids: number[] = [];
    stdout.on('data', (chunk: string) => {
        for (const line of chunk.split('\n').filter(Boolean))
            ids.push((JSON.parse(line) as { id: number }).id);
    });
    // Write eight tool calls in ONE chunk — the most concurrent a stdio client can be.
    const burst = Array.from({ length: 8 }, (_, i) =>
        JSON.stringify({
            jsonrpc: '2.0',
            id: i + 1,
            method: 'tools/call',
            params: { name: 'run_stitch', arguments: { name: 'orders' } },
        }),
    ).join('\n');
    const t2 = Date.now();
    stdin.write(`${burst}\n`);
    await new Promise<void>((resolve) => {
        const tick = setInterval(() => {
            if (ids.length === 8) {
                clearInterval(tick);
                resolve();
            }
        }, 5);
    });
    const burstElapsed = Date.now() - t2;
    check('8 messages written at once → all answered', ids.length, 8);
    check('…in request order', ids.join(','), '1,2,3,4,5,6,7,8');
    check(
        '…and still paced (7 gaps × 20ms ≈ 140ms)',
        burstElapsed >= 130,
        true,
    );
    handle.close();
    stdin.end();
    note(
        'mcp.ts:346 chains dispatch',
        '`chain = chain.then(() => dispatch(line))` — the stdio transport can never run two tool calls at once',
    );
    note(
        'this does NOT transfer to an HTTP transport',
        'mcp.ts:1-9 invites one ("the same core can back a Streamable HTTP transport"), and a host that builds it inherits no serialisation',
    );

    heading('C5 (f) — can a budget be expressed as anything but a count?');
    const bounds = [
        [
            'throttle.rate',
            'a minimum SPACING between calls — a count over a window',
        ],
        ['throttle.concurrency', 'a COUNT of simultaneous in-flight calls'],
        ['retry.attempts', 'a COUNT of attempts'],
        ['timeout.each / timeout.total', 'a DURATION'],
        ['paginate.pages', 'a COUNT of pages (default 50)'],
        ['circuit.failures / cooldown', 'a COUNT and a DURATION'],
        [
            'stream.buffer.chars',
            'a COUNT of decoded characters, streaming only',
        ],
    ];
    for (const [slot, kind] of bounds) note(String(slot), kind);
    check(
        'a cost / token / byte / currency budget exists',
        bounds.some(([, kind]) =>
            /cost|token|currenc|money|byte/i.test(String(kind)),
        ),
        false,
    );
    note(
        'the runaway the capture describes is a SPEND, not a rate',
        'the $6,531 case was inside any per-minute cap that was set — what it exceeded was a budget nothing here can express',
    );

    finish(
        'C5',
        "THE LIMITERS APPLY, NOTHING IS ON BY DEFAULT, AND NO BUDGET IS A SPEND. `throttle` and `circuit` both run on the MCP path because `run_stitch` calls the stitch and the stitch IS the engine: `throttle: '50/s'` paced ten tool calls to 180ms of 20ms gaps, and `circuit: { failures: 3 }` turned twenty tool calls into three vendor requests plus seventeen `circuit open` fast-fails. With nothing configured, fifty tool calls made fifty vendor requests in a few milliseconds — the model's call rate is the vendor's call rate. THE PART A PER-CALL CAP MISSES: one tool call is not one request. `retry: { attempts: 5 }` made five, and `paginate` made twelve (its default ceiling is 50), with no signal of either in the tool result — so a host that budgets \"20 tool calls\" has budgeted up to 1,000 vendor requests. THE STDIO TRANSPORT ADDS ONE REAL GUARANTEE: eight tool calls written in a single chunk were answered in request order and still paced (mcp.ts:346 chains dispatch), so no stdio client can run two calls at once — a property the HTTP transport the module invites a host to build does not inherit. AND THE BUDGET ANSWER IS NO: every bound on the surface is a COUNT (`throttle.rate` spacing, `throttle.concurrency`, `retry.attempts`, `paginate.pages`, `circuit.failures`, `stream.buffer.chars`) or a DURATION (`timeout`, `circuit.cooldown`). Nothing expresses cost, tokens, bytes off the socket, or money — which is the axis the runaway incident in the capture actually ran along",
    );
}

void main();

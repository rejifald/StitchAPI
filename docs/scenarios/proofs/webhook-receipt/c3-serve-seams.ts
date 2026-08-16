// C3 — can a signature be verified THROUGH `serve` at all? Via a surface, a hook, `ServeBodyOptions`,
// anything? Or must the user bring their own server?
//
// C1 established that the bytes and the headers are gone by the time user code runs. C3 asks the
// follow-up an engineer actually asks: fine, but is there a seam EARLIER? The serve path has three
// candidate places — the `ServeOptions` envelope, the exported `createServeHandler` mount point,
// and the stitch's own hooks — and this script drives all three against a real server.
//
// The finding with teeth is (e). `createServeHandler` really is a mount seam, and the obvious way
// to use it is exactly wrong: to verify a signature you must read the request stream, and
// `readBody` (serve.ts:90-120) then attaches its `data`/`end` listeners to a stream that has
// already ended. The request HANGS. Measured with a 200ms deadline, because "it hangs" is not a
// thing you can assert without one.
//
//   pnpm exec tsx docs/scenarios/proofs/webhook-receipt/c3-serve-seams.ts
import { stitch } from '../../../../packages/core/src/index';
import {
    MAX_REQUEST_BODY_BYTES,
    createServeHandler,
    serve,
} from '../../../../packages/core/src/serve';
import * as serveMod from '../../../../packages/core/src/serve';
import type { Adapter, HookContext } from '../../../../packages/core/src/types';
import { type BillingEvent, mintDelivery } from './fake-billing';
import { check, checkSeq, finish, heading, note } from './harness';
import { verifySignature } from './stripe-sig';

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

const SECRET = 'whsec_test_2f9d1c4b';
const NOW_SECONDS = 1_800_000_000;
const EVENT: BillingEvent = {
    id: 'evt_1PqR',
    type: 'customer.subscription.updated',
    created: NOW_SECONDS,
    data: {
        object: { id: 'sub_1', status: 'active', plan: 'pro', version: 2 },
    },
};

async function main(): Promise<void> {
    heading('C3 — every seam on the serve path, driven');

    const delivery = mintDelivery(EVENT, SECRET, NOW_SECONDS);

    // ── (a) what `stitchapi/serve` actually offers ────────────────────────────────────────────
    checkSeq(
        '(a) `stitchapi/serve` runtime exports',
        Object.keys(serveMod).sort(),
        ['MAX_REQUEST_BODY_BYTES', 'createServeHandler', 'serve'],
    );
    check(
        '(a) default body cap (bytes)',
        MAX_REQUEST_BODY_BYTES,
        2 * 1024 * 1024,
    );
    note(
        '(a) → three exports: a server, a mountable handler, and a number',
        'no verifier, no middleware chain, no per-route registration',
    );

    // ── (b) the `ServeBodyOptions` seam, driven: it is a byte cap and only a byte cap ──────────
    {
        const hookCalls: HookContext[] = [];
        const echo: Adapter = async () => ({
            status: 200,
            headers: {},
            body: { ack: true },
        });
        const registry = {
            'on-webhook': stitch({
                url: 'https://unused.test/never',
                method: 'POST',
                adapter: echo,
                hooks: {
                    onRequest: (ctx) => {
                        hookCalls.push(ctx);
                    },
                },
            }),
        };
        const handle = await serve(registry, { port: 0, body: { max: 64 } });
        try {
            const res = await fetch(handle.url + '/stitch/on-webhook', {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'stripe-signature': delivery.signature,
                },
                body: Uint8Array.from(delivery.raw),
            });
            const parsed = (await res.json()) as { error?: string };
            check(
                '(b) `body.max: 64` against a 130-byte delivery → status',
                res.status,
                413,
            );
            check(
                '(b) → the rejection is about SIZE, not authenticity',
                parsed.error?.includes('exceeds') ?? false,
                true,
            );

            // Now within the cap: the delivery runs the stitch with no credential of any kind.
            const ok = await fetch(handle.url + '/stitch/on-webhook', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: '{"id":"evt_forged"}',
            });
            await ok.arrayBuffer();
            check('(b) an UNSIGNED, forged body → status', ok.status, 200);
            check('(b) → it ran the stitch anyway', hookCalls.length, 1);
            note(
                '(b) → `serve` is unauthenticated by design (serve.ts:28,59)',
                'the only inbound control in `ServeOptions` is `body.max`; there is no credential check to fail',
            );

            // ── (c) the stitch-side hooks point OUTWARD ───────────────────────────────────────
            const ctx = hookCalls[0];
            check(
                '(c) `hooks.onRequest` saw a request whose url is the OUTBOUND one',
                ctx?.req?.url,
                'https://unused.test/never',
            );
            check(
                '(c) does that request carry the inbound `stripe-signature`?',
                Object.keys(ctx?.req?.headers ?? {}).some(
                    (h) => h.toLowerCase() === 'stripe-signature',
                ),
                false,
            );
            checkSeq(
                '(c) `HookContext` keys available to a hook',
                Object.keys(ctx ?? {}).sort(),
                ['attempt', 'name', 'req'],
            );
            note(
                '(c) → `Hooks` is {onRequest,onResponse,onError,onRetry} (types.ts:1285-1290)',
                'all four describe the call the stitch is MAKING; none describes the request that arrived',
            );
        } finally {
            await handle.close();
        }
    }

    // ── (d) the real seam: `createServeHandler` mounted at a user path, in a user server ───────
    // This part WORKS, and it is worth saying so: the handler is framework-free and exported
    // exactly so it can be mounted (serve.ts:203-206). A user can own the route.
    {
        const seenInput: unknown[] = [];
        const registry = {
            'on-webhook': stitch({
                url: 'https://unused.test/never',
                method: 'POST',
                adapter: (async (req) => {
                    seenInput.push(req.body);
                    return { status: 200, headers: {}, body: { ack: true } };
                }) as Adapter,
            }),
        };
        const handler = createServeHandler(registry);
        const server = createServer((req, res) => {
            // The user's own routing table — an arbitrary path, which is the thing `serve` cannot do.
            if (req.url?.startsWith('/webhooks/stripe')) {
                req.url = '/stitch/on-webhook';
                void handler(req, res);
                return;
            }
            res.writeHead(404).end();
        });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        try {
            const res = await fetch(
                `http://127.0.0.1:${port}/webhooks/stripe`,
                {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ body: { forwarded: true } }),
                },
            );
            await res.arrayBuffer();
            check(
                '(d) mounted at an arbitrary user path → status',
                res.status,
                200,
            );
            check('(d) the stitch ran', seenInput.length, 1);
            note(
                '(d) → `createServeHandler` genuinely is a mount seam',
                'the ROUTE problem from C1 is solvable by owning the server. The BYTES problem is not — see (e)',
            );
        } finally {
            server.closeAllConnections();
            await new Promise<void>((r) => server.close(() => r()));
        }
    }

    // ── (e) …and mounting it behind a verifier does not work, because verifying consumes ───────
    // To check a signature you must have the bytes. To have the bytes you must read the stream.
    // `readBody` then waits on a stream that has already ended.
    {
        const registry = {
            'on-webhook': stitch({
                url: 'https://unused.test/never',
                method: 'POST',
                adapter: (async () => ({
                    status: 200,
                    headers: {},
                    body: { ack: true },
                })) as Adapter,
            }),
        };
        const handler = createServeHandler(registry);
        let verified = false;
        let handlerSettled = false;
        const server = createServer(
            (req: IncomingMessage, res: ServerResponse) => {
                void (async () => {
                    // 1. Read the raw bytes — the ONLY way to verify.
                    const chunks: Buffer[] = [];
                    for await (const c of req) chunks.push(c as Buffer);
                    const raw = Buffer.concat(chunks);
                    verified = verifySignature(
                        raw,
                        req.headers['stripe-signature'] as string | undefined,
                        SECRET,
                        NOW_SECONDS,
                    ).ok;

                    // 2. Hand the (now-drained) request to the handler.
                    req.url = '/stitch/on-webhook';
                    const done = handler(req, res).then(() => {
                        handlerSettled = true;
                    });
                    const deadline = new Promise<void>((r) =>
                        setTimeout(r, 200).unref(),
                    );
                    await Promise.race([done, deadline]);
                    if (!handlerSettled && !res.headersSent) {
                        res.writeHead(504, {
                            'content-type': 'application/json',
                        });
                        res.end(
                            JSON.stringify({ error: 'handler never settled' }),
                        );
                    }
                })();
            },
        );
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        try {
            const res = await fetch(
                `http://127.0.0.1:${port}/webhooks/stripe`,
                {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        'stripe-signature': delivery.signature,
                    },
                    body: Uint8Array.from(delivery.raw),
                },
            );
            await res.arrayBuffer();
            check(
                '(e) the signature verified against the raw bytes',
                verified,
                true,
            );
            check(
                '(e) …and then `createServeHandler` settled within 200ms',
                handlerSettled,
                false,
            );
            check('(e) what the client got', res.status, 504);
            note(
                '(e) → `readBody` (serve.ts:90-120) waits for `end` on an ended stream',
                'verifying and delegating are mutually exclusive unless you re-feed a synthetic stream',
            );
        } finally {
            server.closeAllConnections();
            await new Promise<void>((r) => server.close(() => r()));
        }
    }

    finish(
        'C3',
        'NO seam exists on the serve path, and the mount point that does exist is defeated by the act of verifying. `stitchapi/serve` exports exactly three things — `serve`, `createServeHandler`, `MAX_REQUEST_BODY_BYTES` — and `ServeOptions` carries one inbound control, a byte cap: `{body:{max:64}}` answered a 130-byte signed delivery with 413 "exceeds", while an UNSIGNED forged body under the cap ran the stitch and returned 200, because `serve` is unauthenticated by design (serve.ts:28,59). The stitch-side hooks point the other way: `hooks.onRequest` fired with `req.url` = the OUTBOUND url and no `stripe-signature` header, and `HookContext` offered exactly {attempt,name,req}. `createServeHandler` IS a genuine mount seam — mounted in a plain `node:http` server it served an arbitrary path `/webhooks/stripe` and ran the stitch, 200 — so the ROUTE half of C1 is fixable by owning the server. The BYTES half is not: reading the stream to verify (which succeeded) left `readBody` (serve.ts:90-120) waiting on `end` from an already-ended stream, and the handler had not settled after 200ms — the client got a 504 from the test deadline rather than a response. You must bring your own server, and once you have, the `serve` front door adds nothing to the webhook path',
    );
}

void main();

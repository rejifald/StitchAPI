// THE RECEIPT HALF — user code, and there is no StitchAPI in this file. That absence is the
// deliverable: C1–C3 measured that nothing in the library can receive a signed webhook, so the
// honest end-to-end answer starts with a plain `node:http` server, and this is what it costs.
//
// Everything the capture lists as required is here and nowhere else:
//
//   • an arbitrary route the provider dashboard can be pointed at
//   • the RAW bytes, buffered before anything parses them
//   • a constant-time HMAC over those bytes, inside a timestamp tolerance (`stripe-sig.ts`)
//   • an atomic dedup claim on the event id, TTL beyond the provider's retry window
//   • a 2xx written BEFORE the work starts
//   • a body cap, so an unbounded POST cannot OOM the process
//
// The dedup ledger is a `StitchStore` — the ONE place the two halves genuinely share machinery
// (C5): it is an interface the user supplies, so the same Redis handle backs both the ledger here
// and the engine's throttle state on the other side. That is a type dependency, not a runtime one.
//
// `onEvent` is deliberately fired AFTER the response is flushed and its promise is not awaited by
// the request path. That is an ack, not a queue — see `README.md`; a production system replaces it
// with an enqueue, and then owns a second dedup problem one layer down.
import type { StitchStore } from '../../../../packages/core/src/types';
import { type VerifyResult, verifySignature } from './stripe-sig';

import { type Server, createServer } from 'node:http';

export interface ReceiverOptions {
    path: string;
    secret: string;
    store: StitchStore;
    /** TTL for a dedup entry, in ms. Must exceed the provider's retry window (Stripe: 3 days). */
    dedupTtlMs: number;
    /** Injected so the tolerance boundary is testable; defaults to the wall clock. */
    nowSeconds?: () => number;
    /** Ceiling on a buffered body. */
    maxBytes?: number;
    /**
     * The reaction half. Fired after the ack; never awaited by the request path. It is handed the
     * event id (for dedup + idempotency), the type, and the SUBJECT id — and nothing else from the
     * payload, because C4 measured that the payload's own state is the part you must not trust.
     */
    onEvent: (event: {
        id: string;
        type: string;
        subject: string;
    }) => Promise<void>;
    /** Observability seam for the proofs — one line per delivery decision. */
    onDecision?: (decision: string) => void;
}

export interface ReceiverHandle {
    url: string;
    server: Server;
    close(): Promise<void>;
}

export async function startReceiver(
    opts: ReceiverOptions,
): Promise<ReceiverHandle> {
    const now = opts.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    const maxBytes = opts.maxBytes ?? 1024 * 1024;
    const decide = opts.onDecision ?? ((): void => undefined);

    const server = createServer((req, res) => {
        void (async () => {
            if (req.method !== 'POST' || req.url !== opts.path) {
                res.writeHead(404).end();
                return;
            }
            // 1. RAW bytes, bounded. Nothing may parse before the MAC is checked.
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const c of req) {
                const buf = c as Buffer;
                size += buf.length;
                if (size > maxBytes) {
                    req.destroy();
                    res.writeHead(413).end();
                    decide('too-large');
                    return;
                }
                chunks.push(buf);
            }
            const raw = Buffer.concat(chunks);

            // 2. Authenticity + replay window, over those exact bytes.
            const verdict: VerifyResult = verifySignature(
                raw,
                req.headers['stripe-signature'] as string | undefined,
                opts.secret,
                now(),
            );
            if (!verdict.ok) {
                res.writeHead(400, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: verdict.reason }));
                decide(verdict.reason);
                return;
            }

            // 3. Only now is parsing safe.
            const parsed = JSON.parse(raw.toString('utf8')) as {
                id: string;
                type: string;
                data: { object: { id: string } };
            };
            const event = {
                id: parsed.id,
                type: parsed.type,
                subject: parsed.data.object.id,
            };

            // 4. Atomic dedup claim. `increment` and not `get`+`set`: the racy pair lets two
            //    workers both win (C5 (b)).
            const claim = await opts.store.increment(
                `webhook:${event.id}`,
                opts.dedupTtlMs,
            );
            if (claim !== 1) {
                res.writeHead(200).end();
                decide(`duplicate:${event.id}`);
                return;
            }

            // 5. Ack FIRST, then work. The provider's clock stops here.
            res.writeHead(200).end();
            decide(`accepted:${event.id}`);
            void opts.onEvent(event).catch(() => {
                // A real system dead-letters here. Ack-then-drop is the trade this shape makes.
                decide(`failed:${event.id}`);
            });
        })();
    });

    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    return {
        url: `http://127.0.0.1:${port}`,
        server,
        close: () =>
            new Promise<void>((r) => {
                server.closeAllConnections();
                server.close(() => r());
            }),
    };
}

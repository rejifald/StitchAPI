// C1 — can `serve` receive a POST at an ARBITRARY path with the RAW body bytes preserved?
//
// This is measured against a REAL `serve()` process listening on 127.0.0.1, with real `fetch`
// requests carrying a real `Stripe-Signature` header over real signed bytes. Nothing here is
// simulated: the status codes below are what a Stripe delivery would actually receive.
//
// The capture's hypothesis is that `serve` is "the opposite of hand-me-the-raw-bytes-at-my-own-path"
// (serve.ts:206,283). Both halves of that are testable and both are measured. What the capture does
// NOT predict is the third finding, which is the decisive one: the signature HEADER never reaches
// user code either. `createServeHandler` builds the `StitchInput` from the BODY alone
// (serve.ts:246-256) and `req.headers` is read only for `content-length` (serve.ts:95) and `accept`
// (serve.ts:128). So even a user willing to re-derive the bytes has nothing to compare them to.
//
//   pnpm exec tsx docs/scenarios/proofs/webhook-receipt/c1-serve-raw-body.ts
import { stitch } from '../../../../packages/core/src/index';
import { serve } from '../../../../packages/core/src/serve';
import type {
    AdapterRequest,
    ResolvedStitchConfig,
    StitchInput,
} from '../../../../packages/core/src/types';
import { type BillingEvent, mintDelivery } from './fake-billing';
import { check, checkSeq, finish, heading, note } from './harness';
import { verifySignature } from './stripe-sig';

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

/** What the deepest user-reachable seam on the serve path was handed, per request. */
interface Seen {
    input: StitchInput;
    headers: Record<string, string>;
}

/**
 * A surface that captures the `StitchInput` the engine resolved and then answers 200 without any
 * transport. `buildRequest` is the seam that sees the input (surface.ts:52-56); `execute` replaces
 * the transport (surface.ts:118) so nothing leaves the process.
 */
function capturingSurface(seen: Seen[]) {
    return {
        // Kept as a literal type rather than widened to `Surface`: `stitch()`'s overloads narrow on
        // the surface id, and a widened `kind` makes it match the `download` arm.
        id: 'capture' as const,
        buildRequest: (
            _cfg: ResolvedStitchConfig,
            input: StitchInput,
            base: AdapterRequest,
        ): AdapterRequest => {
            seen.push({ input, headers: { ...base.headers } });
            return base;
        },
        execute: async () => ({
            status: 200,
            headers: {},
            body: { ack: true },
        }),
    };
}

async function main(): Promise<void> {
    heading(
        'C1 — raw bytes and arbitrary paths through a real `serve()` process',
    );

    // The provider's actual bytes. Real providers do NOT emit the key order or spacing your
    // `JSON.stringify` would: this one emits `{"id":…,"type":…}` with a space after each colon,
    // which is enough to change every byte of the MAC and nothing about the meaning.
    const delivery = mintDelivery(EVENT, SECRET, NOW_SECONDS, (e) =>
        JSON.stringify(e, null, 0).replace(/":/g, '": '),
    );
    note('provider bytes', delivery.raw.length + ' bytes');
    note('provider signature', delivery.signature.slice(0, 46) + '…');

    const seen: Seen[] = [];
    const registry = {
        'on-webhook': stitch({
            url: 'https://unused.test/never',
            method: 'POST',
            kind: capturingSurface(seen),
        }),
    };
    const handle = await serve(registry, { port: 0 });
    try {
        const post = async (path: string): Promise<number> => {
            const res = await fetch(handle.url + path, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'stripe-signature': delivery.signature,
                },
                body: Uint8Array.from(delivery.raw),
            });
            await res.arrayBuffer();
            return res.status;
        };

        // ── (a) the arbitrary-path half ───────────────────────────────────────────────────────
        // Every path a provider dashboard would let you type. The route table is two entries and
        // neither is yours (serve.ts:219-231).
        const paths = [
            '/webhooks/stripe',
            '/webhook',
            '/',
            '/stitch',
            '/hooks/v1/billing',
        ];
        const statuses: number[] = [];
        for (const p of paths) statuses.push(await post(p));
        checkSeq(
            '(a) POST status at ' + JSON.stringify(paths),
            statuses,
            [404, 404, 404, 404, 404],
        );
        check(
            '(a) any arbitrary path accepted a delivery',
            statuses.some((s) => s < 400),
            false,
        );
        note(
            '(a) → the route table is fixed',
            'GET / (list) and POST /stitch/:name (serve.ts:219-231). A webhook URL is neither',
        );

        // ── (b) the ONE route that reaches user code, with the same bytes ──────────────────────
        const okStatus = await post('/stitch/on-webhook');
        check('(b) POST /stitch/on-webhook → status', okStatus, 200);
        check('(b) requests that reached user code', seen.length, 1);

        // ── (c) what actually arrived: the PARSED object, and no raw form of it ────────────────
        const arrived = seen[0]?.input ?? {};
        const keys = Object.keys(arrived).sort();
        checkSeq('(c) StitchInput keys the engine resolved', keys, [
            'created',
            'data',
            'id',
            'signal',
            'type',
        ]);
        check(
            '(c) is any arrived value the raw string?',
            Object.values(arrived).some(
                (v) => typeof v === 'string' && v.includes('{'),
            ),
            false,
        );
        check(
            '(c) arrived body is a parsed object, deep-equal to JSON.parse(raw)',
            JSON.stringify((arrived as Record<string, unknown>)['data']) ===
                JSON.stringify(
                    (JSON.parse(delivery.raw.toString('utf8')) as BillingEvent)
                        .data,
                ),
            true,
        );
        note(
            '(c) → `parseInput` is `JSON.parse` (serve.ts:122-125)',
            'called on the string `readBody` decoded (serve.ts:248); the bytes are not retained anywhere',
        );

        // ── (d) the finding the capture does not predict: the SIGNATURE never arrives ──────────
        // `createServeHandler` composes the run input from the body alone (serve.ts:268-271).
        // `req.headers` is read for `content-length` and `accept` and for nothing else.
        const outboundHeaders = seen[0]?.headers ?? {};
        check(
            '(d) `stripe-signature` present anywhere in the resolved input',
            JSON.stringify(arrived).toLowerCase().includes('stripe-signature'),
            false,
        );
        check(
            '(d) `stripe-signature` present on the request user code sees',
            Object.keys(outboundHeaders).some(
                (h) => h.toLowerCase() === 'stripe-signature',
            ),
            false,
        );
        note(
            '(d) → there is nothing to verify AGAINST',
            'the inbound headers are dropped before user code; only the body becomes StitchInput',
        );

        // ── (e) the byte difference, demonstrated end to end ───────────────────────────────────
        // Given only the parsed object — which is all `serve` ever offers — the best a user can do
        // is re-serialise. This is the exact failure the capture describes, measured.
        const restringified = Buffer.from(JSON.stringify(arrived), 'utf8');
        const original = verifySignature(
            delivery.raw,
            delivery.signature,
            SECRET,
            NOW_SECONDS,
        );
        const rebuilt = verifySignature(
            restringified,
            delivery.signature,
            SECRET,
            NOW_SECONDS,
        );
        check('(e) verify against the RAW provider bytes', original.ok, true);
        check(
            '(e) verify against the re-stringified object',
            rebuilt.ok,
            false,
        );
        check(
            '(e) reason',
            rebuilt.ok ? '(none)' : rebuilt.reason,
            'bad-signature',
        );
        note(
            '(e) bytes signed vs bytes rebuilt from the input',
            `${delivery.raw.length} vs ${restringified.length} (the input also picked up the engine's \`signal\`)`,
        );

        // And the narrower version, with the `signal` key removed and nothing but whitespace
        // between the two — so the failure cannot be blamed on the engine adding a field.
        const parsedOnly = Buffer.from(
            JSON.stringify(JSON.parse(delivery.raw.toString('utf8'))),
            'utf8',
        );
        const whitespaceOnly = verifySignature(
            parsedOnly,
            delivery.signature,
            SECRET,
            NOW_SECONDS,
        );
        check(
            '(e) verify after a pure parse→stringify round-trip (whitespace only)',
            whitespaceOnly.ok,
            false,
        );
        check(
            '(e) the two payloads are logically identical',
            JSON.stringify(JSON.parse(parsedOnly.toString('utf8'))) ===
                JSON.stringify(JSON.parse(delivery.raw.toString('utf8'))),
            true,
        );
        check(
            '(e) bytes signed vs bytes after a pure round-trip',
            `${delivery.raw.length} vs ${parsedOnly.length}`,
            '162 vs 153',
        );
        note(
            '(e) → identical JSON, different bytes, dead signature',
            `${delivery.raw.length - parsedOnly.length} bytes of whitespace is the entire difference`,
        );

        // ── (f) the non-JSON provider ─────────────────────────────────────────────────────────
        // Slack signs an `application/x-www-form-urlencoded` body. `serve` rejects it at the door.
        const form = await fetch(handle.url + '/stitch/on-webhook', {
            method: 'POST',
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                'x-slack-signature': 'v0=deadbeef',
            },
            body: 'payload=%7B%22type%22%3A%22url_verification%22%7D',
        });
        const formBody = (await form.json()) as { error?: string };
        check('(f) form-encoded delivery → status', form.status, 400);
        check('(f) → error', formBody.error, 'invalid JSON body');
        note(
            '(f) → the body contract is JSON-only',
            'a form-encoded or protobuf provider cannot be received at all, signature or not',
        );
    } finally {
        await handle.close();
    }

    finish(
        'C1',
        'NO on both halves, and a third gap the capture missed. A real `serve()` process answered 404 to a signed Stripe-shaped POST at every one of /webhooks/stripe, /webhook, /, /stitch and /hooks/v1/billing — the route table is exactly `GET /` and `POST /stitch/:name` (serve.ts:219-231). On the one route that does reach user code the body has already been through `JSON.parse` (serve.ts:122-125,248): the deepest user-reachable seam (`Surface.buildRequest`) received a parsed object and no field carrying the raw string. THE THIRD GAP: the inbound headers are dropped entirely — `stripe-signature` appears nowhere in the resolved input, so there is nothing to verify against even if the bytes were recoverable. The byte difference is real and measured: the provider signed 162 bytes, a parse→stringify round-trip produces 153 logically identical bytes, and verification against them returns `bad-signature`. A form-encoded provider (Slack) is rejected 400 `invalid JSON body` before any of this',
    );
}

void main();

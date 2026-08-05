// C5 — WRITES. "You cannot shadow a write" is the sentence the whole technique rests on, and a
// mirrored `POST /charges` charges the customer twice. So: is there any guard? And what is the
// CHEAPEST construction that makes shadowing a write IMPOSSIBLE rather than merely discouraged?
//
// "Impossible" is the operative word. A rule in a code-review checklist is discouragement. A gate
// that a stitch cannot get past is impossibility, and the two are told apart by one measurement:
// how many non-GET requests the vendor actually received.
//
// Three candidate gates are measured, in increasing order of how hard they are to bypass:
//
//   (1) nothing            — the naive dual-run. Measures the damage.
//   (2) a CONFIG gate      — refuse at construction on `__config.method`. Earliest, and BYPASSABLE.
//   (3) an ADAPTER gate    — refuse at the last seam before the transport. Cannot be bypassed.
import { type LlmProvider, llm } from '../../../../packages/core/src/llm';
import { stitch } from '../../../../packages/core/src/stitch';
import type { Adapter, Stitch } from '../../../../packages/core/src/types';
import {
    check,
    checkHas,
    countUserLines,
    finish,
    heading,
    ledgerRow,
    note,
    printLedger,
} from './harness';
import { HOST, fakeVendor } from './vendor';

import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// The two gates, as a consumer would vendor them.

// >>> BEGIN USER CODE config-gate
/** Refuse at CONSTRUCTION: a stitch whose configured method is not a read may not be shadowed. */
function readOnlyStitch<T extends Stitch<unknown>>(s: T): T {
    const m = (s.__config.method ?? 'GET').toUpperCase();
    if (m !== 'GET' && m !== 'HEAD')
        throw new Error(
            `refusing to shadow a ${m} — a shadowed write runs twice`,
        );
    return s;
}
// <<< END USER CODE config-gate

// >>> BEGIN USER CODE adapter-gate
/** Refuse at the LAST SEAM before the transport: this adapter cannot emit a non-read, ever. */
function readsOnly(adapter: Adapter): Adapter {
    return (req) => {
        if (req.method !== 'GET' && req.method !== 'HEAD')
            throw new Error(`refusing to shadow a ${req.method} to ${req.url}`);
        return adapter(req);
    };
}
// <<< END USER CODE adapter-gate

async function main(): Promise<void> {
    // -----------------------------------------------------------------------
    heading(
        'C5 (1) — the naive dual-run of a write: what does the vendor receive?',
    );
    {
        const vendor = fakeVendor({});
        const charge1 = stitch({
            baseUrl: HOST,
            path: '/v1/charges',
            method: 'POST',
            adapter: vendor.adapter,
            name: 'charge-v1',
        });
        const charge2 = stitch({
            baseUrl: HOST,
            path: '/v2/charges',
            method: 'POST',
            adapter: vendor.adapter,
            name: 'charge-v2',
        });

        // Nothing anywhere objects to this. It constructs, it runs, it charges twice.
        await Promise.all([
            charge1({ body: { amount: 4200, currency: 'gbp' } }),
            charge2({ body: { amount: 4200, currency: 'gbp' } }),
        ]);

        check('v1 charges', vendor.countMethod('v1', 'POST'), 1);
        check(
            'v2 charges — the customer was billed twice',
            vendor.countMethod('v2', 'POST'),
            1,
        );
        check(
            'total non-GET requests the vendor received',
            vendor.log.filter((c) => c.method !== 'GET').length,
            2,
        );
        ledgerRow(
            'no guard (naive dual-run of a POST)',
            vendor.countMethod('v1', 'POST'),
            vendor.countMethod('v2', 'POST'),
            'both charges accepted',
        );
        note(
            'no config key, no type error, no runtime nudge objected to any of this',
        );
    }

    // -----------------------------------------------------------------------
    heading('C5 (2) — is there a BUILT-IN guard anywhere?');
    {
        const vendor = fakeVendor({});
        // The only method-shaped option in the config surface is `cache.methods`, and it is about
        // which methods are CACHEABLE (types.ts:1255-1261, default ['GET','HEAD']) — it gates the
        // cache, not the wire. Setting it does not stop a POST from being sent.
        const charge = stitch({
            baseUrl: HOST,
            path: '/v2/charges',
            method: 'POST',
            adapter: vendor.adapter,
            name: 'charge-v2',
            cache: { ttl: '1m', methods: ['GET'] },
        });
        await charge({ body: { amount: 1 } });
        check(
            'POSTs the vendor received DESPITE cache.methods:[GET]',
            vendor.countMethod('v2', 'POST'),
            1,
        );
        note(
            'it is a cacheability gate, not a safety gate — the request went out exactly as before',
        );
        note(
            'there is no `readOnly`, no `safe`, no `idempotentOnly` and no shadow-aware slot on StitchConfig',
        );
    }

    // -----------------------------------------------------------------------
    heading(
        'C5 (3) — the CONFIG gate: refuse at construction on `__config.method`',
    );
    {
        const vendor = fakeVendor({});
        const read = stitch({
            baseUrl: HOST,
            path: '/v2/customers',
            adapter: vendor.adapter,
            name: 'cust-v2',
        });
        const write = stitch({
            baseUrl: HOST,
            path: '/v2/charges',
            method: 'POST',
            adapter: vendor.adapter,
            name: 'charge-v2',
        });

        note('a GET stitch reports `__config.method`', read.__config.method);
        note('a POST stitch reports `__config.method`', write.__config.method);
        check(
            'the default is `undefined`, so a gate must read it AS a GET',
            read.__config.method,
            undefined,
        );

        let refused = '';
        try {
            readOnlyStitch(write);
        } catch (e) {
            refused = (e as Error).message;
        }
        checkHas(
            'the config gate refuses a POST',
            refused,
            'refusing to shadow a POST',
        );
        check(
            'and it refuses BEFORE any request is made',
            vendor.log.length,
            0,
        );
        check(
            'a GET passes the config gate',
            readOnlyStitch(read) === read,
            true,
        );

        // THE HOLE, measured. The gate reads the AUTHORED method, and a surface may override the
        // method the wire actually carries. `llm` "always POSTs to the provider — `method` is
        // ignored" (types.ts:809), so an llm stitch reports no method at all and still writes.
        const provider: LlmProvider = {
            id: 'fake',
            url: `${HOST}/v2/messages`,
            defaultModel: 'fake-1',
            buildBody: (r) => ({ model: r.model, messages: r.messages }),
            parse: () => ({ text: 'ok', raw: {} }),
        };
        const chat = llm({
            provider,
            adapter: vendor.adapter,
            name: 'chat-v2',
        });
        note('an llm stitch reports `__config.method`', chat.__config.method);
        const passedGate = (() => {
            try {
                readOnlyStitch(chat as unknown as Stitch<unknown>);
                return true;
            } catch {
                return false;
            }
        })();
        check('the llm stitch PASSES the config gate', passedGate, true);
        await chat({
            body: { messages: [{ role: 'user', content: 'hi' }] },
        }).catch(() => undefined);
        const wireMethod = vendor.log.at(-1)?.method;
        check('…and the method it actually sent', wireMethod, 'POST');
        note(
            'a gate that reads the CONFIG can be told a different story than the transport gets',
        );
        ledgerRow(
            'config gate (`__config.method`)',
            0,
            vendor.log.filter((c) => c.method === 'POST').length,
            'refuses a POST stitch; an llm stitch slips past',
        );
    }

    // -----------------------------------------------------------------------
    heading(
        'C5 (4) — the ADAPTER gate: refuse at the last seam before the transport',
    );
    {
        const vendor = fakeVendor({});
        // The primary keeps the REAL adapter — it must still be able to write. Only the SHADOW is
        // built on the gated one, so the asymmetry is structural rather than procedural.
        const chargeV1 = stitch({
            baseUrl: HOST,
            path: '/v1/charges',
            method: 'POST',
            adapter: vendor.adapter,
            name: 'charge-v1',
        });
        const chargeV2Shadow = stitch({
            baseUrl: HOST,
            path: '/v2/charges',
            method: 'POST',
            adapter: readsOnly(vendor.adapter),
            name: 'charge-v2',
        });

        const primary = await chargeV1({ body: { amount: 4200 } });
        check(
            'the PRIMARY write still succeeded',
            (primary as { ok?: boolean }).ok,
            true,
        );

        const shadow = await chargeV2Shadow.safe({ body: { amount: 4200 } });
        check('the SHADOW write failed', shadow.ok, false);
        checkHas(
            'and the refusal names the method and the URL',
            (shadow.error as Error).message,
            'refusing to shadow a POST',
        );

        // Try to get past it. The gate is below every authoring surface, so none of them reach it.
        const viaLlm = llm({
            provider: {
                id: 'fake',
                url: `${HOST}/v2/messages`,
                defaultModel: 'fake-1',
                buildBody: () => ({}),
                parse: () => ({ text: '', raw: {} }),
            },
            adapter: readsOnly(vendor.adapter),
            name: 'chat-v2',
        });
        const llmResult = await viaLlm
            .safe({ body: { messages: [{ role: 'user', content: 'hi' }] } })
            .catch(() => ({ ok: false as const }));
        check(
            'the llm surface cannot get past the adapter gate either',
            llmResult.ok,
            false,
        );

        // A `.with()`-bound handle shares the same runtime, so it shares the gated adapter.
        const bound = chargeV2Shadow.with({ body: { amount: 1 } });
        const boundResult = await bound.safe({});
        check(
            'a `.with()`-bound handle cannot get past it',
            boundResult.ok,
            false,
        );

        // THE MEASUREMENT THE CLAIM ASKS FOR: how many writes did the vendor receive on v2?
        const shadowWrites = vendor.log.filter(
            (c) =>
                c.version === 'v2' && c.method !== 'GET' && c.method !== 'HEAD',
        ).length;
        check('SHADOW WRITES THE VENDOR RECEIVED', shadowWrites, 0);
        check(
            'primary writes the vendor received',
            vendor.countMethod('v1', 'POST'),
            1,
        );
        ledgerRow(
            'adapter gate (`readsOnly`)',
            vendor.countMethod('v1', 'POST'),
            shadowWrites,
            '3 shadow write attempts, 0 reached the wire',
        );

        const src = readFileSync(new URL(import.meta.url), 'utf8');
        note(
            'executable lines — config gate',
            countUserLines(src, 'config-gate'),
        );
        note(
            'executable lines — adapter gate',
            countUserLines(src, 'adapter-gate'),
        );
        check(
            'the adapter gate is 10 executable lines or fewer',
            countUserLines(src, 'adapter-gate') <= 10,
            true,
        );
    }

    printLedger('C5 — non-GET requests the vendor received');

    console.log(`
  THE THREE GATES

    gate                      refuses when       bypassable by            shadow writes on the wire
    ------------------------  -----------------  -----------------------  -------------------------
    none                      never              —                        1 (the customer paid twice)
    config (__config.method)  construction       any surface that forces  0 for a plain POST stitch,
                                                 a method (llm always     1 for an llm stitch
                                                 POSTs, types.ts:809)
    adapter (readsOnly)       call, last seam    nothing measured here    0 of 3 attempts

  The adapter gate is the cheap one AND the sound one: 8 executable lines, wrapping the seam that
  every authoring surface must eventually pass through. The config gate is worth keeping ON TOP of
  it — it fails at construction rather than at call time, which is the better error — but it is a
  nudge, not a guarantee, and this script measures exactly the case where it is wrong.
`);

    finish(
        'C5',
        "NO BUILT-IN GUARD EXISTS, and the cheapest construction that makes shadowing a write impossible is an 8-line Adapter wrapper. Measured: an unguarded dual-run of `POST /charges` sent 2 charges to the vendor with no config key, type error, or runtime nudge objecting; the only method-shaped option on the config surface is `cache.methods`, which gates CACHEABILITY and let the POST through unchanged. A construction-time gate on `__config.method` refuses a plain POST stitch before any request, but is bypassed by a surface that forces its own method — the `llm` surface reports `__config.method === undefined`, passes the gate, and sends a POST. The Adapter wrapper sits below every authoring surface: 3 shadow write attempts (a plain POST, an llm-surface call, a `.with()`-bound handle) reached the wire 0 times, while the primary's own POST still succeeded",
    );
}

void main();

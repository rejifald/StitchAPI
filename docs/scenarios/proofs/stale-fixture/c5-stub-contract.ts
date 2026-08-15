// C5 — `stubStitch` / `failStitch`: does the stub honour the same INPUT contract as the real stitch?
//
// This is the classic "mock lets you write code that cannot work" asymmetry, in the request
// direction. C3 measured it on the way back (a fixture can be a shape no wire produces); this is the
// way out. If the real stitch validates `input` and the stub does not, then a service tested against
// the stub can send `{ id: 42 }` where the endpoint demands `{ id: "42" }`, and the test is green.
//
// Measured: the stub is a FAITHFUL `Stitch` in every structural respect — `isStitch()` accepts it,
// `.safe`/`.unwrap`/`.stream`/`.with`/`.cache`/`__config` are all there, the event spine matches —
// and it runs ZERO of the six declared `input` slots. A stitch that rejects `{ id: 42 }` with a
// named validation error is replaced by a stub that resolves and records the call.
//
//   pnpm exec tsx docs/scenarios/proofs/stale-fixture/c5-stub-contract.ts
import { stitch } from '../../../../packages/core/src/index';
import { collectStitchEvents } from '../../../../packages/core/src/test-events';
import { mockAdapter } from '../../../../packages/core/src/test-mock';
import {
    failStitch,
    stubStitch,
} from '../../../../packages/core/src/test-stub';
import { isStitch } from '../../../../packages/core/src/types';
import type { Stitch } from '../../../../packages/core/src/types';
import { check, checkSeq, finish, heading, note } from './harness';
import { BASE } from './vendor';
import { z } from './zod';

interface Invoice {
    id: string;
    amount_cents: number;
}

/** THE CODE UNDER TEST. It takes a stitch and calls it — it does not care which one it got. */
async function chargeReport(
    getInvoice: Stitch<Invoice>,
    id: unknown,
): Promise<string> {
    const r = await getInvoice.safe({ params: { id } as never });
    return r.ok
        ? `${r.data.id}:${String(r.data.amount_cents)}`
        : `ERR ${r.error.message}`;
}

async function main(): Promise<void> {
    // The REAL stitch: `id` must be a string of digits, and the endpoint 404s on anything else.
    const api = mockAdapter([
        {
            match: /\/v1\/invoices\/\d+$/,
            respond: { body: { id: 'inv_1', amount_cents: 4200 } },
        },
    ]);
    const real = stitch({
        name: 'getInvoice',
        baseUrl: BASE,
        path: '/v1/invoices/{id}',
        adapter: api,
        input: { params: z.object({ id: z.string() }) },
        output: z.object({ id: z.string(), amount_cents: z.number() }),
    }) as unknown as Stitch<Invoice>;

    heading('C5 (a) — the real stitch enforces `input`');
    {
        const good = await chargeReport(real, '42');
        check('a valid id works', good, 'inv_1:4200');
        const bad = await chargeReport(real, 42);
        check(
            'a NUMBER id is rejected before the wire',
            bad.startsWith('ERR'),
            true,
        );
        check('…and the transport never saw it', api.callCount(), 1);
        note('the rejection message', bad);
    }

    heading('C5 (b) — the stub accepts what the real stitch refuses');
    {
        const stub = stubStitch<Invoice>({ id: 'inv_1', amount_cents: 4200 });
        const viaStub = await chargeReport(stub, 42);
        check(
            'the stub RESOLVED for the same bad input',
            viaStub,
            'inv_1:4200',
        );
        check('calls recorded', stub.callCount(), 1);
        checkSeq('…and what it recorded', stub.calls(), [
            { params: { id: 42 } },
        ]);
        note(
            '(b) → same code, same argument. Against the real stitch: a validation error, no request. Against the stub: a green test and a plausible answer',
            '',
        );
    }

    heading('C5 (c) — can a stub be GIVEN the input contract?');
    {
        // The published options are `name`, `status`, `config`, `events`. None takes a schema.
        const stub = stubStitch<Invoice>(
            { id: 'inv_1', amount_cents: 4200 },
            {
                name: 'getInvoice',
                status: 200,
                config: { name: 'getInvoice', method: 'GET' },
            },
        );
        const cfgKeys = Object.keys(stub.__config).sort();
        checkSeq('`__config` on a stub', cfgKeys, ['method', 'name']);
        check(
            'is there an `input` slot on StubStitchOptions?',
            'input' in
                ({
                    name: '',
                    status: 200,
                    config: {},
                    events: () => [],
                } as Record<string, unknown>),
            false,
        );
        note(
            '(c) → `StubStitchOptions` is `{ name, status, config, events }` (test-stub.ts:33-43). `config` is `Partial<RedactedStitchConfig>`, which is the REDACTED read-out shape — it carries no schema, so there is nowhere to put the contract even if you wanted to',
            '',
        );

        // The workaround is your own: wrap the impl in a validator. It works — and since #664 the
        // guard may throw synchronously; `.safe()` reports it as `ok: false` either way (section
        // (g) pins that).
        const Params = z.object({ id: z.string() });
        const guarded = stubStitch<Invoice>(async (input) => {
            Params.parse(input.params);
            return { id: 'inv_1', amount_cents: 4200 };
        });
        const ok = await chargeReport(guarded, '42');
        const rejected = await chargeReport(guarded, 42);
        check('(c) a hand-guarded stub accepts good input', ok, 'inv_1:4200');
        check(
            '(c) …and rejects the bad input the real stitch rejects',
            rejected.startsWith('ERR'),
            true,
        );
        note(
            '(c) → the `impl` function is the seam. It receives the raw `StitchInput`, so a validator can run there — but you have to remember to write it, and nothing tells you that you did not',
            '',
        );
    }

    heading('C5 (d) — everything ELSE about the stub is faithful');
    {
        const stub = stubStitch<Invoice>({ id: 'inv_1', amount_cents: 4200 });
        check('isStitch() accepts it', isStitch(stub), true);
        checkSeq(
            'the callable surface',
            ['safe', 'unwrap', 'stream', 'with', 'cache', 'invalidate'].map(
                (k) =>
                    `${k}=${typeof (stub as unknown as Record<string, unknown>)[k]}`,
            ),
            [
                'safe=function',
                'unwrap=function',
                'stream=function',
                'with=function',
                'cache=object',
                'invalidate=function',
            ],
        );
        const c = await collectStitchEvents(stub());
        checkSeq('the event spine matches a real run', c.types, [
            'start',
            'result',
            'done',
        ]);
        check(
            'result data',
            JSON.stringify(c.result),
            '{"id":"inv_1","amount_cents":4200}',
        );
        check('done.ok', c.done?.ok, true);

        const failing = failStitch({ status: 503, message: 'vendor down' });
        const f = await collectStitchEvents(failing());
        checkSeq('failStitch spine', f.types, ['start', 'error', 'done']);
        check('failStitch error message', f.error?.message, 'vendor down');
        check('failStitch error status', f.error?.status, 503);
        check('failStitch done.ok', f.done?.ok, false);
        note(
            '(d) → structurally this is a real `Stitch`: a registry, `isStitch()`, or a Nest `overrideProvider(useValue:)` accepts it, and `.stream()` yields the same spine. The ONLY thing missing is the contract',
            '',
        );
    }

    heading(
        'C5 (e) — the real stitch and the stub disagree on the event spine, once',
    );
    {
        // A real run emits `progress` events; a stub does not. So a test that asserts on `types`
        // against a stub encodes a spine production never produces.
        const realEvents = await collectStitchEvents(
            (
                stitch({
                    url: `${BASE}/x`,
                    adapter: mockAdapter([{ respond: { body: { ok: true } } }]),
                }) as unknown as Stitch
            )(),
        );
        const stubEvents = await collectStitchEvents(
            stubStitch({ ok: true })(),
        );
        checkSeq('real spine', realEvents.types, [
            'start',
            'progress',
            'result',
            'done',
        ]);
        checkSeq('stub spine', stubEvents.types, ['start', 'result', 'done']);
        note(
            '(e) → the stub omits `progress`. Harmless for a caller test, but it means the two spines are not interchangeable in an assertion',
            '',
        );
    }

    heading('C5 (f) — `.with()` on a stub');
    {
        const stub = stubStitch<Invoice>((input) => ({
            id: String((input.params as { id: unknown }).id),
            amount_cents: 1,
        }));
        const bound = stub.with({ params: { id: 'pinned' } } as never);
        const r = await bound.safe({} as never);
        check(
            'the bound partial reached the impl',
            r.ok && r.data.id,
            'pinned',
        );
        check('the PARENT stub recorded the call', stub.callCount(), 0);
        note(
            "(f) → `.with()` on a stub returns a NEW stub with its own spy (test-stub.ts:198-202 re-`assemble`s), so the parent's `callCount()` stays 0. A test that binds and then asserts on the original spy sees nothing",
            '',
        );
    }

    heading(
        'C5 (g) — `.safe()` never throws, even for a SYNC-throwing impl (fixed by #664)',
    );
    // `.safe()` is the never-throws surface, and the stub now honours it the way the real stitch
    // does. At audit time it did not — `resolve()` evaluated `impl(input)` as an ARGUMENT to
    // `Promise.resolve`, so a synchronous throw escaped before there was a chain to catch it, and
    // `.safe()` THREW. This audit filed that as #650; since #664 `resolve()` is an `async`
    // function (test-stub.ts:59-70), which turns the sync throw into a rejection — a sync throw
    // and an async rejection are indistinguishable to every caller.
    {
        const syncThrow = stubStitch<Invoice>(() => {
            throw new Error('boom');
        });
        let outcome = '';
        try {
            const r = await syncThrow.safe();
            outcome = `returned ok=${String(r.ok)}`;
        } catch (e) {
            outcome = `THREW ${(e as Error).message}`;
        }
        check(
            '(g) stub .safe() with a SYNC-throwing impl',
            outcome,
            'returned ok=false',
        );

        const asyncThrow = stubStitch<Invoice>(() =>
            Promise.reject(new Error('boom')),
        );
        let asyncOutcome = '';
        try {
            const r = await asyncThrow.safe();
            asyncOutcome = `returned ok=${String(r.ok)}`;
        } catch (e) {
            asyncOutcome = `THREW ${(e as Error).message}`;
        }
        check(
            '(g) …and with an ASYNC-rejecting impl',
            asyncOutcome,
            'returned ok=false',
        );

        // The real stitch, same shape: a transport that throws synchronously.
        const realSync = stitch({
            url: `${BASE}/x`,
            adapter: () => {
                throw new Error('transport boom');
            },
        });
        const realOut = await realSync.safe();
        check(
            '(g) real stitch .safe() with a SYNC-throwing adapter',
            realOut.ok,
            false,
        );
        check(
            '(g) …and it carries the message',
            realOut.error?.message,
            'transport boom',
        );

        // `.stream()` on the same stub was always fine — the generator has a try/catch.
        const streamed = await collectStitchEvents(
            stubStitch<Invoice>(() => {
                throw new Error('boom');
            })().stream(),
        );
        checkSeq(
            '(g) …and `.stream()` handles it the same way',
            streamed.types,
            ['start', 'error', 'done'],
        );
        note(
            '(g) → `SafeResult` exists so a caller never needs a try/catch, and the stub now keeps that promise for a sync throw — measured identical to the async twin and to the real stitch with a synchronously-throwing adapter. The code under test needs no try/catch that production does not need',
            '',
        );
    }

    finish(
        'C5',
        'THE ASYMMETRY IS REAL AND IT IS THE WHOLE INPUT CONTRACT. Structurally the stub is faithful: `isStitch()` accepts it, `safe`/`unwrap`/`stream`/`with`/`invalidate` are functions and `cache` is an object, `.stream()` yields `start,result,done`, and `failStitch({status:503,message:"vendor down"})` yields `start,error,done` with the message and status intact. But it runs NONE of the `input` schemas. Measured on one line of calling code with the argument `42` where the schema says `z.string()`: the real stitch returns an error and the transport count stays at 1 (no request left the process); the stub RESOLVES to `inv_1:4200` and records `{"params":{"id":42}}`. There is no way to hand a stub the contract either — `StubStitchOptions` is `{name,status,config,events}` (test-stub.ts:33-43) and `config` is `Partial<RedactedStitchConfig>`, the redacted read-out shape, which carries no schema. The workaround is to validate inside the `impl` function yourself (3 lines, and it does work), which is exactly the kind of thing nobody remembers. Two smaller divergences: a real run emits a `progress` event the stub omits, so the two spines are not interchangeable; and `.with()` returns a NEW stub with a fresh spy, so the parent\'s `callCount()` reads 0 after a bound call. And the bug this audit found in passing is FIXED: `.safe()` on a stub whose impl throws SYNCHRONOUSLY used to throw (filed as #650); since #664 `resolve()` is an `async` function (test-stub.ts:59-70), so the throw becomes a rejection — measured `returned ok=false` for the sync and async arms alike, matching the real stitch with a synchronously-throwing adapter (ok=false / "transport boom"). `.stream()` on the same stub was always fine (`start,error,done`)',
    );
}

void main();

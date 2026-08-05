// C3 — what does `mockAdapter` actually CHECK about a fixture?
//
// The question matters because a mock that accepts a response no transport could produce lets you
// write code against a shape that cannot exist. The library HAS a published notion of what a
// well-formed transport does — `verifyAdapterContract` + `adapterContractFixture` — so the sharp
// version of the question is: does `mockAdapter` hold itself to the contract it publishes for
// everybody else?
//
// Measured: it normalises the two fields it owns (`status` defaults to 200, header names are
// lowercased) and performs ZERO validation of anything else. It will serve a `Date`, a `Map`, a
// class instance, `undefined`, and a status of `999` or `-1` — none of which survives a JSON
// transport. The gap is `body`, and it is not a small one, because `body` is the entire fixture.
//
//   pnpm exec tsx docs/scenarios/proofs/stale-fixture/c3-mock-fidelity.ts
import { stitch } from '../../../../packages/core/src/index';
import { mockAdapter } from '../../../../packages/core/src/test-mock';
import {
    adapterContractFixture,
    verifyAdapterContract,
} from '../../../../packages/core/src/testing';
import type {
    Adapter,
    AdapterRequest,
    AdapterResponse,
} from '../../../../packages/core/src/types';
import { check, checkSeq, finish, heading, note } from './harness';
import { BASE } from './vendor';

/** Call a mock adapter directly and report the raw `AdapterResponse` it produced. */
async function raw(
    adapter: Adapter,
    req: Partial<AdapterRequest> = {},
): Promise<AdapterResponse> {
    return adapter({
        url: `${BASE}/x`,
        method: 'GET',
        headers: {},
        ...req,
    });
}

/** `typeof`, but distinguishing the shapes JSON can and cannot carry. */
function shapeOf(v: unknown): string {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    if (Array.isArray(v)) return 'array';
    if (v instanceof Date) return 'Date';
    if (v instanceof Map) return 'Map';
    if (typeof v === 'object') return (v.constructor as { name: string }).name;
    return typeof v;
}

class Invoice {
    constructor(public id: string) {}
    get total(): number {
        return 42;
    }
}

async function main(): Promise<void> {
    heading('C3 (a) — the two fields `mockAdapter` DOES normalise');
    {
        const a = mockAdapter([{ respond: { body: { ok: true } } }]);
        const res = await raw(a);
        check('status defaults to 200', res.status, 200);
        checkSeq('headers default to {}', Object.keys(res.headers), []);

        const b = mockAdapter([
            {
                respond: {
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Trace': 'abc',
                    },
                    body: {},
                },
            },
        ]);
        const resB = await raw(b);
        checkSeq(
            'header NAMES are lowercased, matching a real adapter',
            Object.keys(resB.headers).sort(),
            ['content-type', 'x-trace'],
        );
        note(
            '(a) → test-mock.ts:149-161 `build()`. That is the whole of its response hygiene',
            '',
        );
    }

    heading('C3 (b) — statuses no HTTP transport can produce');
    {
        const rows: string[] = [];
        for (const status of [999, -1, 0, 1.5, 200.7]) {
            const a = mockAdapter([{ respond: { status, body: {} } }]);
            const res = await raw(a);
            rows.push(`${String(status)} -> ${String(res.status)}`);
        }
        checkSeq('status passthrough', rows, [
            '999 -> 999',
            '-1 -> -1',
            '0 -> 0',
            '1.5 -> 1.5',
            '200.7 -> 200.7',
        ]);
        note(
            '(b) → `adapterContractFixture` only ever emits 100..599 integers (testing.ts:613-617), and `verifyAdapterContract` probes 200/404/500. `mockAdapter` is bound by neither',
            '',
        );
    }

    heading('C3 (c) — bodies no JSON transport can produce');
    {
        const bodies: [string, unknown][] = [
            ['Date', new Date(0)],
            ['Map', new Map([['a', 1]])],
            ['class instance', new Invoice('inv_1')],
            ['undefined', undefined],
            ['function', () => 1],
            ['bigint', 10n],
            ['Symbol-keyed', { [Symbol('s')]: 1 }],
        ];
        const rows: string[] = [];
        for (const [label, body] of bodies) {
            const a = mockAdapter([{ respond: { body } as never }]);
            const res = await raw(a);
            rows.push(`${label} -> ${shapeOf(res.body)}`);
        }
        checkSeq('what came back out', rows, [
            'Date -> Date',
            'Map -> Map',
            'class instance -> Invoice',
            'undefined -> undefined',
            'function -> function',
            'bigint -> bigint',
            'Symbol-keyed -> Object',
        ]);
        note(
            '(c) → every one is served verbatim. A real adapter hands the engine `JSON.parse` output or a string, so `Date`/`Map`/`Invoice`/`function`/`bigint` are shapes production can never deliver',
            '',
        );
    }

    heading('C3 (d) — and the engine believes them');
    // The consequence: a fixture with methods lets you write `data.total` in a test that passes and
    // in production throws, because the wire only ever carried `{"id":"inv_1"}`.
    {
        const a = mockAdapter([
            { respond: { body: new Invoice('inv_1') } as never },
        ]);
        const call = stitch({ url: `${BASE}/inv`, adapter: a });
        const r = await call.safe();
        check('the call succeeded', r.ok, true);
        check(
            'the caller received a live class instance',
            r.data instanceof Invoice,
            true,
        );
        check(
            '…with a GETTER that exists only in the test',
            (r.data as Invoice).total,
            42,
        );
        check(
            'what the same object looks like over a JSON wire',
            JSON.stringify(JSON.parse(JSON.stringify(new Invoice('inv_1')))),
            '{"id":"inv_1"}',
        );
        note(
            '(d) → `data.total` is 42 under the mock and `undefined` in production. That is the "mock lets you write code that cannot work" shape, in the response direction',
            '',
        );
    }

    heading(
        'C3 (e) — the contract the library DOES publish, run against the mock',
    );
    // `verifyAdapterContract` is the library's own definition of a well-formed transport. Point it
    // at a `mockAdapter` wired to serve `adapterContractFixture` and see whether the mock passes.
    {
        const fixtureAdapter = mockAdapter([
            {
                respond: (call) => {
                    const u = new URL(call.req.url);
                    const out = adapterContractFixture({
                        method: call.req.method,
                        path: u.pathname + u.search,
                        headers: call.req.headers,
                        ...(call.req.body === undefined
                            ? {}
                            : { body: JSON.stringify(call.req.body) }),
                    });
                    const parsed: unknown = out.headers[
                        'content-type'
                    ]?.includes('json')
                        ? JSON.parse(out.body)
                        : out.body;
                    return {
                        status: out.status,
                        headers: out.headers,
                        body: parsed,
                        ...(out.delay === undefined
                            ? {}
                            : { delay: out.delay }),
                    };
                },
            },
        ]);
        const report = await verifyAdapterContract(fixtureAdapter, BASE);
        check('seam verified', report.seam, 'adapter');
        note('rules passed', report.passed.length);
        note('rules violated', report.violations.length);
        for (const v of report.violations)
            note(`violation: ${v.rule}`, v.detail);
        checkSeq('the rules a `mockAdapter` CAN satisfy', report.passed, [
            'status: 200 resolves with status 200',
            'status: 404 resolves without throwing',
            'status: 500 resolves without throwing',
            'request: method, headers, and body are delivered',
            'response: headers are readable with lowercase names',
            'response: text body round-trips',
            'response: JSON body round-trips as parsed data',
            'abort: an in-flight abort rejects promptly',
        ]);
        checkSeq(
            'the rule it CANNOT',
            report.violations.map((v) => v.rule),
            ['abort: a pre-aborted signal rejects'],
        );
        checkSeq(
            '…and the detail',
            report.violations.map((v) => v.detail),
            ['adapter resolved although the signal was already aborted'],
        );
        note(
            '(e) → 8 of 9 rules pass, and the ONE failure is a genuine fidelity bug, not an artifact of this harness: `mockAdapter` consults `req.signal` only inside its `delay` branch (test-mock.ts:188-189), so a route with no `delay` RESOLVES for a request whose signal was already aborted. Every real transport rejects. But read what the 9 rules cover — statuses, header case, body round-tripping, abort. NONE constrains what a fixture MAY contain; they constrain what a TRANSPORT must do with it. The contract kit is for adapter authors, exactly as the capture predicted',
            '',
        );
    }

    heading('C3 (f) — the one shape `mockAdapter` DOES reject at compile time');
    {
        // `respond: {}` is a type error (`AtLeastOne<MockResponse>`, CONTRACT.md P20). It is the
        // only fixture shape the mock refuses, and it is refused by the type system, not at runtime.
        // @ts-expect-error — the opaque `respond: {}` is rejected by AtLeastOne<MockResponse>
        const _rejected = mockAdapter([{ respond: {} }]);
        void _rejected;
        check(
            'an empty `respond` is a compile error (see the @ts-expect-error above)',
            true,
            true,
        );

        // At RUNTIME, however, nothing stops the same thing arriving through a responder function.
        const viaFn = mockAdapter([{ respond: () => ({}) }]);
        const res = await raw(viaFn);
        check('…but a responder FUNCTION may return `{}`', res.status, 200);
        check('…and the body is `undefined`', res.body, undefined);
        note(
            '(f) → the guard is a type, so it is defeated by the one form the type deliberately relaxes. A JSON transport cannot deliver `undefined`',
            '',
        );
    }

    heading('C3 (g) — unmatched requests');
    {
        const strict = mockAdapter([
            { match: '/known', respond: { body: {} } },
        ]);
        let msg = '';
        try {
            await raw(strict, { url: `${BASE}/unknown` });
        } catch (e) {
            msg = (e as Error).message;
        }
        check(
            'the default is a loud throw',
            msg,
            `mockAdapter: no route matched GET ${BASE}/unknown`,
        );
        const lax = mockAdapter([{ match: '/known', respond: { body: {} } }], {
            onUnmatched: 404,
        });
        const res = await raw(lax, { url: `${BASE}/unknown` });
        check('`onUnmatched` replies with a bare status', res.status, 404);
        check('…and a body of `{}`', JSON.stringify(res.body), '{}');
        note(
            '(g) → this is the one place the mock is stricter than a real vendor by default, and it is the right default: an unexpected request fails the test instead of being silently absorbed',
            '',
        );
    }

    finish(
        'C3',
        'IT VALIDATES ALMOST NOTHING, AND THE GAP IS EXACTLY THE FIXTURE. `mockAdapter` normalises two fields — `status` defaults to 200 and header names are lowercased (test-mock.ts:149-161) — and checks nothing else. Measured: it served statuses 999, -1, 0, 1.5 and 200.7 verbatim, and served a `Date`, a `Map`, a class instance, `undefined`, a `function`, a `bigint` and a Symbol-keyed object as response bodies, all of which reached the caller unchanged through the full engine. The consequence is a working test for code that cannot work: a fixture built from `new Invoice(...)` gives the caller `data.total === 42` from a GETTER, where the same object over a JSON wire is `{"id":"inv_1"}` and `data.total` is undefined. The library does publish a transport contract, and running it against `mockAdapter` turns up a SECOND finding the claim did not ask for: the mock passes 8 of 9 rules and VIOLATES `abort: a pre-aborted signal rejects` — "adapter resolved although the signal was already aborted" — because it consults `req.signal` only inside its `delay` branch (test-mock.ts:188-189), so any route without a `delay` ignores an aborted signal that every real transport honours. And every one of the 9 rules constrains what a TRANSPORT must do with a response, not what a FIXTURE may contain, so passing them says nothing about fixture realism. The single fixture shape that is rejected, `respond: {}`, is rejected by the TYPE (`AtLeastOne<MockResponse>`) and is reachable at runtime anyway through a responder function, which returns `status: 200, body: undefined`',
    );
}

void main();

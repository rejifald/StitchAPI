// stitchapi/pipe — ancestor access via the typed `pipe.with()` builder. A builder step's mapper takes
// a second `ctx` argument: a frozen view of `$input` (the pipe's initial input) plus every earlier
// NAMED step, so a step can read an ANCESTOR — typed, no cast — not just the previous result. The
// simple variadic `pipe(...)` stays previous-only; ancestors live on the builder.
import { stitch } from '../src';
import { pipe } from '../src/pipe';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

let server: MockServer;
beforeAll(async () => {
    server = await startMockServer();
});
afterAll(async () => {
    await server.close();
});
beforeEach(() => {
    server.reset();
});

test('pipe.with(): a later step reads a typed ANCESTOR, not just the previous result', async () => {
    server.route('GET', '/order', {
        body: { id: 1043, shipmentId: 'shp_9', region: 'EU' },
    });
    server.route('GET', '/shipment', {
        body: { carrier: 'dhl', trackingCode: 'Z1' },
    });
    server.route('GET', '/tracking', { body: { events: ['picked-up'] } });
    const order = stitch<{ id: number; shipmentId: string; region: string }>({
        name: 'order',
        baseUrl: server.url,
        path: '/order',
    });
    const shipment = stitch<{ carrier: string; trackingCode: string }>({
        name: 'shipment',
        baseUrl: server.url,
        path: '/shipment',
    });
    const tracking = stitch<{ events: string[] }>({
        name: 'tracking',
        baseUrl: server.url,
        path: '/tracking',
    });

    const tracked = pipe
        .step(order, 'order')
        .step(shipment, (o) => ({ query: { id: o.shipmentId } })) // o typed → no cast
        .step(tracking, (s, ctx) => ({
            query: {
                carrier: s.carrier, // previous step
                code: s.trackingCode,
                region: ctx.order.region, // ancestor, two hops back (typed)
            },
        }));

    // the builder is itself the callable — no .build()
    await expect(tracked({ params: {} })).resolves.toEqual({
        events: ['picked-up'],
    });
    const t = server.calls('/tracking')[0]!;
    expect(t.query['carrier']).toBe('dhl'); // from the previous (shipment) result
    expect(t.query['region']).toBe('EU'); // from the order, an ancestor two steps back
});

test('pipe.with(): ctx exposes $input + named ancestors only, is frozen, and unnamed steps are not addressable', async () => {
    server.route('GET', '/a', { body: { tag: 'A' } });
    server.route('GET', '/b', { body: { tag: 'B' } });
    server.route('GET', '/c', { body: { tag: 'C' } });
    const a = stitch({ name: 'a', baseUrl: server.url, path: '/a' });
    const b = stitch({ name: 'b', baseUrl: server.url, path: '/b' });
    const c = stitch({ name: 'c', baseUrl: server.url, path: '/c' });

    let captured: Record<string, unknown> | undefined;
    const flow = pipe
        .step(a, 'first')
        .step(b) // anonymous — contributes no ctx key
        .step(c, (_prev, ctx) => {
            captured = ctx;
            return {};
        });

    await flow({ params: { id: 1 } });

    expect(captured!['$input']).toEqual({ params: { id: 1 } });
    expect(captured!['first']).toEqual({ tag: 'A' }); // named ancestor, reachable past the anonymous step
    expect(Object.keys(captured!).sort()).toEqual(['$input', 'first']); // b (anonymous) absent
    expect(Object.isFrozen(captured)).toBe(true);
});

test('engine rejects reserved $-names and duplicate names (runtime backstop)', () => {
    const s = stitch({ name: 's', baseUrl: server.url, path: '/s' });
    // The builder blocks these at COMPILE time for literal names; DYNAMIC (non-literal) names slip
    // past the type guard, so the engine's `assertNames` (run when the built pipeline is invoked) is
    // the runtime backstop. A `$`-prefixed name:
    const reserved = '$bad' as string;
    expect(() => pipe.step(s, reserved)()).toThrow(/reserved/);
    // ...and a duplicate (a literal name, then a bag with the same dynamic key):
    const dupKey = 'dup' as string;
    expect(() => pipe.step(s, 'dup').step({ [dupKey]: s })()).toThrow(
        /duplicate/,
    );
});

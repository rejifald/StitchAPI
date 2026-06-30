// Type-level contract for the typed `pipe.with()` builder: typed `prev` AND a typed `ctx` of named
// ancestors (no casts), with unique names enforced at COMPILE time. The simple variadic `pipe(...)`
// stays one-arg, previous-only. See packages/core/src/pipe.ts.
import { stitch } from '..';
import type { StitchInput } from '..';
import { pipe } from '../src/pipe';

import { expectError, expectType } from 'tsd';

interface Order {
    id: number;
    shipmentId: string;
    region: string;
}
interface Shipment {
    carrier: string;
    trackingCode: string;
}
interface Tracking {
    events: string[];
}

const fetchOrder = stitch<Order>({ baseUrl: 'x', path: '/o' });
const fetchShipment = stitch<Shipment>({ baseUrl: 'x', path: '/s' });
const fetchTracking = stitch<Tracking>({ baseUrl: 'x', path: '/t' });

// ---- builder: typed prev + typed ctx ancestors, no casts; the builder is itself the callable ----
const tracked = pipe
    .step(fetchOrder, 'order') // name via the optional positional arg on `step`
    .step(fetchShipment, (order, ctx) => {
        expectType<Order>(order); // prev typed as the order output
        expectType<StitchInput | undefined>(ctx.$input); // initial input reachable
        return { params: { id: order.shipmentId } };
    })
    .step(fetchTracking, (shipment, ctx) => {
        expectType<Shipment>(shipment); // prev now the shipment output
        expectType<string>(ctx.order.region); // ancestor typed, two hops back
        return {};
    });

// no .build() — call the builder directly; it resolves to the LAST step's output type
expectType<Promise<Tracking>>(tracked({ params: { id: 1 } }));

// ---- ctx is REAL typing, not `any` ----
expectError(
    pipe.step(fetchOrder, 'order').step(fetchShipment, (_o, ctx) => ({
        params: { x: String(ctx.order.bogus) }, // unknown property on a typed ancestor
    })),
);
expectError(
    pipe.step(fetchOrder, 'order').step(fetchShipment, (_o, ctx) => ({
        params: { x: String(ctx.invoice) }, // undeclared name
    })),
);

// ---- unique names are a COMPILE-time guarantee ----
expectError(
    // duplicate name
    pipe.step(fetchOrder, 'order').step(fetchShipment, 'order'),
);
expectError(
    // reserved `$input`
    pipe.step(fetchOrder, '$input'),
);
expectError(
    // reserved `$`-prefix
    pipe.step(fetchOrder, '$weird'),
);

// ---- variadic pipe(): simple, one-arg, no name / no ctx ----
expectType<Promise<unknown>>(
    pipe(fetchOrder, {
        stitch: fetchShipment,
        input: (prev) => ({
            params: { id: String((prev as Order).shipmentId) },
        }),
    })(),
);
// Note: the variadic surface is deliberately LOOSE — TS relaxes excess-property and function-arity
// checks when the parameter is a union (`PipeStep | Stitch`), so a stray `name` or a 2-arg mapper
// isn't a type error there. The typed/strict contract lives entirely on the `pipe.with()` builder
// (asserted above). The variadic mapper's documented shape is one-arg, `prev: unknown`.

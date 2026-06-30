// Type-level contract for the parallel combinators and how they compose with the pipe builder:
// `all` → a typed named object, `any`/`race` → the members' output, an inline `{ k: node }` bag
// merges into `ctx`, and a standalone combinator nests as a single (named) node. See src/pipe.ts.
import { stitch } from '..';
import { all, any, pipe, race } from '../src/pipe';

import { expectError, expectType } from 'tsd';

interface Order {
    id: number;
    shipmentId: string;
    region: string;
}
interface Shipment {
    carrier: string;
}
interface Invoice {
    total: number;
}

const fetchOrder = stitch<Order>({ baseUrl: 'x', path: '/o' });
const fetchShipment = stitch<Shipment>({ baseUrl: 'x', path: '/s' });
const fetchInvoice = stitch<Invoice>({ baseUrl: 'x', path: '/i' });
const fetchOrderMirror = stitch<Order>({ baseUrl: 'x', path: '/om' });

// all (object form) → a typed named object
expectType<Promise<{ shipment: Shipment; invoice: Invoice }>>(
    all({ shipment: fetchShipment, invoice: fetchInvoice })(),
);

// all (array form) → a typed positional tuple (readonly)
expectType<Promise<readonly [Shipment, Invoice]>>(
    all([fetchShipment, fetchInvoice])(),
);

// any / race → the members' (common) output
expectType<Promise<Order>>(any([fetchOrder, fetchOrderMirror])());
expectType<Promise<Order>>(race([fetchOrder, fetchOrderMirror])());

// inline bag in a pipe: merges keys into ctx, prev = the bag
const flow = pipe
    .step(fetchOrder, 'order')
    .step({ shipment: fetchShipment, invoice: fetchInvoice })
    .step(fetchOrder, (prev, ctx) => {
        expectType<Shipment>(prev.shipment); // prev = the bag
        expectType<Invoice>(prev.invoice);
        expectType<Shipment>(ctx.shipment); // bag key merged into ctx
        expectType<string>(ctx.order.region); // earlier ancestor, still typed
        return {};
    });
expectType<Promise<Order>>(flow({}));

// a standalone combinator nests as a single named node (failover on the first call)
const failover = pipe
    .step(any([fetchOrder, fetchOrderMirror]), 'order')
    .step(fetchShipment, (order) => ({ params: { id: order.shipmentId } }));
expectType<Promise<Shipment>>(failover({}));

// duplicate name across a single step and a later bag key → compile error
expectError(
    pipe.step(fetchShipment, 'shipment').step({ shipment: fetchInvoice }),
);
// a `$`-prefixed bag key → compile error
expectError(pipe.step({ $bad: fetchShipment }));

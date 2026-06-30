// Type-level contract for `linked` (stitchapi/pipe): the `run` scope types each call's OUTPUT from the
// node and each stitch's INPUT from the stitch — so ancestors are plain typed variables, no casts — and
// it accepts a combinator (a {@link Composable}) as a node too. A type error here fails check:types-d.
import { stitch } from '..';
import { all, linked } from '../src/pipe';

import { expectType } from 'tsd';
import { z } from 'zod';

const Order = z.object({
    id: z.number(),
    shipmentId: z.string(),
    region: z.string(),
});
type Order = z.infer<typeof Order>;
const Shipment = z.object({ carrier: z.string(), trackingCode: z.string() });
type Shipment = z.infer<typeof Shipment>;

const fetchOrder = stitch({
    url: 'https://api.example.com/orders/{id}',
    output: Order,
});
const fetchShipment = stitch({
    url: 'https://api.example.com/shipments/{id}',
    output: Shipment,
});

// run(stitch, input) → Promise<O>, the resolved ancestor is typed (no cast), and a later step reads it
// as a plain variable. The whole body's return flows out of `linked`.
const carrier = linked(async (run) => {
    const order = await run(fetchOrder, { params: { id: 1043 } });
    expectType<Order>(order); // typed ancestor — no `as`
    const shipment = await run(fetchShipment, {
        params: { id: order.shipmentId }, // order.shipmentId is `string`, typed
    });
    expectType<Shipment>(shipment);
    return shipment.carrier;
});
expectType<Promise<string>>(carrier);

// run accepts a combinator (Composable) as a node and types its output.
const fan = linked(async (run) => {
    const both = await run(all({ a: fetchOrder, b: fetchShipment }), {
        params: { id: 1 },
    });
    expectType<{ a: Order; b: Shipment }>(both);
    return both;
});
expectType<Promise<{ a: Order; b: Shipment }>>(fan);

// Type-level contract for the parallel combinators all / any / race: `all` → a typed named object
// (object form) or a positional tuple (array form), `any`/`race` → the members' common output. Also
// pins the #365 input-variance widening: a member built from a TEMPLATED url (a narrow `TIn`) is still
// accepted, with its OUTPUT inferred precisely. A type error in any of these fails check:types-d.
import { stitch } from '..';
import { all, any, race } from '../src/pipe';

import { expectType } from 'tsd';
import { z } from 'zod';

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

// #365-style input variance: a member from a TEMPLATED url has a narrow `TIn` (a required `params: { id }`)
// that is NOT assignable to the bare `Stitch` default. The combinators gate members on the stitch BRAND
// (not the call signature), so a narrow-input stitch is accepted as readily as a plain one — its OUTPUT
// still inferred precisely. Without that gating these would be TS2345.
const User = z.object({ id: z.number(), name: z.string() });
type User = z.infer<typeof User>;
const fetchUserById = stitch({
    url: 'https://api.example.com/users/{id}',
    output: User,
});
expectType<Promise<{ user: User }>>(all({ user: fetchUserById })());
expectType<Promise<readonly [User]>>(all([fetchUserById])());
expectType<Promise<User>>(any([fetchUserById, fetchUserById])());

// Argument-list form: the SAME members passed as bare arguments (no brackets) infer the identical
// shapes as the array form — a positional tuple for `all`, the common output for `any`/`race`. This
// is the variadic overload; it must not collide with the array form (a single array argument) or, for
// `all`, the named-object form (a single plain-object argument), both pinned above.
expectType<Promise<readonly [Shipment, Invoice]>>(
    all(fetchShipment, fetchInvoice)(),
);
expectType<Promise<Order>>(any(fetchOrder, fetchOrderMirror)());
expectType<Promise<Order>>(race(fetchOrder, fetchOrderMirror)());

// A single bare member still reads as the variadic tuple form (one-element tuple), distinct from the
// named-object form — `all(fetchShipment)` is `[Shipment]`, not an object.
expectType<Promise<readonly [Shipment]>>(all(fetchShipment)());

// Narrow-input (#365) members are accepted in the argument-list form too, output inferred precisely.
expectType<Promise<readonly [User, User]>>(all(fetchUserById, fetchUserById)());
expectType<Promise<User>>(any(fetchUserById, fetchUserById)());

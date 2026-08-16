// The key strategies under test, and the jobs that drive them.
//
// `idempotency.keyOf` is `(input: StitchInput) => string` — SYNCHRONOUS, so `crypto.subtle` (async)
// is not available inside it. Node's `createHash` is, and so is any pure function of the input; that
// constraint is worth stating because "hash the body" is the obvious implementation and half the
// obvious implementations of it are async.
//
// Three strategies, and the difference between them is the difference between one charge and two:
//
//   • `naiveKeyOf`  — `JSON.stringify(input.body)`. Restart-stable, and NOT stable against
//                     re-serialisation: `{a,b}` and `{b,a}` are the same parameters and different
//                     keys. The failure it produces is a SECOND CHARGE, not a 409 — the server never
//                     gets to compare parameters, because it never sees the same key twice.
//   • `refKeyOf`    — derived from the business fact alone (the invoice ref). Restart-stable and
//                     immune to how the body was built, because it does not read the body's shape.
//   • `canonicalKeyOf` — a sha256 over the sorted-key rendering of the whole parameter set. Stable
//                     against ordering and absent-vs-undefined, and still sensitive to a genuinely
//                     different amount, which is what you want.
import type { StitchInput } from '../../../../packages/core/src/types';
import { canonicalJson } from './fake-payments';

import { createHash } from 'node:crypto';

/** The payment a caller intends to make. One of these is one intended charge, forever. */
export interface Payment {
    ref: string;
    amount: number;
    currency: string;
}

/** `JSON.stringify` of the body, verbatim. The obvious implementation, and the unstable one. */
export const naiveKeyOf = (input: StitchInput): string =>
    `chg-${JSON.stringify(input.body)}`;

/** The business fact and nothing else. Immune to how the body was built. */
export const refKeyOf = (input: StitchInput): string =>
    `chg-${String((input.body as { ref?: string } | undefined)?.ref)}`;

/** sha256 over the CANONICAL parameter set — order-independent, value-sensitive. */
export const canonicalKeyOf = (input: StitchInput): string =>
    `chg-${createHash('sha256').update(canonicalJson(input.body)).digest('hex').slice(0, 16)}`;

/**
 * The same logical payment, expressed three ways a real client would produce it between one process
 * and the next. Nothing here changes the PARAMETERS — the amount, currency and ref are identical in
 * all three — only how the object was assembled.
 *
 * Why these three: a body rebuilt from a database row comes out in column order, not literal order;
 * a number that round-tripped through a JSON column or a decimal library comes back `1.0`; an
 * optional field that was absent in one process is explicitly `undefined` in another.
 */
export function bodyVariants(p: Payment): {
    label: string;
    body: Record<string, unknown>;
}[] {
    return [
        {
            label: 'as written',
            body: { ref: p.ref, amount: p.amount, currency: p.currency },
        },
        {
            label: 'keys re-ordered',
            body: { currency: p.currency, amount: p.amount, ref: p.ref },
        },
        {
            label: 'optional field present-but-undefined, amount as 1.0',
            body: {
                ref: p.ref,
                amount: Number(p.amount.toFixed(1)),
                currency: p.currency,
                description: undefined,
            },
        },
    ];
}

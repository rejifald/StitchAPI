// The assembled answer, in its own file so C8 can count it without counting the counter.
//
// Everything the scenario asks for that IS declarative lives between the markers below: a strict
// schema, one `severity` override that demotes additions, and the `drift()` wrapper that turns the
// strictness into per-class levels instead of a blanket rejection. The aggregation half is the
// `DriftRate` sink, which is user code and is counted separately.
//
// The schema is strict on every field ON PURPOSE. C2, C3 and C4 each measured a softening —
// `.optional()`, `.catch()`, `.nullable()`, `z.coerce`, `z.union` — turning a breaking change into
// silence or into a fabricated value. On a money field the correct answer to "the vendor sent
// something I do not understand" is to fail the call, and `drift()` is what stops ADDITIONS from
// paying for that.
import { drift } from '../../../../packages/core/src/index';
import { z } from './zod';

/* <count:begin> */
export const StrictCharge = z.object({
    transaction_id: z.number(),
    amount: z.number(),
    currency: z.string(),
    status: z.string(),
});

/** Additions demoted below the default `info` — a vendor release should not page anyone. */
export const chargeOutput = drift(StrictCharge, {
    severity: { undeclared: 'verbose' },
});
/* <count:end> */

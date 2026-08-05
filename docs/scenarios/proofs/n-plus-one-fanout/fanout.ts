// The best available StitchAPI answer to `list -> fan out -> join`, as a caller would write it.
//
// Every decision the capture names is made here, and four of the five are made in CONFIGURATION:
//
//   • CONCURRENCY   — a seam-level `throttle: { concurrency }`. C3 measured this as the only
//     construction that survives; the member could declare its own, but the seam bucket is what
//     holds if a second member is ever added.
//   • DUPLICATES    — `cache: { ttl }` on the member. C2 measured 100 concurrent calls over 30 ids
//     collapsing to 30 requests, and the coalescer sits OUTSIDE the throttle (engine.ts:1713-1718),
//     so the 70 joiners never take a concurrency slot either.
//   • THE HERD      — `retry: { attempts }` and nothing else: `expo-jitter` is the default curve
//     (resilience.ts:45) and C5 measured it spreading a 100-call cohort across ~98 milliseconds.
//   • THE TRACE     — `linked`, whose `run` takes the stitch's OWN input per call, so the list and
//     all 100 lookups land in ONE trace (C6). The cost is that the trace draws a chain.
//
// The fifth — PARTIAL FAILURE — is the user code, and it is the `settle` helper plus the two
// branches of the row builder. `linked`'s `run` returns a rejecting Promise, and `all()` cannot
// take `.safe()` members (C1 f), so keeping 99 rows when one 404s is written by hand every time.
import { seam } from '../../../../packages/core/src/index';
import { linked } from '../../../../packages/core/src/pipe';
import type {
    Adapter,
    Clock,
    StitchError,
    TraceSink,
} from '../../../../packages/core/src/types';
import type { Customer, Order, OrderWithCustomer } from './fake-vendor';

export interface FanOutOptions {
    baseUrl: string;
    adapter: Adapter;
    clock: Clock;
    /** Simultaneous open requests allowed against the vendor. */
    concurrency: number;
    /** How long a customer stays cached — and, incidentally, what turns coalescing on. */
    ttl: string;
    attempts: number;
    trace?: TraceSink;
}

// >>> BEGIN USER CODE
/** One order joined to its customer, or to the reason the customer could not be fetched. */
export function ordersWithCustomers(
    opts: FanOutOptions,
): Promise<OrderWithCustomer[]> {
    const api = seam({
        baseUrl: opts.baseUrl,
        adapter: opts.adapter,
        clock: opts.clock,
        throttle: { concurrency: opts.concurrency },
        ...(opts.trace ? { trace: opts.trace } : {}),
    });
    const listOrders = api.stitch<{ data: Order[] }>({
        name: 'orders',
        path: '/orders',
    });
    const fetchCustomer = api.stitch<Customer>({
        name: 'customer',
        path: '/customers/{id}',
        cache: { ttl: opts.ttl },
        retry: { attempts: opts.attempts },
    });
    return linked(async (run) => {
        const { data: orders } = await run(listOrders);
        return Promise.all(
            orders.map(async (order): Promise<OrderWithCustomer> => {
                const found = await run(fetchCustomer, {
                    params: { id: order.customerId },
                }).then(
                    (customer) => ({
                        customerName: customer.name,
                        problem: null,
                    }),
                    (e: StitchError) => ({
                        customerName: null,
                        problem: `${String(e.status ?? 'transport')}: ${e.message}`,
                    }),
                );
                return {
                    orderId: order.id,
                    customerId: order.customerId,
                    ...found,
                };
            }),
        );
    });
}
// <<< END USER CODE

// The control: the same `list -> fan out -> join`, written the way the capture says the state of
// the art is written — `Promise.allSettled` + a hand-rolled concurrency pool + an in-flight dedupe
// map + a jittered retry loop.
//
// It runs against the SAME `Adapter` and the SAME `Clock` as `fanout.ts`, so the two are compared
// on identical wire behaviour and identical virtual time — the only difference is who wrote the
// resilience. Deliberately no dependencies: `p-limit` and `Bottleneck` are the real answer, and
// vendoring the ~15 lines they contribute is the honest way to count what the library replaces
// (an `npm i p-limit` is not zero lines, it is a dependency).
import type {
    Adapter,
    AdapterResponse,
    Clock,
} from '../../../../packages/core/src/types';
import type { Customer, Order, OrderWithCustomer } from './fake-vendor';

export interface HandRolledOptions {
    baseUrl: string;
    adapter: Adapter;
    clock: Clock;
    concurrency: number;
    attempts: number;
}

// >>> BEGIN USER CODE
/** Statuses worth another go — the set StitchAPI's `retry.on` defaults to (engine.ts:612). */
const RETRYABLE = new Set([429, 502, 503, 504]);

/** A FIFO concurrency pool: at most `limit` bodies running at once. What `p-limit` is. */
function pool(limit: number) {
    let active = 0;
    const waiting: (() => void)[] = [];
    return async function run<T>(fn: () => Promise<T>): Promise<T> {
        if (active >= limit)
            await new Promise<void>((resolve) => waiting.push(resolve));
        else active += 1;
        try {
            return await fn();
        } finally {
            const next = waiting.shift();
            if (next) next();
            else active -= 1;
        }
    };
}

/** One request with a bounded, FULL-jitter exponential backoff on the retryable statuses. */
async function request(
    adapter: Adapter,
    clock: Clock,
    url: string,
    attempts: number,
): Promise<AdapterResponse> {
    for (let attempt = 1; ; attempt += 1) {
        const res = await adapter({ method: 'GET', url, headers: {} });
        if (!RETRYABLE.has(res.status) || attempt >= attempts) return res;
        await clock.sleep(
            Math.random() * Math.min(100 * 2 ** (attempt - 1), 10_000),
        );
    }
}

/** Non-2xx becomes a throw, so the pool's callers can be `allSettled`. */
async function json<T>(
    adapter: Adapter,
    clock: Clock,
    url: string,
    attempts: number,
): Promise<T> {
    const res = await request(adapter, clock, url, attempts);
    if (res.status < 200 || res.status >= 300)
        throw Object.assign(new Error(`HTTP ${String(res.status)}`), {
            status: res.status,
        });
    return res.body as T;
}

export async function handRolledOrdersWithCustomers(
    opts: HandRolledOptions,
): Promise<OrderWithCustomer[]> {
    const limit = pool(opts.concurrency);
    const inFlight = new Map<string, Promise<Customer>>();
    const customer = (id: string): Promise<Customer> => {
        const joined = inFlight.get(id);
        if (joined) return joined;
        const started = limit(() =>
            json<Customer>(
                opts.adapter,
                opts.clock,
                `${opts.baseUrl}/customers/${id}`,
                opts.attempts,
            ),
        );
        inFlight.set(id, started);
        void started.catch(() => undefined);
        return started;
    };
    const { data: orders } = await json<{ data: Order[] }>(
        opts.adapter,
        opts.clock,
        `${opts.baseUrl}/orders`,
        opts.attempts,
    );
    const settled = await Promise.allSettled(
        orders.map((o) => customer(o.customerId)),
    );
    return orders.map((order, i): OrderWithCustomer => {
        const row = settled[i];
        const base = { orderId: order.id, customerId: order.customerId };
        if (row === undefined || row.status === 'rejected') {
            const e = row?.reason as { status?: number; message?: string };
            return {
                ...base,
                customerName: null,
                problem: `${String(e?.status ?? 'transport')}: ${String(e?.message)}`,
            };
        }
        return { ...base, customerName: row.value.name, problem: null };
    });
}
// <<< END USER CODE

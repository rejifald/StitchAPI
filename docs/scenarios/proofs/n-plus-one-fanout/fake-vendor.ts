// The vendor this scenario fans out against: a list endpoint and a per-id detail endpoint, as a
// plain `Adapter` over an injected {@link Clock}. No network, no timers of its own.
//
// Everything a claim here needs to say is a read off this object:
//
//   • `GET /orders` returns N orders, each carrying a `customerId` drawn from a SMALLER pool — the
//     duplicate-id shape C2 exists for (100 orders, 30 distinct customers).
//   • `GET /customers/{id}` counts requests PER ID (`perId`), so "did it fetch cust-7 four times?"
//     is a number rather than an impression.
//   • It tracks PEAK IN-FLIGHT: the adapter increments on entry and decrements on exit, and
//     `peakInFlight` is the high-water mark. This is the ONLY honest way to answer "was the
//     concurrency actually bounded" — a request-count says nothing about how many were open at once.
//   • Named ids can be made to 404 or 429 persistently, and `burst429(n)` rate-limits the first `n`
//     customer requests whatever their id — which is how a simultaneous fan-out gets throttled as a
//     BURST, so the retry clustering in C5 is measurable.
//
// The hold (`holdMs`) matters more than it looks: with a zero-duration handler every request opens
// and closes inside one microtask and the peak is trivially 1. Every concurrency measurement here
// runs with a hold, so overlap is real.
import type {
    Adapter,
    AdapterRequest,
    Clock,
} from '../../../../packages/core/src/types';

/** One order from the list endpoint — the only field that matters is the foreign key. */
export interface Order {
    id: string;
    customerId: string;
    total: number;
}

/** One customer, as the detail endpoint returns it. */
export interface Customer {
    id: string;
    name: string;
    tier: string;
}

/** The joined row C8 assembles: the order plus whatever the customer lookup produced. */
export interface OrderWithCustomer {
    orderId: string;
    customerId: string;
    customerName: string | null;
    /** `null` on success; the reason string on a failed lookup — the identifiability C4 measures. */
    problem: string | null;
}

/** One recorded customer request: which id, what came back, and WHEN on the injected clock. */
export interface CustomerCall {
    id: string;
    status: number;
    /** Virtual ms at which the request reached the vendor — the arrival spread C5 measures. */
    at: number;
    /** In-flight count INCLUDING this request, at the moment it arrived. */
    inFlight: number;
}

export interface FakeVendorOptions {
    clock: Clock;
    /** How many orders the list endpoint returns. Default 100. */
    orders?: number;
    /** How many DISTINCT customers those orders reference. Default = `orders` (no duplicates). */
    customers?: number;
    /** Virtual ms each customer request is held open. Default 0 (no hold — peak is then trivially 1). */
    holdMs?: number;
    /**
     * Per-id hold override, so completion order can be made to disagree with request order — which
     * is the only way to test that the result order is positional rather than incidental.
     */
    slow?: Readonly<Record<string, number>>;
    /** Ids that always 404 — the deleted customer C4 is about. */
    notFound?: readonly string[];
    /** Ids that always 429. */
    rateLimited?: readonly string[];
    /**
     * Echo the request URL on the response, as `fetchAdapter` does (http-adapter.ts:98,111,145).
     * Default true. `StitchError.url` is copied straight off `res.url` (stitch.ts `rebuildError`),
     * so a transport that does not set it leaves the caller unable to say WHICH id failed from the
     * error alone — which C4 measures both ways.
     */
    echoUrl?: boolean;
    /**
     * `Retry-After` (delta-seconds) to send with every 429 — what a well-behaved vendor does. The
     * engine PREFERS it over the computed backoff by default (`retry.respect !== false`,
     * engine.ts:748-751), so it is the one thing that can undo `expo-jitter`. C5 measures both.
     */
    retryAfter?: string;
}

/**
 * The vendor. `adapter()` is what a stitch/seam is handed; every number in this directory is read
 * off `perId`, `customerCalls` or `peakInFlight`.
 */
export class FakeVendor {
    /** The list the fan-out starts from. Deterministic, so every claim sees the same duplicates. */
    readonly orders: readonly Order[];
    /** Every customer request, in arrival order. */
    readonly customerCalls: CustomerCall[] = [];
    /** Requests per customer id — the duplicate ledger C2 is a statement about. */
    readonly perId = new Map<string, number>();
    /** How many times the LIST endpoint was called (should be 1 in every claim here). */
    listCalls = 0;
    /** High-water mark of simultaneously-open customer requests. THE number C3 measures. */
    peakInFlight = 0;

    /** Ids whose responses landed, in COMPLETION order — the scrambling C7 measures against. */
    readonly completions: string[] = [];

    private readonly clock: Clock;
    private readonly holdMs: number;
    private readonly slow: Map<string, number>;
    private readonly notFound: Set<string>;
    private readonly rateLimited: Set<string>;
    private readonly echoUrl: boolean;
    private readonly retryAfter: string | undefined;
    private inFlight = 0;
    /** Remaining requests to answer 429 regardless of id — the simultaneous-burst throttle. */
    private burstLeft = 0;

    constructor(opts: FakeVendorOptions) {
        this.clock = opts.clock;
        this.holdMs = opts.holdMs ?? 0;
        this.slow = new Map(Object.entries(opts.slow ?? {}));
        this.notFound = new Set(opts.notFound ?? []);
        this.rateLimited = new Set(opts.rateLimited ?? []);
        this.echoUrl = opts.echoUrl ?? true;
        this.retryAfter = opts.retryAfter;
        const orderCount = opts.orders ?? 100;
        const customerCount = opts.customers ?? orderCount;
        this.orders = Array.from({ length: orderCount }, (_, i) => ({
            id: `ord-${String(i + 1).padStart(4, '0')}`,
            // Round-robin so the duplicate distribution is flat and exact: with 100 orders over 30
            // customers every id appears 3 or 4 times, and `100 / 30` is the ratio C2 reports.
            customerId: `cust-${String((i % customerCount) + 1).padStart(3, '0')}`,
            total: 1000 + i,
        }));
    }

    /** Rate-limit the next `n` customer requests whatever their id — one simultaneous burst, 429ed. */
    burst429(n: number): void {
        this.burstLeft = n;
    }

    /** Total customer requests that reached the server. */
    get customerRequests(): number {
        return this.customerCalls.length;
    }

    /** How many DISTINCT customer ids the fan-out asked for. */
    get distinctIds(): number {
        return this.perId.size;
    }

    /** Requests made for one id. */
    requestsFor(id: string): number {
        return this.perId.get(id) ?? 0;
    }

    /** The per-id request counts, descending — `[4,4,4,3,3,…]` reads as a duplicate ledger. */
    perIdCounts(): number[] {
        return [...this.perId.values()].sort((a, b) => b - a);
    }

    /** Arrival times of the customer requests after the first `skip` — i.e. the RETRIES. */
    arrivalsAfter(skip: number): number[] {
        return this.customerCalls.slice(skip).map((c) => c.at);
    }

    adapter(): Adapter {
        return async (req: AdapterRequest) => {
            const path = new URL(req.url).pathname;
            if (path === '/orders') {
                this.listCalls += 1;
                return {
                    status: 200,
                    headers: {},
                    body: { data: this.orders },
                };
            }
            const id = path.slice('/customers/'.length);
            const status =
                this.burstLeft > 0
                    ? ((this.burstLeft -= 1), 429)
                    : this.notFound.has(id)
                      ? 404
                      : this.rateLimited.has(id)
                        ? 429
                        : 200;
            this.inFlight += 1;
            if (this.inFlight > this.peakInFlight)
                this.peakInFlight = this.inFlight;
            // Recorded on ARRIVAL, before the hold: `at` is when the request left the process,
            // which is the number every timing claim measures.
            this.customerCalls.push({
                id,
                status,
                at: this.clock.now(),
                inFlight: this.inFlight,
            });
            this.perId.set(id, (this.perId.get(id) ?? 0) + 1);
            const echo = this.echoUrl ? { url: req.url } : {};
            const hold = this.slow.get(id) ?? this.holdMs;
            try {
                if (hold > 0) await this.clock.sleep(hold);
                this.completions.push(id);
                if (status === 404)
                    return {
                        status,
                        headers: {},
                        body: { error: 'customer_not_found', id },
                        ...echo,
                    };
                if (status === 429)
                    return {
                        status,
                        headers: this.retryAfter
                            ? { 'retry-after': this.retryAfter }
                            : {},
                        body: { error: 'rate_limited', id },
                        ...echo,
                    };
                return {
                    status: 200,
                    headers: {},
                    body: {
                        id,
                        name: `Customer ${id.slice(-3)}`,
                        tier: 'standard',
                    } satisfies Customer,
                    ...echo,
                };
            } finally {
                this.inFlight -= 1;
            }
        };
    }
}

/** The ids the fan-out will ask for, in list order (WITH duplicates — that is the point). */
export const idsOf = (orders: readonly Order[]): string[] =>
    orders.map((o) => o.customerId);

// `manualClock.advance` sets `now` to a timer's EXACT due time (test-clock.ts:90), so an arrival
// recorded after a 372.4ms backoff really is 372.4 — the clock adds no quantisation of its own.
// Bucketing is therefore done here, deliberately, at a stated width: "how many retries landed in
// the same MILLISECOND" is `width = 1`, and a coarser width answers the same question at the scale
// a server's rate window actually cares about.
const bucketOf = (x: number, width: number): number => Math.floor(x / width);

/**
 * How many values in `xs` share their most-crowded bucket of `width` ms. `1` means every arrival
 * is alone in its bucket (fully de-clustered); `xs.length` means the whole burst re-arrived
 * together.
 */
export function largestBucket(xs: readonly number[], width = 1): number {
    const buckets = new Map<number, number>();
    let biggest = 0;
    for (const x of xs) {
        const k = bucketOf(x, width);
        const n = (buckets.get(k) ?? 0) + 1;
        buckets.set(k, n);
        if (n > biggest) biggest = n;
    }
    return biggest;
}

/** How many DISTINCT `width`-ms buckets a set of arrival times occupies — the spread, as one number. */
export const distinctBuckets = (xs: readonly number[], width = 1): number =>
    new Set(xs.map((x) => bucketOf(x, width))).size;

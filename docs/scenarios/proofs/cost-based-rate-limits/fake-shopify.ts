// A fake, in-memory Shopify GraphQL Admin API that models the COST BUCKET honestly:
//
//   - a leaky bucket of `maximumAvailable` points (1000) refilling at `restoreRate` points/sec,
//   - a per-operation cost, so "requests per second" is not a meaningful unit,
//   - over-spending answers **HTTP 200** with `errors: [{ extensions: { code: 'THROTTLED' } }]`,
//   - `extensions.cost` rides EVERY response — success and throttle alike,
//   - `drain()` simulates a third-party app spending the SHOP's shared bucket.
//
// Refill is driven by an INJECTED {@link Clock}, so every proof runs on `manualClock()` virtual
// time: the numbers below are exact, not timing-dependent. Nothing touches the network.
import type {
    Adapter,
    AdapterRequest,
    AdapterResponse,
    Clock,
} from '../../../../packages/core/src/types';

/** Shopify's `extensions.cost.throttleStatus`, spelled exactly as the vendor spells it. */
export interface ThrottleStatus {
    maximumAvailable: number;
    currentlyAvailable: number;
    restoreRate: number;
}

/** Shopify's `extensions.cost` envelope. `actualQueryCost` is null on a throttled response. */
export interface CostExtension {
    requestedQueryCost: number;
    actualQueryCost: number | null;
    throttleStatus: ThrottleStatus;
}

/** One recorded hit, as the provider saw it. */
export interface RecordedCall {
    operationName: string;
    requestedQueryCost: number;
    /** Points in the shop's bucket at the moment the request was priced (after refill). */
    availableBefore: number;
    throttled: boolean;
    /** Virtual time (ms) the request arrived. */
    at: number;
}

export interface ShopifyOptions {
    clock: Clock;
    /** Bucket size. Shopify's standard plan: 1000. */
    maximumAvailable?: number;
    /** Points restored per second. Shopify's standard plan: 50. */
    restoreRate?: number;
    /** Cost per operation name. Unlisted operations cost `defaultCost`. */
    costs?: Record<string, number>;
    /** Cost for an operation not named in `costs`. Default 10. */
    defaultCost?: number;
    /**
     * Shopify REFUNDS the difference between the requested and the actual cost. When set, the
     * response reports `actualQueryCost = requestedQueryCost * actualRatio` and only that is debited.
     */
    actualRatio?: number;
}

export class FakeShopify {
    /** Every hit, in order. `calls.length` IS the request count. */
    readonly calls: RecordedCall[] = [];
    /** How many responses were 200-with-THROTTLED. */
    throttledCount = 0;

    readonly maximumAvailable: number;
    readonly restoreRate: number;

    private available: number;
    private lastRefillAt: number;
    private readonly clock: Clock;
    private readonly costs: Record<string, number>;
    private readonly defaultCost: number;
    private readonly actualRatio: number;

    constructor(opts: ShopifyOptions) {
        this.clock = opts.clock;
        this.maximumAvailable = opts.maximumAvailable ?? 1000;
        this.restoreRate = opts.restoreRate ?? 50;
        this.costs = opts.costs ?? {};
        this.defaultCost = opts.defaultCost ?? 10;
        this.actualRatio = opts.actualRatio ?? 1;
        this.available = this.maximumAvailable;
        this.lastRefillAt = opts.clock.now();
    }

    /** Points currently in the shop's bucket, refilled to *now*. */
    currentlyAvailable(): number {
        this.refill();
        return this.available;
    }

    /**
     * Total points the shop was charged across every accepted call. Unlike `currentlyAvailable()`
     * this does not move with refill, so it is the honest measure of what a retry policy SPENT.
     */
    get pointsCharged(): number {
        return this.calls
            .filter((c) => !c.throttled)
            .reduce(
                (sum, c) => sum + c.requestedQueryCost * this.actualRatio,
                0,
            );
    }

    /**
     * Another app on the same shop spends `points`. This is the shared-bucket case: our client's
     * own bookkeeping cannot predict it, so the budget must be re-read from every response.
     */
    drain(points: number): void {
        this.refill();
        this.available = Math.max(0, this.available - points);
    }

    /** The cost the provider will price an operation at. */
    costOf(operationName: string): number {
        return this.costs[operationName] ?? this.defaultCost;
    }

    private refill(): void {
        const nowMs = this.clock.now();
        const elapsedSec = (nowMs - this.lastRefillAt) / 1000;
        this.lastRefillAt = nowMs;
        if (elapsedSec <= 0) return;
        this.available = Math.min(
            this.maximumAvailable,
            this.available + elapsedSec * this.restoreRate,
        );
    }

    private throttleStatus(): ThrottleStatus {
        return {
            maximumAvailable: this.maximumAvailable,
            currentlyAvailable: this.available,
            restoreRate: this.restoreRate,
        };
    }

    /**
     * The GraphQL Admin endpoint. The graphql surface sends `{ query, variables, operationName }`,
     * so the operation name is what prices the call.
     */
    adapter(): Adapter {
        return async (req: AdapterRequest): Promise<AdapterResponse> => {
            const body = (req.body ?? {}) as {
                operationName?: string;
                variables?: Record<string, unknown>;
            };
            const operationName = body.operationName ?? 'anonymous';
            const requestedQueryCost = this.costOf(operationName);

            this.refill();
            const availableBefore = this.available;
            const at = this.clock.now();

            // THE TRAP: over-spending is a 200, not a 429. Nothing is debited, and `extensions.cost`
            // still rides the response — it is what tells a client how long to wait.
            if (requestedQueryCost > this.available) {
                this.throttledCount++;
                this.calls.push({
                    operationName,
                    requestedQueryCost,
                    availableBefore,
                    throttled: true,
                    at,
                });
                return {
                    status: 200,
                    headers: {},
                    body: {
                        errors: [
                            {
                                message: 'Throttled',
                                extensions: { code: 'THROTTLED' },
                            },
                        ],
                        extensions: {
                            cost: {
                                requestedQueryCost,
                                actualQueryCost: null,
                                throttleStatus: this.throttleStatus(),
                            } satisfies CostExtension,
                        },
                    },
                };
            }

            const actualQueryCost = requestedQueryCost * this.actualRatio;
            this.available -= actualQueryCost;
            this.calls.push({
                operationName,
                requestedQueryCost,
                availableBefore,
                throttled: false,
                at,
            });
            return {
                status: 200,
                headers: {},
                body: {
                    data: { ok: true, operationName },
                    extensions: {
                        cost: {
                            requestedQueryCost,
                            actualQueryCost,
                            throttleStatus: this.throttleStatus(),
                        } satisfies CostExtension,
                    },
                },
            };
        };
    }
}

/** The wait Shopify's own arithmetic prescribes, in ms: `(requested - available) / restoreRate`. */
export function deficitWaitMs(cost: CostExtension): number {
    const { requestedQueryCost, throttleStatus } = cost;
    const deficit = requestedQueryCost - throttleStatus.currentlyAvailable;
    if (deficit <= 0) return 0;
    return (deficit / throttleStatus.restoreRate) * 1000;
}

/** Read `extensions.cost` off any response body, or `undefined` when it is not there. */
export function costOfBody(body: unknown): CostExtension | undefined {
    return (
        body as { extensions?: { cost?: CostExtension } } | null | undefined
    )?.extensions?.cost;
}

/** Is this body a 200-with-THROTTLED? */
export function isThrottled(body: unknown): boolean {
    const errs = (
        body as
            { errors?: { extensions?: { code?: string } }[] } | null | undefined
    )?.errors;
    return !!errs?.some((e) => e.extensions?.code === 'THROTTLED');
}

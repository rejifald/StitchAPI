// USER CODE for C6 — the cost-aware Shopify surface, written entirely against StitchAPI's public
// API (`Surface`, `SurfaceOutcome`, `verdictOf`, `graphqlSurface`, all exported from the barrel).
//
// It closes all four requirements the scenario sets:
//   (a) detects THROTTLED on an HTTP 200          → `interpret` reads `errors[].extensions.code`
//   (b) waits the COMPUTED deficit, not a curve   → `SurfaceOutcome.after` (engine.ts:798)
//   (c) reads the budget off EVERY response       → `interpret` runs on successes too
//   (d) survives the SHARED bucket                → the ledger is overwritten by the server's
//                                                   number on every response, never inferred
//
// The `id` is deliberately `'graphql'`: the `document` / `operationName` config keys are gated on
// `kind: { id: 'graphql' }` at the type level (types.ts:581-585), so a surface with any other id
// cannot use them. See `c6-assembled-solution.ts` (e) for the measurement of that.
import { graphqlSurface, verdictOf } from '../../../../packages/core/src/index';
import type {
    Surface,
    SurfaceOutcome,
} from '../../../../packages/core/src/index';
import type { Hooks } from '../../../../packages/core/src/types';
import type { CostExtension } from './fake-shopify';
import { costOfBody, deficitWaitMs, isThrottled } from './fake-shopify';

/**
 * The running cost budget. Every value here comes from the SERVER — the shop's bucket is shared
 * with other apps, so a locally-inferred balance is always a guess.
 */
export class CostLedger {
    /** Last `currentlyAvailable` the shop reported, or `undefined` before the first response. */
    available: number | undefined;
    restoreRate = 50;
    maximumAvailable = 1000;
    /** Points spent, summed from `actualQueryCost` on successful responses. */
    spent = 0;
    /** Every computed wait the surface asked the engine for (ms) — measured by the proofs. */
    readonly waits: number[] = [];
    /** Responses seen, throttled or not. */
    observed = 0;

    record(cost: CostExtension): void {
        this.observed++;
        this.available = cost.throttleStatus.currentlyAvailable;
        this.restoreRate = cost.throttleStatus.restoreRate;
        this.maximumAvailable = cost.throttleStatus.maximumAvailable;
        if (cost.actualQueryCost !== null) this.spent += cost.actualQueryCost;
    }

    /** How long to wait before a query costing `cost` points is affordable (ms). */
    waitFor(cost: number): number {
        if (this.available === undefined) return 0;
        const deficit = cost - this.available;
        return deficit <= 0 ? 0 : (deficit / this.restoreRate) * 1000;
    }
}

/** A cost-aware GraphQL surface. Reactive half of the solution: detect, compute, re-attempt. */
export function shopifyCostSurface(
    ledger: CostLedger,
): Surface & { readonly id: 'graphql' } {
    // `Surface.buildRequest` is optional, so under `exactOptionalPropertyTypes` it cannot be
    // assigned straight across — pin the graphql one, which is always defined.
    const buildRequest: NonNullable<Surface['buildRequest']> = (
        cfg,
        input,
        base,
    ) => graphqlSurface.buildRequest?.(cfg, input, base) ?? base;
    return {
        id: 'graphql',
        buildRequest,
        interpret: (res, cfg): SurfaceOutcome => {
            // Keep the declarative verdict in front of the body rules (surface.ts:166-167).
            const failure = verdictOf(res, cfg);
            if (failure) return failure;

            // (c) EVERY response updates the budget — successes carry `throttleStatus` too.
            const cost = costOfBody(res.body);
            if (cost) ledger.record(cost);

            // (a) the 200-with-THROTTLED, and (b) the wait the server's own arithmetic dictates.
            if (isThrottled(res.body) && cost) {
                const after = deficitWaitMs(cost);
                ledger.waits.push(after);
                return {
                    ok: false,
                    retry: true,
                    message: `THROTTLED — need ${cost.requestedQueryCost}, have ${cost.throttleStatus.currentlyAvailable}`,
                    after,
                };
            }

            // Any OTHER GraphQL error stays a plain failure — defer to the built-in surface.
            // (`interpret` is optional on `Surface`; the graphql surface always defines it.)
            return (
                graphqlSurface.interpret?.(res, cfg) ?? {
                    ok: true,
                    data: res.body,
                }
            );
        },
    };
}

/**
 * Proactive half: an `onRequest` hook that pauses until the ledger says the next query is
 * affordable. `Hooks.onRequest` may return a promise (types.ts:1286), so awaiting inside it gates
 * the request. This is what stops the client from spending into a deficit it can already predict —
 * the reactive half above still handles the part it cannot (another app draining the shop).
 */
export function costGate(
    ledger: CostLedger,
    queryCost: number,
    sleep: (ms: number) => Promise<void>,
): NonNullable<Hooks['onRequest']> {
    return async (): Promise<void> => {
        const wait = ledger.waitFor(queryCost);
        if (wait > 0) await sleep(wait);
    };
}

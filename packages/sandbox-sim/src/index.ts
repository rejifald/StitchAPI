/**
 * Isomorphic fake-API simulator handler registry (S1 scaffold).
 *
 * Handlers added in S2–S4; adapters in S5. Registry typed against the frozen
 * SimHandler contract — do not widen it (see docs/playground/contracts/README.md).
 */
import type { SimHandler } from '../../../docs/playground/contracts/sim';

export type {
    SimHandler,
    SimRequest,
    SimResponse,
    SimKnobs,
} from '../../../docs/playground/contracts/sim';

/** Handler registry: empty at S1; populated by S2–S4. */
const handlers: SimHandler[] = [];

/**
 * Register a handler into the simulator. Handlers are matched in order;
 * the first to `match()` wins.
 */
export function registerHandler(h: SimHandler): void {
    handlers.push(h);
}

/**
 * Reset the handler registry (primarily for test isolation).
 */
export function resetHandlers(): void {
    handlers.length = 0;
}

export { handlers };

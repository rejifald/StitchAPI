/**
 * F1 — Handler aggregation & registration wiring.
 *
 * Imports all handler arrays (S2–S4 + sandbox index) and exports:
 *   - `allHandlers`: the complete list of SimHandler objects
 *   - `registerAllHandlers()`: registers all handlers into the registry (from ../index)
 *
 * This module is the single source of truth for which handlers are active.
 */
import type { SimHandler } from '../../../../docs/sandbox/contracts/sim';
import { registerHandler, resetHandlers } from '../index';
import { authResilienceHandlers } from './auth-resilience';
// Import all handler arrays
import { errorsStatusHandlers } from './errors-status';
import { sandboxIndexHandlers } from './sandbox-index';
import { streamingLlmHandlers } from './streaming-llm';

/**
 * Complete list of all handlers.
 * Order matters: handlers are matched in order; the first to match wins.
 */
export const allHandlers: SimHandler[] = [
    ...errorsStatusHandlers,
    ...streamingLlmHandlers,
    ...authResilienceHandlers,
    ...sandboxIndexHandlers,
];

/**
 * Register all handlers into the simulator.
 * Call this once at startup (or before each test for isolation).
 */
export function registerAllHandlers(): void {
    resetHandlers();
    for (const handler of allHandlers) {
        registerHandler(handler);
    }
}

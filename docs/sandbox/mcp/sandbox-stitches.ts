/**
 * Demo stitch registry for the sandbox MCP — stitches that target the fake API's
 * demo host (`demo.stitchapi.dev`), so `list_stitches` / `run_stitch` work out of
 * the box against the simulator. These mirror the docs' canonical roster (see
 * `apps/docs/AUTHORING.md` → "The canonical example world"). Override with
 * `--module <path>` to point at your own (compiled) stitches and exercise them
 * against the sim instead of the net.
 *
 * Paths use RFC 6570 templates (`{id}`) — the syntax `expandPath` resolves from
 * `run_stitch`'s `{ params }`. Each unwraps the `{ data }` envelope the sim returns.
 */
import type { StitchRegistry } from '../../../packages/core/src/registry';

import { stitch } from 'stitchapi';

export const sandboxRegistry: StitchRegistry = {
    /** GET /users/{id} — a single user (ids 1–3). `{ params: { id } }`. */
    getUser: stitch({
        path: 'https://demo.stitchapi.dev/users/{id}',
        unwrap: 'data',
    }),
    /** GET /users — the fixed fixture (Alice, Bob, Carol). */
    listUsers: stitch({
        path: 'https://demo.stitchapi.dev/users',
        unwrap: 'data',
    }),
    /** POST /users — create a user; echoes the body + an assigned id. */
    createUser: stitch({
        method: 'POST',
        path: 'https://demo.stitchapi.dev/users',
        unwrap: 'data',
    }),
    /** GET /users/{id}/orders — a user's orders (ids 1–3). `{ params: { id } }`. */
    listOrders: stitch({
        path: 'https://demo.stitchapi.dev/users/{id}/orders',
        unwrap: 'data',
    }),
};

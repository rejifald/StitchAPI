/**
 * Demo stitch registry for the sandbox MCP — stitches that target the fake API's
 * demo host (`demo.stitchapi.dev`), so `list_stitches` / `run_stitch` work out of
 * the box against the simulator. Override with `--module <path>` to point at your
 * own (compiled) stitches and exercise them against the sim instead of the net.
 *
 * Paths use RFC 6570 templates (`{id}`) — the syntax `expandPath` resolves from
 * `run_stitch`'s `{ params }`.
 */
import type { StitchRegistry } from '../../../packages/core/src/registry';

import { stitch } from 'stitchapi';

export const sandboxRegistry: StitchRegistry = {
    /** GET /users — the fixed fixture (Alice, Bob, Carol). */
    getUsers: stitch('https://demo.stitchapi.dev/users'),
    /** GET /users/{id} — a single user (ids 1–3). `{ params: { id } }`. */
    getUser: stitch('https://demo.stitchapi.dev/users/{id}'),
    /** GET /status/{code} — echo any HTTP status (100–599). */
    getStatus: stitch('https://demo.stitchapi.dev/status/{code}'),
};

// USER CODE for C7 — the best batch-residue loop the public API supports.
//
// It is built from three seams that already exist:
//
//   1. `Surface.interpret` reads the 200 body and asks for another attempt
//      (`SurfaceOutcome.retry`, surface.ts:34-37) with a wait that GROWS (`after`);
//   2. `hooks.onRequest` rewrites `ctx.req.body` to the residue before that attempt leaves
//      (engine.ts:646-670) — the only seam in the library that can change a request between
//      attempts (C4);
//   3. a ledger closure the two share, which is also what makes the residue REACHABLE: when the
//      round budget runs out this returns the residue as the call's DATA rather than dropping it.
//
// Everything below the `── surface ──` line is the code a user would write.
import { verdictOf } from '../../../../packages/core/src/index';
import type {
    Surface,
    SurfaceOutcome,
} from '../../../../packages/core/src/surface';
import type { AtLeastOne, Hooks } from '../../../../packages/core/src/types';

/** What a batch call resolves to: what landed, what never did, and whether it ran out of rounds. */
export interface BatchLedger<T> {
    landed: T[];
    /** Items that were still unwritten when the loop stopped. Empty on a clean run. */
    residue: T[];
    /** Items the provider rejected permanently (a 400 mapping error) — never resent. */
    terminal: T[];
    rounds: number;
    gaveUp: boolean;
}

export interface BatchRetryOptions<T> {
    /** Items to RESEND, read off one response body (DynamoDB `UnprocessedItems`, ES's 429s). */
    residueOf: (body: unknown) => T[];
    /** Items that LANDED, read off the same body. */
    landedOf: (body: unknown) => T[];
    /** Items that failed permanently. Default: none. */
    terminalOf?: (body: unknown) => T[];
    /** Build the next request body from a residue. */
    bodyOf: (items: T[]) => unknown;
    /**
     * Rounds allowed, including the first. **Must equal the stitch's `retry.attempts`** — the
     * engine does not tell `interpret` which attempt it is on (surface.ts:61-64), so this counts
     * its own invocations instead.
     */
    rounds: number;
    /** Wait before round N (1-based, so `backoff(1)` precedes the SECOND request). */
    backoff: (round: number) => number | string;
}

/**
 * Build the `kind` + `hooks` + `ledger` triple for a batch stitch:
 *
 * ```ts
 * const batch = batchRetry({ … });
 * const call = stitch({ url, method: 'POST', kind: batch.kind, hooks: batch.hooks, retry: { attempts: 6 } });
 * const out = (await call({ body })) as BatchLedger<Item>;
 * ```
 *
 * ⚠️ The ledger is ONE object per stitch, so a stitch built this way serves ONE CALL AT A TIME.
 * Two concurrent calls share the ledger and corrupt each other (c7 measures exactly that).
 */
// #region loop
export function batchRetry<T>(opts: BatchRetryOptions<T>): {
    kind: Surface;
    // `StitchConfig.hooks` takes `AtLeastOne<Hooks>` (the opaque `hooks: {}` is rejected), so a
    // helper that hands back a plain `Hooks` does not typecheck at the call site.
    hooks: AtLeastOne<Hooks>;
    ledger: BatchLedger<T>;
} {
    const ledger: BatchLedger<T> = {
        landed: [],
        residue: [],
        terminal: [],
        rounds: 0,
        gaveUp: false,
    };

    // ── surface ───────────────────────────────────────────────────────────────────────────────
    const kind: Surface = {
        id: 'batch-residue',
        interpret: (res, cfg): SurfaceOutcome => {
            // Compose the declarative verdict first (surface.ts:151-172): a 500 is a transport
            // failure before it is a batch envelope, and it must still open the circuit.
            const failed = verdictOf(res, cfg);
            if (failed) return failed;

            ledger.rounds += 1;
            ledger.landed.push(...opts.landedOf(res.body));
            ledger.terminal.push(...(opts.terminalOf?.(res.body) ?? []));
            ledger.residue = opts.residueOf(res.body);

            if (ledger.residue.length === 0) return { ok: true, data: ledger };
            if (ledger.rounds >= opts.rounds) {
                // Out of rounds. Resolve SUCCESSFULLY with the residue in the payload: an error
                // would throw the landed items away, and dropping it is the Logstash bug.
                ledger.gaveUp = true;
                return { ok: true, data: ledger };
            }
            return {
                ok: false,
                retry: true,
                message: `${ledger.residue.length} unprocessed after round ${ledger.rounds}`,
                after: opts.backoff(ledger.rounds),
            };
        },
    };

    const hooks: AtLeastOne<Hooks> = {
        onRequest: (ctx) => {
            if (!ctx.req) return;
            if (ctx.attempt === 1) {
                // A fresh call: clear the previous one's ledger.
                ledger.landed = [];
                ledger.residue = [];
                ledger.terminal = [];
                ledger.rounds = 0;
                ledger.gaveUp = false;
                return;
            }
            // Assign, never mutate in place: the attempt's request is a SHALLOW clone of one
            // `baseReq` (engine.ts:261-264), so an in-place edit of `body` would rewrite the
            // original too.
            ctx.req.body = opts.bodyOf(ledger.residue);
        },
    };

    return { kind, hooks, ledger };
}
// #endregion loop

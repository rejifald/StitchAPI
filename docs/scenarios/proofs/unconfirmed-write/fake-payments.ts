// The Stripe-ish payment server this scenario measures against: an `Adapter` that implements real
// idempotency-key semantics, and — crucially — a LEDGER OF CHARGES that is the ground truth every
// claim asserts on.
//
// The whole scenario is one question: at the end of a workload, how many charges does the vendor
// hold, and how many did the caller mean to create? Everything else (how many requests reached the
// wire, what the caller was told, how many keys were minted) only matters as an explanation of that
// number. So `charges` is a plain array, `chargeCount()` reads it, and no claim is allowed to
// conclude anything from the client's own view of events.
//
// The five behaviours modelled, each because a real vendor has it and each because it breaks
// something a client would otherwise get away with:
//
//   1. FIRST-WRITE-WINS REPLAY. The status AND body of the first request for a key are stored and
//      replayed on reuse — INCLUDING A STORED FAILURE. Stripe replays the recorded outcome
//      "regardless of whether it succeeds or fails", so a retry after a cached 500 gets that same
//      500 forever. A replay carries `Idempotent-Replayed: true`, the way Stripe's does.
//   2. PARAMETER COMPARISON. The same key with different parameters is a `409 idempotency_error`.
//      The comparison is on the CANONICAL parameters by default (sorted keys — what Stripe actually
//      compares), with a `compare: 'bytes'` mode for the vendors that diff the raw serialisation.
//      The difference is load-bearing: under `canonical`, a re-serialised body is harmless to the
//      SERVER and still fatal to a body-derived CLIENT key.
//   3. A TTL. Records are pruned `keyTtlMs` after they are stored, and a pruned key is a fresh key —
//      it creates a SECOND CHARGE. Stripe prunes after ~24 hours; a job queue does not care.
//   4. LOST RESPONSES. A request can be PROCESSED — charge created, record stored — and then never
//      answered. This is the case the whole scenario exists for, and it is the only one where the
//      client's view and the ledger genuinely disagree.
//   5. NO KEY, NO DEDUPE. A request without an `Idempotency-Key` always creates a new charge. That
//      is what makes a lost key measurable rather than invisible.
//
// The recovery endpoint (`GET /charges?ref=…`) is modelled too, because "query, then decide" is the
// standard fallback and a claim that recommends it has to run it.
import type {
    Adapter,
    AdapterRequest,
    AdapterResponse,
    Clock,
} from '../../../../packages/core/src/types';

/** Stripe prunes an idempotency record after roughly this long. The default here, for the same reason. */
export const DEFAULT_KEY_TTL_MS = 24 * 60 * 60 * 1000;

/** A charge that actually exists at the vendor. The ledger of these IS the ground truth. */
export interface Charge {
    id: string;
    /** The caller's business reference (invoice / order id) — what a recovery query searches on. */
    ref: string;
    amount: number;
    currency: string;
    /** The idempotency key the creating request carried, or `undefined` when it carried none. */
    key: string | undefined;
    createdAt: number;
}

/** One stored idempotency record: the outcome of the FIRST request for a key. */
interface Record_ {
    key: string;
    status: number;
    body: unknown;
    /** The parameters the first request carried, rendered for comparison. */
    fingerprint: string;
    storedAt: number;
}

/** One request as the server saw it. The per-request spine several claims assert on. */
export interface PayCall {
    /** 1-based arrival order across the whole server lifetime — a restart does NOT reset it. */
    n: number;
    /**
     * 1-based order among CHARGE ATTEMPTS only (`POST`s), which is what the failure knobs count.
     * `undefined` on a recovery `GET`. Keeping this separate from `n` is what lets a workload be
     * described once and run against drivers that issue different numbers of recovery queries.
     */
    writeN: number | undefined;
    method: string;
    path: string;
    /** The `Idempotency-Key` header as it arrived, or `undefined` when absent. */
    key: string | undefined;
    status: number;
    /** True when this response came from a stored record rather than fresh processing. */
    replayed: boolean;
    /** True when this request created a row in the charge ledger. */
    createdCharge: boolean;
    /** True when the server processed the request and then never answered (the response was lost). */
    lost: boolean;
    at: number;
}

export interface FakePaymentsOptions {
    /** The clock `createdAt`/`storedAt` and TTL pruning read. Inject the stitch's clock. */
    clock: Clock;
    /** How long a stored record survives. Default {@link DEFAULT_KEY_TTL_MS}. */
    keyTtlMs?: number;
    /**
     * How the server decides two requests carry "the same parameters".
     * - `'canonical'` (default) — sorted-key JSON, so key ORDER is not a difference. This is what
     *   Stripe does, and it is the setting under which a re-serialised body is the CLIENT's problem.
     * - `'bytes'` — the raw serialisation, so any re-ordering is a mismatch. The stricter vendors.
     */
    compare?: 'canonical' | 'bytes';
    // The three failure knobs below count CHARGE ATTEMPTS (`POST`s), not HTTP requests — see
    // `PayCall.writeN`. A recovery `GET` therefore does not shift them, so the same workload
    // description drives a client that queries and one that does not. (It cost this file a wrong
    // result once: with the knobs on the global ordinal, adding a query-first `GET` moved "the first
    // charge attempt fails" onto the query and silently let the declined card through.)
    /**
     * 1-based CHARGE-ATTEMPT ordinals that are fully PROCESSED (charge created, record stored) and
     * then never answered. THE case: the money moved and the caller will never hear about it.
     */
    loseResponseOn?: readonly number[];
    /**
     * 1-based CHARGE-ATTEMPT ordinals that never reach processing at all — the connection dies on
     * the way out. Indistinguishable from `loseResponseOn` at the client, and the ledger proves it.
     */
    dropBeforeProcessingOn?: readonly number[];
    /**
     * 1-based CHARGE-ATTEMPT ordinals whose charge fails. The failure is stored and replayed like
     * any other outcome — that is the cached-failure case. No charge row is created.
     */
    failChargeOn?: readonly number[];
    /** Status for a failed charge. Default 500 (Stripe's own "we recorded a failure" case). */
    failStatus?: number;
}

/** Sorted-key JSON — the canonical rendering of a parameter set (recursively, arrays kept in order). */
export function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** The vendor's payment API, as a plain `Adapter`. `charges` is the ground truth; `calls` is the spine. */
export class FakePayments {
    /** THE GROUND TRUTH. Every claim's verdict is a statement about the length of this array. */
    readonly charges: Charge[] = [];
    readonly calls: PayCall[] = [];
    private readonly records = new Map<string, Record_>();
    private readonly clock: Clock;
    private readonly keyTtlMs: number;
    private readonly compare: 'canonical' | 'bytes';
    private readonly loseResponseOn: Set<number>;
    private readonly dropBeforeProcessingOn: Set<number>;
    private readonly failChargeOn: Set<number>;
    private readonly failStatus: number;
    private nextCharge = 1;
    /** Charge-attempt counter — what the failure knobs index on (see `PayCall.writeN`). */
    private writes = 0;

    constructor(opts: FakePaymentsOptions) {
        this.clock = opts.clock;
        this.keyTtlMs = opts.keyTtlMs ?? DEFAULT_KEY_TTL_MS;
        this.compare = opts.compare ?? 'canonical';
        this.loseResponseOn = new Set(opts.loseResponseOn ?? []);
        this.dropBeforeProcessingOn = new Set(
            opts.dropBeforeProcessingOn ?? [],
        );
        this.failChargeOn = new Set(opts.failChargeOn ?? []);
        this.failStatus = opts.failStatus ?? 500;
    }

    /** THE measurement. How many charges the vendor holds, whatever the client believes. */
    chargeCount(): number {
        return this.charges.length;
    }

    /** Every idempotency key that reached the server, in arrival order. Duplicates are the point. */
    keys(): (string | undefined)[] {
        return this.calls.map((c) => c.key);
    }

    /**
     * How many DISTINCT keys were seen — 1 across a whole workload is what restart-safety looks
     * like. Requests that carried NO key are excluded, so a recovery `GET` mixed into the ledger
     * does not read as an extra key; use {@link FakePayments.keys} to see absences.
     */
    distinctKeys(): number {
        return new Set(
            this.calls.filter((c) => c.key !== undefined).map((c) => c.key),
        ).size;
    }

    /** Status per request, in arrival order. */
    statuses(): number[] {
        return this.calls.map((c) => c.status);
    }

    /** Which requests were answered from a stored record rather than processed. */
    replays(): boolean[] {
        return this.calls.map((c) => c.replayed);
    }

    /** How many stored records are live right now (after pruning). Used by the TTL claim. */
    liveRecords(): number {
        this.prune();
        return this.records.size;
    }

    /** Drop every record past its TTL. Runs on every request, the way a real store's expiry would. */
    private prune(): void {
        const now = this.clock.now();
        for (const [k, r] of this.records)
            if (now - r.storedAt >= this.keyTtlMs) this.records.delete(k);
    }

    private fingerprint(body: unknown): string {
        return this.compare === 'canonical'
            ? canonicalJson(body)
            : JSON.stringify(body);
    }

    adapter(): Adapter {
        return async (req: AdapterRequest): Promise<AdapterResponse> => {
            const url = new URL(req.url);
            if (req.method === 'GET') return this.handleQuery(url);
            return this.handleCharge(req, url);
        };
    }

    /** `GET /charges?ref=…` — the recovery query. Authoritative: it reads the same ledger. */
    private handleQuery(url: URL): AdapterResponse {
        const ref = url.searchParams.get('ref');
        const found = this.charges.filter((c) => c.ref === ref);
        this.calls.push({
            n: this.calls.length + 1,
            method: 'GET',
            path: url.pathname,
            key: undefined,
            writeN: undefined,
            status: 200,
            replayed: false,
            createdCharge: false,
            lost: false,
            at: this.clock.now(),
        });
        return { status: 200, headers: {}, body: { data: found } };
    }

    private async handleCharge(
        req: AdapterRequest,
        url: URL,
    ): Promise<AdapterResponse> {
        this.prune();
        const n = this.calls.length + 1;
        const writeN = ++this.writes;
        const at = this.clock.now();
        // Header lookup is case-insensitive: the engine writes `Idempotency-Key`, a caller may pass
        // `idempotency-key` on the call's `headers`, and a real server would not care.
        const key = Object.entries(req.headers).find(
            ([h]) => h.toLowerCase() === 'idempotency-key',
        )?.[1];
        // Losing the response is a property of the NETWORK, not of what the server did — so it is
        // applied at every exit below, including a replay. (A replay whose response is lost is how
        // a retry loop burns its whole budget against a charge that already exists.)
        const lost = this.loseResponseOn.has(writeN);
        const answer = async (
            status: number,
            headers: Record<string, string>,
            body: unknown,
            replayed: boolean,
            createdCharge: boolean,
        ): Promise<AdapterResponse> => {
            this.calls.push({
                n,
                writeN,
                method: req.method,
                path: url.pathname,
                key,
                at,
                status,
                replayed,
                createdCharge,
                lost,
            });
            if (!lost) return { status, headers, body };
            await this.clock.sleep(Number.MAX_SAFE_INTEGER);
            throw new Error('unreachable: the response never arrives');
        };

        // (i) the connection dies before the server does anything. No charge, no record — and the
        //     client cannot tell this apart from (iv) below, which is the entire scenario.
        if (this.dropBeforeProcessingOn.has(writeN)) {
            this.calls.push({
                n,
                writeN,
                method: req.method,
                path: url.pathname,
                key,
                at,
                status: 0,
                replayed: false,
                createdCharge: false,
                lost: true,
            });
            await this.clock.sleep(Number.MAX_SAFE_INTEGER);
            throw new Error('unreachable: the connection never answers');
        }

        const params = req.body;
        const fingerprint = this.fingerprint(params);

        // (ii) a live record for this key: replay it, or reject a parameter mismatch.
        if (key !== undefined) {
            const existing = this.records.get(key);
            if (existing) {
                if (existing.fingerprint !== fingerprint) {
                    // Stripe's `idempotency_error`. Note what does NOT happen: no charge is created
                    // and the stored record is untouched. The FIRST body is still the one that ran.
                    return answer(
                        409,
                        {},
                        {
                            error: {
                                type: 'idempotency_error',
                                code: 'idempotency_key_in_use',
                                message:
                                    'Keys for idempotent requests can only be used with the same parameters they were first used with.',
                            },
                        },
                        false,
                        false,
                    );
                }
                return answer(
                    existing.status,
                    // The marker Stripe sets on a replay. Whether a client can ACT on it is C4.
                    { 'idempotent-replayed': 'true' },
                    existing.body,
                    true,
                    false,
                );
            }
        }

        // (iii) fresh processing. A failure is stored exactly like a success — that is the whole
        //       point of a cached failure — but creates no charge.
        const failing = this.failChargeOn.has(writeN);
        const p = (params ?? {}) as {
            ref?: string;
            amount?: number;
            currency?: string;
        };
        let status: number;
        let body: unknown;
        let createdCharge = false;
        if (failing) {
            status = this.failStatus;
            body = {
                error: {
                    type: 'card_error',
                    code: 'card_declined',
                    message: 'Your card was declined.',
                },
            };
        } else {
            const charge: Charge = {
                id: `ch_${String(this.nextCharge++).padStart(4, '0')}`,
                ref: p.ref ?? '(none)',
                amount: p.amount ?? 0,
                currency: p.currency ?? 'usd',
                key,
                createdAt: at,
            };
            this.charges.push(charge);
            createdCharge = true;
            status = 200;
            body = charge;
        }
        if (key !== undefined)
            this.records.set(key, {
                key,
                status,
                body,
                fingerprint,
                storedAt: at,
            });

        // (iv) THE CASE. Everything above already happened — the money moved, the record is stored
        //      — and `answer` may now swallow the response. The client will time out and know
        //      nothing, and `charges` will say otherwise.
        return answer(status, {}, body, false, createdCharge);
    }
}

/**
 * Run one call and reduce it to a short outcome token — `'ok'`, or `'<status>'` / `'<message>'` for
 * a failure. `PromiseLike`, not `Promise`: a stitch call returns a lazy `StitchResult` thenable.
 */
export async function outcomeOf(
    call: () => PromiseLike<unknown>,
): Promise<string> {
    try {
        await call();
        return 'ok';
    } catch (e) {
        const err = e as Error & { status?: number };
        return err.status === undefined ? err.message : String(err.status);
    }
}

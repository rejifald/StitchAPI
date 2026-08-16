// The vendor API every tenant calls, and the IdP that mints their tokens. Both are plain
// `Adapter`s over an injected {@link Clock} — no network, no timers of their own.
//
// The scenario's whole measurement is PER-TENANT, so the fake is built around that: a request is
// attributed to a tenant by an `x-tenant` header the caller sets, one named tenant can be made to
// fail persistently (`fail('bad', 401)`), and every request is recorded with its tenant, status
// and ARRIVAL TIME on the injected clock. "How many of the N healthy tenants also failed" and
// "when did the quiet tenant's call actually leave" are then both reads off `calls`.
//
// The tenant header is how a real multi-tenant fan-out identifies the customer to itself in a
// test double; in production the discriminator is the credential, which is what C6 measures.
import type {
    Adapter,
    AdapterRequest,
    Clock,
} from '../../../../packages/core/src/types';

/** One recorded request: who made it, what came back, and WHEN on the injected clock. */
export interface VendorCall {
    tenant: string;
    status: number;
    /** Virtual ms at which the request reached the vendor — the arrival time C4/C5 measure. */
    at: number;
    path: string;
    authorization: string;
}

export interface FakeVendorOptions {
    clock: Clock;
    /** Tenants that fail persistently, and with what status. */
    failing?: Record<string, number>;
    /** Body returned with a failing status. Default `{ error: 'invalid_token' }`. */
    failBody?: unknown;
    /**
     * Tenants whose requests take this many virtual ms to answer — a batch job's slow page. Used
     * by the `concurrency` half of the noisy-neighbour measurement, where the question is whether
     * one tenant's in-flight call holds a slot another tenant needs.
     */
    slow?: Record<string, number>;
}

/**
 * The vendor. `adapter()` is what a stitch/seam is handed; `calls` is the per-tenant ledger every
 * claim reads its numbers off.
 */
export class FakeVendor {
    readonly calls: VendorCall[] = [];
    private readonly clock: Clock;
    private readonly failing: Map<string, number>;
    private readonly failBody: unknown;
    private readonly slow: Map<string, number>;

    constructor(opts: FakeVendorOptions) {
        this.clock = opts.clock;
        this.failing = new Map(Object.entries(opts.failing ?? {}));
        this.failBody = opts.failBody ?? { error: 'invalid_token' };
        this.slow = new Map(Object.entries(opts.slow ?? {}));
    }

    /** Make one named tenant fail persistently from now on — a revoked token, a lost permission. */
    fail(tenant: string, status = 401): void {
        this.failing.set(tenant, status);
    }

    /** Heal a tenant (its credential was re-connected). */
    heal(tenant: string): void {
        this.failing.delete(tenant);
    }

    /** Requests attributed to one tenant. */
    forTenant(tenant: string): VendorCall[] {
        return this.calls.filter((c) => c.tenant === tenant);
    }

    /** Arrival times (virtual ms) of one tenant's requests — the noisy-neighbour measurement. */
    arrivals(tenant: string): number[] {
        return this.forTenant(tenant).map((c) => c.at);
    }

    adapter(): Adapter {
        return async (req: AdapterRequest) => {
            const tenant = req.headers['x-tenant'] ?? '<unattributed>';
            const status = this.failing.get(tenant) ?? 200;
            // Recorded on ARRIVAL, before any hold: `at` is when the request left the process,
            // which is the number the rate/concurrency claims measure.
            this.calls.push({
                tenant,
                status,
                at: this.clock.now(),
                path: new URL(req.url).pathname,
                authorization: req.headers['authorization'] ?? '',
            });
            const held = this.slow.get(tenant);
            if (held !== undefined) await this.clock.sleep(held);
            if (status >= 400)
                return { status, headers: {}, body: this.failBody };
            return {
                status: 200,
                headers: {},
                body: { ok: true, tenant, at: this.clock.now() },
            };
        };
    }
}

/**
 * The token endpoint. Mints a distinct, traceable token per request so C6 can tell whose token a
 * call carried — `tok-<client_id>-<n>`; `mints` counts how many token requests were made, which is
 * what "one tenant's refresh storm" is measured in.
 */
export class FakeIdp {
    mints = 0;
    /** client_ids seen on token requests — the evidence for whether a per-tenant CREDENTIAL got through. */
    readonly clientIds: string[] = [];

    adapter(): Adapter {
        return async (req: AdapterRequest) => {
            this.mints += 1;
            const body = (req.body ?? {}) as Record<string, string>;
            const clientId = body['client_id'] ?? '<none>';
            this.clientIds.push(clientId);
            return {
                status: 200,
                headers: {},
                body: {
                    access_token: `tok-${clientId}-${this.mints}`,
                    expires_in: 3600,
                },
            };
        };
    }
}

/**
 * Run one call and reduce it to a short outcome token — `'ok'`, or `'<status>'` for a failure.
 *
 * `PromiseLike`, not `Promise`: a stitch call returns a lazy `StitchResult` thenable that starts on
 * `.then` (stitch.ts:729,781), and it is deliberately not a full `Promise`.
 * Every blast-radius number in this scenario is a count over these tokens, so they are deliberately
 * tiny and printable as a sequence.
 */
export async function outcomeOf(
    call: () => PromiseLike<unknown>,
): Promise<string> {
    try {
        await call();
        return 'ok';
    } catch (e) {
        const err = e as Error & { status?: number };
        return String(err.status ?? err.name);
    }
}

/** How many of a measured outcome spine were not `'ok'` — the blast radius, as one number. */
export const blastRadius = (outcomes: readonly string[]): number =>
    outcomes.filter((o) => o !== 'ok').length;

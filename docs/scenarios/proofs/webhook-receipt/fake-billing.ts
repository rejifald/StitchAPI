// The provider, in both directions — because this scenario has two of them.
//
//   OUTBOUND (StitchAPI's half): a `GET /v1/subscriptions/:id` served through an `Adapter`, which
//   is the fetch-on-receipt call. It returns the CURRENT server truth, which is the entire reason
//   fetch-on-receipt fixes out-of-order delivery: the answer does not depend on which event
//   prompted the question.
//
//   INBOUND (not StitchAPI's half): `mintDelivery` produces the exact bytes a provider would POST
//   plus the `Stripe-Signature` header over those bytes. It signs a `Buffer` and hands back that
//   same `Buffer`, so a proof that verifies against a re-serialised object is verifying against
//   something the provider never signed — which is the bug C1 is about.
//
// Knobs are the ones the claims need and no more: `failNext` (transient status on a path, so the
// retry budget on the fetch-on-receipt stitch is measurable), `delayTicks` (hold a response for N
// microtask turns, so two concurrent handlers can be made to interleave deterministically), and
// `onRequest` (a hook the tests use to advance server state mid-flight).
import type {
    Adapter,
    AdapterRequest,
    AdapterResponse,
} from '../../../../packages/core/src/types';
import { signPayload } from './stripe-sig';

export interface Subscription {
    id: string;
    status: 'trialing' | 'active' | 'canceled';
    plan: 'free' | 'pro';
    /** Monotonic server version — the guard C4 needs to show fetch-on-receipt is not sufficient alone. */
    version: number;
}

/** The shape of a provider event as it arrives on the wire. */
export interface BillingEvent {
    id: string;
    type: string;
    created: number;
    data: { object: Subscription };
}

/** Exactly what lands on a webhook endpoint: raw bytes plus the header signed over them. */
export interface Delivery {
    raw: Buffer;
    signature: string;
    /** Convenience for the assertions — never used as the thing being verified. */
    eventId: string;
}

/**
 * Serialise an event and sign the resulting BYTES. The returned `raw` is the only correct input to
 * verification: re-`JSON.stringify`ing the parsed object gives logically identical JSON whose bytes
 * differ, which is the failure this scenario exists to demonstrate.
 */
export function mintDelivery(
    event: BillingEvent,
    secret: string,
    timestampSeconds: number,
    /** Whitespace/key-order the provider happened to emit. Defaults to compact, like a real one. */
    serialise: (e: BillingEvent) => string = (e) => JSON.stringify(e),
): Delivery {
    const raw = Buffer.from(serialise(event), 'utf8');
    return {
        raw,
        signature: signPayload(raw, secret, timestampSeconds),
        eventId: event.id,
    };
}

export class FakeBilling {
    static readonly baseUrl = 'https://api.billing.test';

    /** Every path the client actually requested, in arrival order. The fetch-on-receipt cost. */
    readonly requests: string[] = [];

    /** `Idempotency-Key` values seen on the downstream write — one per logical entitlement change. */
    readonly entitlementKeys: string[] = [];

    private readonly subs = new Map<string, Subscription>();
    private readonly failures = new Map<
        string,
        { times: number; status: number }
    >();
    private readonly delays = new Map<string, number>();
    /** Fires as a request ARRIVES, before the (possibly delayed) response is built. */
    onRequest?: (path: string) => void;

    setSubscription(sub: Subscription): void {
        this.subs.set(sub.id, sub);
    }

    get(id: string): Subscription | undefined {
        return this.subs.get(id);
    }

    /** Answer `path` with `status` the next `times` requests, then serve normally. */
    failNext(path: string, times: number, status: number): void {
        this.failures.set(path, { times, status });
    }

    /** Hold `path`'s response for `ticks` microtask turns so two handlers can be interleaved. */
    delayTicks(path: string, ticks: number): void {
        this.delays.set(path, ticks);
    }

    adapter(): Adapter {
        return async (req: AdapterRequest): Promise<AdapterResponse> => {
            const path = new URL(req.url).pathname;
            this.requests.push(path);
            this.onRequest?.(path);

            const ticks = this.delays.get(path) ?? 0;
            for (let i = 0; i < ticks; i++) await Promise.resolve();

            const failure = this.failures.get(path);
            if (failure && failure.times > 0) {
                failure.times--;
                return {
                    status: failure.status,
                    headers: {},
                    body: { error: { message: 'transient' } },
                };
            }

            // The downstream write the reaction half performs after it has the current state.
            // Records the `Idempotency-Key` so a duplicate that got past the ledger is visible.
            if (path === '/v1/entitlements' && req.method === 'POST') {
                const key =
                    req.headers['Idempotency-Key'] ??
                    req.headers['idempotency-key'];
                if (key !== undefined) this.entitlementKeys.push(key);
                return { status: 200, headers: {}, body: { applied: true } };
            }

            const match = /^\/v1\/subscriptions\/([^/]+)$/.exec(path);
            if (!match || req.method !== 'GET')
                return {
                    status: 404,
                    headers: {},
                    body: { error: { message: 'not_found' } },
                };
            const sub = this.subs.get(match[1] ?? '');
            if (!sub)
                return {
                    status: 404,
                    headers: {},
                    body: { error: { message: 'no such subscription' } },
                };
            // A snapshot, not the live object — a handler holding a response must not observe a
            // later mutation through it.
            return { status: 200, headers: {}, body: { ...sub } };
        };
    }
}

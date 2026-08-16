// The same behaviour with no library at all — the baseline C8 measures the assembled solution
// against.
//
// The comparison is only honest if the feature sets match, so this implements everything the
// assembled version gets from a stitch's declaration and not one thing more: per-provider auth
// headers, retry with a status set and a backoff, a per-provider circuit breaker with a cooldown,
// an error carrying `status` and the response body, response normalisation, lifecycle events for
// telemetry — and then the same routing on top (try in order, classify before moving on, name the
// provider that served it).
//
// It runs against the same `Adapter` the stitches do, so both sides in C8 talk to the same fake
// providers and their per-provider ledgers are directly comparable.
//
// The region between the markers is what C8 counts.
import type { Adapter, Clock } from '../../../../packages/core/src/types';

// <count:begin>
export interface HandLeg<T> {
    name: string;
    url: string;
    method: string;
    /** Static auth + content headers — the `auth` strategy's job, done by hand. */
    headers: Record<string, string>;
    adapter: Adapter;
    /** Response normalisation — the `pick`/`transform` job, done by hand. */
    pick?: (body: unknown) => T;
}

export interface HandEvent {
    leg: string;
    type: 'start' | 'result' | 'error';
    status?: number;
    attempt?: number;
}

export interface HandOptions {
    clock: Clock;
    attempts?: number;
    retryOn?: readonly number[];
    backoff?: number;
    circuit?: { failures: number; cooldown: number };
    failoverOn?: readonly number[];
    onEvent?: (e: HandEvent) => void;
}

export class HandError extends Error {
    readonly status: number | undefined;
    readonly body: unknown;
    constructor(message: string, status: number | undefined, body: unknown) {
        super(message);
        this.name = 'HandError';
        this.status = status;
        this.body = body;
    }
}

interface Breaker {
    failures: number;
    openedAt: number | null;
}

export function handRolled<T>(
    legs: readonly HandLeg<T>[],
    opts: HandOptions,
): (body: unknown) => Promise<{ provider: string; value: T }> {
    const breakers = new Map<string, Breaker>(
        legs.map((l) => [l.name, { failures: 0, openedAt: null }]),
    );
    const attempts = opts.attempts ?? 1;
    const retryOn = opts.retryOn ?? [429, 502, 503, 504];
    const failoverOn = opts.failoverOn ?? [408, 425, 429, 500, 502, 503, 504];

    async function one(leg: HandLeg<T>, body: unknown): Promise<T> {
        const b = breakers.get(leg.name)!;
        if (b.openedAt !== null) {
            if (opts.clock.now() - b.openedAt < (opts.circuit?.cooldown ?? 0))
                throw new HandError('circuit open', 503, undefined);
            b.openedAt = null;
            b.failures = 0;
        }
        let err: HandError | undefined;
        for (let attempt = 1; attempt <= attempts; attempt++) {
            opts.onEvent?.({ leg: leg.name, type: 'start', attempt });
            const res = await leg.adapter({
                url: leg.url,
                method: leg.method,
                headers: leg.headers,
                body,
            });
            if (res.status < 400) {
                b.failures = 0;
                opts.onEvent?.({
                    leg: leg.name,
                    type: 'result',
                    status: res.status,
                });
                return (leg.pick ? leg.pick(res.body) : res.body) as T;
            }
            err = new HandError(
                `${leg.name} ${res.status}`,
                res.status,
                res.body,
            );
            opts.onEvent?.({
                leg: leg.name,
                type: 'error',
                status: res.status,
            });
            if (!retryOn.includes(res.status) || attempt === attempts) break;
            await opts.clock.sleep(opts.backoff ?? 100);
        }
        b.failures += 1;
        if (opts.circuit && b.failures >= opts.circuit.failures)
            b.openedAt = opts.clock.now();
        throw err;
    }

    return async function call(body) {
        let last: unknown;
        for (const leg of legs) {
            try {
                return { provider: leg.name, value: await one(leg, body) };
            } catch (e) {
                if (!failoverOn.includes((e as HandError).status ?? 0)) throw e;
                last = e;
            }
        }
        throw last;
    };
}
// <count:end>

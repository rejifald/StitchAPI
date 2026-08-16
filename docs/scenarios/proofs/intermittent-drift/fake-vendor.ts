// The payment vendor rolling a response-shape change out to a percentage of its traffic.
//
// One `Adapter`, no network, no timers. The vendor serves a BASELINE body and can be told to serve
// a MUTATED one on a deterministic slice of calls — `rate: 0.05` means every 20th call, not a coin
// flip, so a 100-call run is byte-identical on every machine and "5 of 100" is a fact rather than
// an expectation.
//
// The five mutations are the industry change taxonomy (LinkedIn / Xandr breaking-change policies),
// one per class, plus the two halves of the type change that the scenario turns on:
//
//   'added'    — a field appears that the consumer does not model      (non-breaking)
//   'removed'  — a field the consumer depends on disappears            (breaking)
//   'retyped'  — `transaction_id` 12345 -> "12345", a PLAUSIBLE string (breaking, benign value)
//   'garbage'  — `transaction_id` -> "abc", a NON-NUMERIC string       (breaking, dangerous value)
//   'nulled'   — `transaction_id` -> null on the data that triggers it (nullable-without-notice)
//
// `retyped` and `garbage` differ only in the CONTENT of the string. They are the same wire-type
// shift, so anything that classifies by type sees one class; the caller sees `12345` in one and a
// $0 charge in the other. Keeping them as separate named mutations is the whole point of the file.
import type {
    Adapter,
    AdapterRequest,
    AdapterResponse,
} from '../../../../packages/core/src/types';

/** The payment body a caller has been consuming since the integration was written. */
export interface Charge {
    transaction_id: number;
    amount: number;
    currency: string;
    status: string;
}

/** What the vendor's canary is doing to the shape on the calls it touches. */
export type Mutation =
    'none' | 'added' | 'removed' | 'retyped' | 'garbage' | 'nulled';

export interface FakeVendorOptions {
    /** What the canary does on the calls it touches. Default `'none'`. */
    mutation?: Mutation;
    /**
     * Fraction of calls the canary touches, 0..1. Deterministic, not random: with `rate` = 1/N
     * every Nth call is mutated. `1` mutates every call (a completed rollout), `0` none.
     */
    rate?: number;
    /** Which field the `removed` / `added` mutations act on. Default `'currency'` / `'settlement_delay_ms'`. */
    field?: string;
}

/** One recorded request and the shape the vendor chose to serve it. */
export interface VendorCall {
    n: number;
    mutated: boolean;
    body: Record<string, unknown>;
}

/**
 * The vendor. `adapter()` is what a stitch is handed; `calls` is the ledger every rate claim reads
 * its GROUND TRUTH off — `vendor.mutatedCount` is how many responses actually carried the new
 * shape, which is the number a measured drift rate has to be checked against.
 */
export class FakeVendor {
    readonly calls: VendorCall[] = [];
    private n = 0;
    private readonly mutation: Mutation;
    private readonly period: number;
    private readonly field: string | undefined;

    constructor(opts: FakeVendorOptions = {}) {
        this.mutation = opts.mutation ?? 'none';
        const rate = opts.rate ?? 1;
        // `period` is "one in every P calls". rate 0.05 -> 20, rate 1 -> 1, rate 0 -> never.
        this.period =
            rate <= 0 ? Number.POSITIVE_INFINITY : Math.round(1 / rate);
        this.field = opts.field;
    }

    /** How many served responses actually carried the mutated shape. The ground truth for a rate. */
    get mutatedCount(): number {
        return this.calls.filter((c) => c.mutated).length;
    }

    /** 1-based indices of the calls the canary touched — `[20,40,60,80,100]` for 5% over 100. */
    get mutatedAt(): number[] {
        return this.calls.filter((c) => c.mutated).map((c) => c.n);
    }

    private baseline(n: number): Record<string, unknown> {
        return {
            transaction_id: 100000 + n,
            amount: 4200,
            currency: 'usd',
            status: 'succeeded',
        };
    }

    private mutate(body: Record<string, unknown>): Record<string, unknown> {
        const out = { ...body };
        switch (this.mutation) {
            case 'added':
                // A vendor release adds a field. Non-breaking by every published policy.
                out[this.field ?? 'settlement_delay_ms'] = 900;
                return out;
            case 'removed':
                delete out[this.field ?? 'currency'];
                return out;
            case 'retyped':
                // int -> string, and the string still spells the same integer.
                out['transaction_id'] = String(out['transaction_id']);
                return out;
            case 'garbage':
                // int -> string, and the string is not a number at all. Same wire-type shift.
                out['transaction_id'] = 'abc';
                return out;
            case 'nulled':
                out['transaction_id'] = null;
                return out;
            case 'none':
                return out;
        }
    }

    adapter(): Adapter {
        return async (_req: AdapterRequest): Promise<AdapterResponse> => {
            this.n += 1;
            const n = this.n;
            const mutated = n % this.period === 0;
            const body = mutated
                ? this.mutate(this.baseline(n))
                : this.baseline(n);
            this.calls.push({ n, mutated, body });
            return { status: 200, headers: {}, body };
        };
    }
}

/**
 * A vendor that serves ONE fixed body — the single-response probes C1/C2/C3/C7 use, where the
 * question is "what does this exact shape produce" and a rate would be noise.
 */
export const serving =
    (body: unknown): Adapter =>
    async (_req: AdapterRequest): Promise<AdapterResponse> => ({
        status: 200,
        headers: {},
        body,
    });

/** A drift finding rendered as one comparable string — the spine every claim asserts on. */
export const fmt = (f: {
    level: string;
    change: string;
    path: string;
    detail?: string;
}): string => `${f.level}|${f.change}|${f.path}|${f.detail ?? ''}`;

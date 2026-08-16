// The vendor, and the fixture that was recorded from it six months ago.
//
// The whole scenario lives in the gap between two objects, so they are both here and both literal:
//
//   RECORDED_2026_02_04  — what `GET /v1/invoices/{id}` returned on the day someone ran the
//                          recorder. This is the cassette. It never changes again.
//   VENDOR_TODAY         — what the same endpoint returns now. `amount_cents` became `amount`
//                          (a rename), `legacy_ref` was dropped (a removal), `paid` became a
//                          string enum (a retype), and `customer_email` is now sometimes `null`.
//
// Both are plain data. Nothing in this file imports the library's testing kit — the point of C1 is
// to ask whether the LIBRARY can tell these two apart, so the fixtures must not be built by
// anything that already knows the answer.
//
// `vendorAdapter()` is the only moving part: a hand-written in-memory `Adapter` that serves one of
// these bodies and records every request it saw. It is deliberately NOT `mockAdapter` — C3 puts
// `mockAdapter` itself under test, and a proof that used it everywhere could not measure it.
import type {
    Adapter,
    AdapterRequest,
    AdapterResponse,
} from '../../../../packages/core/src/types';

/** The day the cassette was cut. Carried as a literal because C1(f) asks who else knows it. */
export const RECORDED_ON = '2026-02-04';

/** The cassette: the exact response body the recorder captured, six months before today. */
export const RECORDED_2026_02_04 = {
    id: 'inv_9f2',
    amount_cents: 4200,
    currency: 'usd',
    paid: true,
    customer_email: 'ada@example.com',
    legacy_ref: 'REF-118',
} as const;

/** What the vendor returns today. Four independent changes from the cassette. */
export const VENDOR_TODAY = {
    id: 'inv_9f2',
    amount: 4200, // RENAMED from `amount_cents`
    currency: 'usd',
    paid: 'paid', // RETYPED from boolean to a string enum
    customer_email: null, // NULLED — now absent for invoices without a contact
    // `legacy_ref` REMOVED
} as const;

/** The four drift shapes C1 walks, each as a body derived from the cassette. */
export const MUTATIONS = {
    /** `legacy_ref` is gone. */
    removed: {
        id: 'inv_9f2',
        amount_cents: 4200,
        currency: 'usd',
        paid: true,
        customer_email: 'ada@example.com',
    },
    /** `amount_cents` is now `amount`. */
    renamed: {
        id: 'inv_9f2',
        amount: 4200,
        currency: 'usd',
        paid: true,
        customer_email: 'ada@example.com',
        legacy_ref: 'REF-118',
    },
    /** `paid` is now a string. */
    retyped: {
        id: 'inv_9f2',
        amount_cents: 4200,
        currency: 'usd',
        paid: 'paid',
        customer_email: 'ada@example.com',
        legacy_ref: 'REF-118',
    },
    /** `customer_email` is now `null`. */
    nulled: {
        id: 'inv_9f2',
        amount_cents: 4200,
        currency: 'usd',
        paid: true,
        customer_email: null,
        legacy_ref: 'REF-118',
    },
} as const;

export const BASE = 'https://api.billing.test';

/** An in-memory transport serving one fixed body, with a request log. */
export interface FakeVendor extends Adapter {
    /** Every request the transport received. */
    readonly seen: AdapterRequest[];
    /** How many requests it received. */
    count(): number;
}

/**
 * A hand-written {@link Adapter} that answers every request with `body` at `status`. No routing, no
 * sequences — the scripts that need those reach for the real `mockAdapter`, which is the point of
 * C3. `delayMs` is honoured against the request signal so a per-attempt `timeout` can cancel it.
 */
export function vendorAdapter(
    body: unknown,
    opts: {
        status?: number;
        headers?: Record<string, string>;
        delayMs?: number;
    } = {},
): FakeVendor {
    const seen: AdapterRequest[] = [];
    const fn = (async (req: AdapterRequest): Promise<AdapterResponse> => {
        seen.push(req);
        if (opts.delayMs !== undefined && opts.delayMs > 0) {
            await new Promise<void>((resolve, reject) => {
                const t = setTimeout(resolve, opts.delayMs);
                req.signal?.addEventListener(
                    'abort',
                    () => {
                        clearTimeout(t);
                        reject(new Error('aborted'));
                    },
                    { once: true },
                );
            });
        }
        return {
            status: opts.status ?? 200,
            headers: opts.headers ?? { 'content-type': 'application/json' },
            body,
        };
    }) as FakeVendor;
    Object.defineProperty(fn, 'seen', { value: seen });
    fn.count = () => seen.length;
    return fn;
}

/**
 * A transport that answers with a SEQUENCE of `[status, body]` pairs (the last entry repeats) — the
 * flaky-endpoint shape C4 needs, hand-written for the same reason as {@link vendorAdapter}.
 */
export function sequenceAdapter(
    steps: readonly (readonly [number, unknown])[],
    headersFor?: (i: number) => Record<string, string>,
): FakeVendor {
    const seen: AdapterRequest[] = [];
    const fn = (async (req: AdapterRequest): Promise<AdapterResponse> => {
        const i = seen.length;
        seen.push(req);
        const step = steps[Math.min(i, steps.length - 1)] as readonly [
            number,
            unknown,
        ];
        return {
            status: step[0],
            headers: headersFor?.(i) ?? { 'content-type': 'application/json' },
            body: step[1],
        };
    }) as FakeVendor;
    Object.defineProperty(fn, 'seen', { value: seen });
    fn.count = () => seen.length;
    return fn;
}

/** Render a `DriftFinding` as `level|change|path|detail` — the format `intermittent-drift` uses. */
export function fmt(f: {
    level?: string;
    change?: string;
    path?: string;
    detail?: string;
    message?: string;
}): string {
    return [
        f.level ?? '?',
        f.change ?? '?',
        f.path ?? '',
        f.detail ?? f.message ?? '',
    ].join('|');
}

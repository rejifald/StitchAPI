// The fake vendor every claim in this directory calls. Two API versions on ONE host, because that
// is the situation: `api.vendor.test` is retiring `/v1` and you are the consumer, so both the
// primary and the shadow spend the SAME meter, hit the SAME breaker key material, and share the
// SAME origin. A fake pointing v2 at a second host would have quietly dissolved half the scenario.
//
// Everything is in-memory. The transport is a plain `Adapter` — `(req) => Promise<res>` — which is
// the only thing in the process that can observe a request, so every count in this directory is
// taken from `log` here rather than from a config's stated intent.
//
// WHAT THE TWO VERSIONS DISAGREE ABOUT (C2 and C4 both live off this):
//
//   input   v1: GET /v1/customers/{id}          — the id is a PATH parameter
//           v2: GET /v2/customers?customer_id=  — the id moved to a QUERY parameter, renamed
//   output  v1: `created` epoch int, `tags` in one order, no `livemode`
//           v2: `created_at` ISO string, `tags` reordered, `livemode` added
//                ... and ONE genuine regression planted in `balance_cents` (C4).
//
// The regression is a transposition (41250 -> 41520), not a null or a missing field: a wrong VALUE
// of the right type at the right path is the diff a schema cannot catch and the one a dual-run
// exists to find.
import type {
    Adapter,
    AdapterRequest,
    AdapterResponse,
} from '../../../../packages/core/src/types';

export const HOST = 'https://api.vendor.test';

// ---- the payloads ----------------------------------------------------------

/**
 * The epoch second v1 reports, and the instant v2 spells as ISO. THE SAME MOMENT, two wire types —
 * which is the whole point of the retype: a correct v2 changes the encoding and not the value, so
 * any comparator that flags this is producing noise. (`1785888000 === Date.parse(CREATED_ISO)/1000`;
 * C4 asserts the round-trip rather than trusting the pair.)
 */
export const CREATED_EPOCH = 1_785_888_000;
export const CREATED_ISO = '2026-08-05T00:00:00.000Z';

/** What the customer's balance really is. v1 reports it correctly. */
export const TRUE_BALANCE = 41_250;
/** What v2 reports — two digits transposed. THE regression this whole technique exists to catch. */
export const REGRESSED_BALANCE = 41_520;

export function v1Customer(id = 'cus_7Q2'): Record<string, unknown> {
    return {
        id,
        name: 'Wilhelmina Ashcombe',
        created: CREATED_EPOCH,
        balance_cents: TRUE_BALANCE,
        currency: 'gbp',
        tags: ['enterprise', 'eu', 'invoiced'],
        address: {
            line1: '4 Ashcombe Mews',
            city: 'London',
            postal: 'EC1A 1BB',
        },
    };
}

export function v2Customer(id = 'cus_7Q2'): Record<string, unknown> {
    return {
        id,
        name: 'Wilhelmina Ashcombe',
        // RENAME + RETYPE: `created` (epoch int) became `created_at` (ISO string).
        created_at: CREATED_ISO,
        // THE REGRESSION. Right path, right type, wrong number.
        balance_cents: REGRESSED_BALANCE,
        currency: 'gbp',
        // REORDER: the same three tags, a different order.
        tags: ['eu', 'invoiced', 'enterprise'],
        address: {
            line1: '4 Ashcombe Mews',
            city: 'London',
            postal: 'EC1A 1BB',
        },
        // NEW FIELD.
        livemode: true,
    };
}

/** A v2 response with the regression corrected — the "diff is quiet, cut over" end state. */
export function v2CustomerFixed(id = 'cus_7Q2'): Record<string, unknown> {
    return { ...v2Customer(id), balance_cents: TRUE_BALANCE };
}

// ---- the request ledger ----------------------------------------------------

export interface VendorCall {
    /** `'v1'`, `'v2'`, or `'?'` when the URL matched neither prefix. */
    version: 'v1' | 'v2' | '?';
    method: string;
    /** The full URL the transport was handed, query string included. */
    url: string;
    /** Path + query only — the part a URL assertion should read. */
    pathQuery: string;
    body?: unknown;
    /** Wall-clock ms since the vendor was created, for ordering. */
    at: number;
    /**
     * Did this request run to completion, or was it ABORTED in flight? The fake honours
     * `req.signal` during its latency wait, so a combinator that auto-cancels its losers is
     * measurable here rather than inferred. `false` until the response is returned.
     */
    completed: boolean;
    /** Set when the request was cut short by `req.signal`. C1 (c) reads this. */
    aborted?: boolean;
}

export interface VendorOptions {
    /** Real milliseconds this version's endpoint takes to answer. Default 0. */
    latency?: { v1?: number; v2?: number };
    /**
     * Answer v2 reads with the CORRECTED body ({@link v2CustomerFixed}) instead of the regressed
     * one — the "diff has gone quiet, cut over" end state. C8 measures both ends with one vendor.
     */
    v2Fixed?: boolean;
    /**
     * Statuses to answer with, consumed in order, per version. `[500, 500, 200]` fails twice then
     * succeeds. Anything past the end of the list answers 200. A `0` means "reject at the transport"
     * (a connection error) rather than answer with a status.
     */
    statuses?: { v1?: number[]; v2?: number[] };
}

export interface FakeVendor {
    adapter: Adapter;
    /** Every request the transport actually received, in order. */
    log: VendorCall[];
    /** How many requests this version's endpoints received. */
    count(version: 'v1' | 'v2'): number;
    /** Requests of a given method this version received — the C5 measurement. */
    countMethod(version: 'v1' | 'v2', method: string): number;
    /** The path+query of the Nth request to a version, for a literal URL assertion. */
    pathOf(version: 'v1' | 'v2', n?: number): string;
    reset(): void;
}

/**
 * Build the fake vendor. The adapter never throws on a non-2xx (ADR 0005) — it answers with the
 * status, which is what a real transport does and what the engine's retry/circuit stages read. The
 * one exception is a scripted `0`, which rejects: a connection error is a different failure mode
 * and C1 (d) needs both.
 */
export function fakeVendor(opts: VendorOptions = {}): FakeVendor {
    const log: VendorCall[] = [];
    const started = Date.now();
    const pending: Record<'v1' | 'v2', number[]> = {
        v1: [...(opts.statuses?.v1 ?? [])],
        v2: [...(opts.statuses?.v2 ?? [])],
    };

    const adapter: Adapter = async (req: AdapterRequest) => {
        const u = new URL(req.url);
        const version: 'v1' | 'v2' | '?' = u.pathname.startsWith('/v1')
            ? 'v1'
            : u.pathname.startsWith('/v2')
              ? 'v2'
              : '?';
        const entry: VendorCall = {
            version,
            method: req.method,
            url: req.url,
            pathQuery: u.pathname + u.search,
            body: req.body,
            at: Date.now() - started,
            completed: false,
        };
        log.push(entry);

        const wait =
            version === 'v1'
                ? (opts.latency?.v1 ?? 0)
                : version === 'v2'
                  ? (opts.latency?.v2 ?? 0)
                  : 0;
        // REAL time. Caller-observed latency is wall-clock by definition (see harness.ts).
        // The wait honours `req.signal` so an auto-cancelled member is MEASURED (`aborted: true`)
        // rather than assumed — a combinator that aborts its losers is a C1 (c) finding.
        if (wait > 0)
            await new Promise<void>((resolve, reject) => {
                const t = setTimeout(resolve, wait);
                req.signal?.addEventListener(
                    'abort',
                    () => {
                        clearTimeout(t);
                        entry.aborted = true;
                        reject(new Error('aborted by signal'));
                    },
                    { once: true },
                );
            });

        const scripted =
            version === '?' ? undefined : (pending[version].shift() ?? 200);
        if (scripted === 0)
            throw new Error(`ECONNRESET ${version} ${u.pathname}`);

        const status = scripted ?? 200;
        if (status !== 200)
            return {
                status,
                headers: { 'content-type': 'application/json' },
                body: { error: `vendor ${version} says ${status}` },
            } satisfies AdapterResponse;

        const id = String(
            u.searchParams.get('customer_id') ??
                u.pathname.split('/').pop() ??
                'cus_7Q2',
        );
        // A write answers with a receipt; a read answers with the version's customer shape.
        const body =
            req.method === 'GET' || req.method === 'HEAD'
                ? version === 'v2'
                    ? opts.v2Fixed
                        ? v2CustomerFixed(id)
                        : v2Customer(id)
                    : v1Customer(id)
                : { ok: true, charged: true, version, received: req.body };
        entry.completed = true;
        return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body,
        } satisfies AdapterResponse;
    };

    return {
        adapter,
        log,
        count: (v) => log.filter((c) => c.version === v).length,
        countMethod: (v, m) =>
            log.filter((c) => c.version === v && c.method === m).length,
        pathOf: (v, n = 0) =>
            log.filter((c) => c.version === v)[n]?.pathQuery ?? '<none>',
        reset() {
            log.length = 0;
            pending.v1 = [...(opts.statuses?.v1 ?? [])];
            pending.v2 = [...(opts.statuses?.v2 ?? [])];
        },
    };
}

/**
 * Wall-clock elapsed of an async thunk, in whole milliseconds. Real time, deliberately.
 *
 * The parameter is `PromiseLike<T>`, not `Promise<T>`, because a bare stitch call returns a
 * `StitchResult` — a lazy `PromiseLike` (types.ts:1905) that lacks `Symbol.toStringTag` and so is
 * not assignable to `Promise`. That distinction is itself a C1 (b) finding, not a typing nuisance.
 */
export async function elapsed<T>(
    fn: () => PromiseLike<T>,
): Promise<{ ms: number; value?: T; error?: unknown }> {
    const t0 = performance.now();
    try {
        const value = await fn();
        return { ms: Math.round(performance.now() - t0), value };
    } catch (error) {
        return { ms: Math.round(performance.now() - t0), error };
    }
}

/** A deterministic PRNG so C7's sampling measurement is a number, not a coin flip. */
export function seededRandom(seed = 1): () => number {
    let s = seed >>> 0;
    return () => {
        // xorshift32 — small, deterministic, and good enough to sample a percentage.
        s ^= s << 13;
        s >>>= 0;
        s ^= s >> 17;
        s ^= s << 5;
        s >>>= 0;
        return s / 0x1_0000_0000;
    };
}

// The vendor. Five endpoints, three of them retiring, and every response is a `200`.
//
// That last part is the scenario: nothing here ever fails, so the fleet looks perfectly healthy from
// every angle except the one nobody reads. The retirement notices live ONLY in `Deprecation`
// (RFC 9745) and `Sunset` (RFC 8594) headers riding successful responses.
//
// Three header spellings are served on purpose, because a client that parses one and not the others
// gets a fraction of the picture:
//
//   `Deprecation: @1735689600`                        RFC 9745 structured-field date (an sf-integer
//                                                     with an `@` sigil — seconds, not ms)
//   `Deprecation: Wed, 01 Jan 2025 00:00:00 GMT`      the pre-RFC draft spelling, an HTTP-date, still
//                                                     what several large vendors actually emit
//   `Sunset: Wed, 01 Jan 2026 00:00:00 GMT`           RFC 8594, always an HTTP-date
//
// `Link: <...>; rel="successor-version"` rides along on the deprecated endpoints because RFC 9745
// pairs it with `Deprecation`, and because it is the one part of the notice that says what to DO.
//
// The clock is injected so "the sunset has passed" is a deterministic fact rather than a wall-clock
// accident: every script pins NOW to 2025-12-20T00:00:00Z, which puts `users` exactly 12 days from
// its sunset.
import type {
    Adapter,
    AdapterResponse,
} from '../../../../packages/core/src/types';

/** Frozen "today" for every script in this directory: 2025-12-20T00:00:00Z. */
export const NOW = Date.parse('2025-12-20T00:00:00Z');

/** A day in ms — the unit every sunset countdown in this directory is quoted in. */
export const DAY = 86_400_000;

/**
 * One vendor endpoint: the body it serves and the retirement notice it attaches (if any).
 *
 * `deprecation` and `sunset` are stored as the LITERAL header values the vendor sends, not as
 * timestamps, because the parsing of those literals is what C6 is measuring. Storing them parsed
 * would quietly do the work under test.
 */
export interface Endpoint {
    /** Path under the base URL, and the `name` the stitch is given. */
    name: string;
    path: string;
    body: unknown;
    /** Literal `Deprecation` header value — sf-date (`@1735689600`) or an HTTP-date. */
    deprecation?: string;
    /** Literal `Sunset` header value — always an HTTP-date (RFC 8594). */
    sunset?: string;
    /** Literal `Link` header value announcing the successor. */
    successor?: string;
}

/**
 * The fleet. Three deprecated, two clean, and the deprecated three deliberately disagree about how
 * to spell `Deprecation`.
 *
 * Sunset dates relative to the frozen NOW (2025-12-20):
 *   users     2026-01-01   12 days   ← the earliest, and the one a fleet report must surface first
 *   search    2026-03-15   85 days
 *   orders    2026-06-01  163 days
 */
export const FLEET: readonly Endpoint[] = [
    {
        name: 'users',
        path: '/v1/users',
        body: { users: [{ id: 1, name: 'Ada' }] },
        // RFC 9745 structured-field date: `@` + seconds since the epoch. 2025-01-01T00:00:00Z.
        deprecation: '@1735689600',
        sunset: 'Thu, 01 Jan 2026 00:00:00 GMT',
        successor:
            '<https://api.vendor.test/v2/users>; rel="successor-version"',
    },
    {
        name: 'search',
        path: '/v1/search',
        body: { hits: 3 },
        // The pre-RFC draft spelling: an HTTP-date in the SAME header. Real vendors send this.
        deprecation: 'Sat, 01 Mar 2025 00:00:00 GMT',
        sunset: 'Sun, 15 Mar 2026 00:00:00 GMT',
    },
    {
        name: 'orders',
        path: '/v1/orders',
        body: { orders: [{ id: 'o-1' }] },
        deprecation: '@1751328000',
        sunset: 'Mon, 01 Jun 2026 00:00:00 GMT',
        successor:
            '<https://api.vendor.test/v2/orders>; rel="successor-version"',
    },
    { name: 'payments', path: '/v1/payments', body: { balance: 100 } },
    { name: 'webhooks', path: '/v1/webhooks', body: { subscribed: true } },
];

/** Look a fleet member up by name; throws rather than serving a silent 404 in a proof. */
export function endpoint(name: string): Endpoint {
    const found = FLEET.find((e) => e.name === name);
    if (!found) throw new Error(`no such endpoint: ${name}`);
    return found;
}

export const BASE = 'https://api.vendor.test';

/**
 * The vendor as an `Adapter`. Routes on the request URL's path, counts requests per endpoint, and
 * always answers `200`.
 *
 * `headersFor` is exported separately so a script can assert what the wire carried without going
 * through a stitch — the difference between "the vendor sent it" and "an accessor could see it" is
 * the whole scenario, and conflating them would beg the question.
 */
export class FakeVendor {
    /** Requests served, per endpoint name. */
    readonly requests = new Map<string, number>();

    adapter(): Adapter {
        return async (req): Promise<AdapterResponse> => {
            const path = new URL(req.url).pathname;
            const hit = FLEET.find((e) => e.path === path);
            if (!hit) throw new Error(`fake vendor: unrouted path ${path}`);
            this.requests.set(hit.name, (this.requests.get(hit.name) ?? 0) + 1);
            return {
                status: 200,
                headers: headersFor(hit),
                body: hit.body,
            };
        };
    }

    /** Total requests served across the fleet. */
    get total(): number {
        return [...this.requests.values()].reduce((a, b) => a + b, 0);
    }
}

/**
 * The header map one endpoint puts on the wire. Lowercased keys, because that is what every HTTP
 * client normalises to and what `AdapterResponse.headers` carries in practice (the engine reads
 * `res.headers['retry-after']` lowercased at engine.ts:750).
 */
export function headersFor(e: Endpoint): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (e.deprecation !== undefined) h['deprecation'] = e.deprecation;
    if (e.sunset !== undefined) h['sunset'] = e.sunset;
    if (e.successor !== undefined) h['link'] = e.successor;
    return h;
}

/** A one-endpoint adapter, for the scripts that only need a single response shape. */
export function serving(e: Endpoint): Adapter {
    return async (): Promise<AdapterResponse> => ({
        status: 200,
        headers: headersFor(e),
        body: e.body,
    });
}

import {
    type StitchErrorLike,
    StitchExceptionFilter,
    stitchError,
} from '../src';
import * as api from '../src';

import { type ArgumentsHost, HttpException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

// Mirror what core throws on a failed call (packages/core/src/stitch.ts).
const makeStitchError = (message: string, status?: number): Error => {
    const e = new Error(message) as Error & { status?: number };
    e.name = 'StitchError';
    if (status !== undefined) e.status = status;
    return e;
};

describe('stitchError.is', () => {
    it('recognises the branded error and rejects everything else', () => {
        expect(stitchError.is(makeStitchError('x', 500))).toBe(true);
        expect(stitchError.is(new Error('plain'))).toBe(false);
        expect(stitchError.is('nope')).toBe(false);
        expect(stitchError.is(undefined)).toBe(false);
    });
});

describe('stitchError.map', () => {
    it('maps every upstream failure to 502 by default, ignoring the upstream status', () => {
        const ex = stitchError.map(makeStitchError('rate limited', 429));
        expect(ex).toBeInstanceOf(HttpException);
        expect(ex!.getStatus()).toBe(502);
        // the raw message is withheld by default (see the leak-regression block below)
        expect(ex!.message).toBe('Upstream request failed');
        // a network error / timeout (no upstream status) → 502 too
        expect(
            stitchError.map(makeStitchError('ECONNRESET'))!.getStatus(),
        ).toBe(502);
    });

    it('accepts a fixed status override', () => {
        expect(
            stitchError
                .map(makeStitchError('boom', 500), {
                    status: 503,
                })!
                .getStatus(),
        ).toBe(503);
    });

    it('accepts a status function for custom mapping (e.g. propagate the upstream status)', () => {
        const status = (e: StitchErrorLike) => e.status ?? 502;
        expect(
            stitchError
                .map(makeStitchError('rate limited', 429), {
                    status,
                })!
                .getStatus(),
        ).toBe(429);
        expect(
            stitchError
                .map(makeStitchError('timeout'), { status })!
                .getStatus(),
        ).toBe(502);
    });

    it('returns undefined for a non-stitch error (so the caller can rethrow)', () => {
        expect(stitchError.map(new Error('other'))).toBeUndefined();
    });

    // Regression: the default response body must not echo the raw upstream/transport
    // message, which can disclose internal network topology or the upstream's status
    // semantics to an untrusted client.
    describe('does not leak the raw error message by default', () => {
        const bodyOf = (ex: HttpException): string =>
            JSON.stringify(ex.getResponse());

        it('a transport failure with an internal hostname is not disclosed', () => {
            const ex = stitchError.map(
                makeStitchError('getaddrinfo ENOTFOUND payments.internal.corp'),
            )!;
            expect(ex.getStatus()).toBe(502);
            const body = bodyOf(ex);
            expect(body).not.toContain('payments.internal.corp');
            expect(body).not.toContain('ENOTFOUND');
            expect(ex.message).not.toContain('payments.internal.corp');
        });

        it("an upstream 401 does not surface as 'HTTP 401' in the body", () => {
            const ex = stitchError.map(makeStitchError('HTTP 401', 401))!;
            expect(ex.getStatus()).toBe(502); // remapped, not the upstream 401
            expect(bodyOf(ex)).not.toContain('HTTP 401');
        });

        it('still exposes the original error as `cause` for server-side logging', () => {
            const original = makeStitchError(
                'getaddrinfo ENOTFOUND payments.internal.corp',
            );
            const ex = stitchError.map(original)!;
            expect(ex.cause).toBe(original);
        });

        it('opt-in `body` can echo the raw message when the caller chooses to', () => {
            const ex = stitchError.map(
                makeStitchError('getaddrinfo ENOTFOUND payments.internal.corp'),
                { body: (e) => ({ error: e.message }) },
            )!;
            expect(bodyOf(ex)).toContain('payments.internal.corp');
        });

        it('`body` shapes a caller-chosen error envelope, receiving the mapped status', () => {
            const ex = stitchError.map(makeStitchError('HTTP 401', 401), {
                body: (_e, status) => ({
                    error: 'Payment provider unavailable',
                    status,
                }),
            })!;
            expect(ex.getResponse()).toEqual({
                error: 'Payment provider unavailable',
                status: 502, // the mapped status, not the upstream 401
            });
            expect(bodyOf(ex)).not.toContain('HTTP 401');
        });
    });
});

describe('StitchExceptionFilter', () => {
    // Run a filter against a patched base `catch` (what `super.catch` resolves to at call
    // time) and capture what it delegates — asserts the mapping without a real adapter.
    const captureDelegated = (
        filter: StitchExceptionFilter,
        ...errs: unknown[]
    ): unknown[] => {
        const seen: unknown[] = [];
        const baseProto = BaseExceptionFilter.prototype as {
            catch: (e: unknown, h: ArgumentsHost) => void;
        };
        const orig = baseProto.catch;
        baseProto.catch = function (e: unknown): void {
            seen.push(e);
        };
        try {
            for (const e of errs) filter.catch(e, {} as ArgumentsHost);
        } finally {
            baseProto.catch = orig;
        }
        return seen;
    };

    it('maps a StitchError to a 502 HttpException by default; passes others through', () => {
        const other = new Error('other');
        const seen = captureDelegated(
            new StitchExceptionFilter(),
            makeStitchError('boom', 503),
            other,
        );
        expect(seen[0]).toBeInstanceOf(HttpException);
        expect((seen[0] as HttpException).getStatus()).toBe(502); // not the upstream 503
        expect(seen[1]).toBe(other); // untouched passthrough
    });

    it('forwards status options to the mapper', () => {
        const seen = captureDelegated(
            new StitchExceptionFilter(undefined, {
                status: (e) => e.status ?? 502,
            }),
            makeStitchError('boom', 503),
        );
        expect((seen[0] as HttpException).getStatus()).toBe(503); // propagated via options
    });
});

// --- public-surface pin: the error family is ONE namespace -------------------
//
// This package has no dedicated public-surface spec (only core does), so the pin lives here,
// beside the behaviour it guards. It mirrors the intent of core's `REMOVED_SECRET_FUNCTIONS`
// in `packages/core/test/public-api-surface.spec.ts`, in both directions:
//
//  - PRESENT, as a WHOLE: `stitchError` is an OBJECT whose members are exactly `is` and `map` (no `handler`: Nest registers a
//    filter INSTANCE through DI, so the handler stays the `StitchExceptionFilter` class).
//    The key set is pinned rather than each member independently, so adding or dropping one is
//    a deliberate edit here — the same call core's `SECRET_NAMESPACE_MEMBERS` makes. Object-ness
//    is asserted explicitly because `stitchError` was a FUNCTION in `@stitchapi/hono` before the
//    fold, and a bare `typeof === 'function'` check would have passed for it.
//  - ABSENT: every verb-prefixed spelling the namespace replaced, across all six adapters — not
//    only the ones this package carried. Pre-GA `rc`, so they were removed outright rather than
//    aliased (CONTRACT.md P19); re-adding one would put two spellings of one call back on the
//    barrel, which is exactly the drift this fold closes.
describe('public surface: the stitchError namespace', () => {
    const MEMBERS = ['is', 'map'] as const;

    it('exports stitchError as a namespace object', () => {
        expect(typeof api.stitchError).toBe('object');
        expect(Object.keys(api.stitchError).sort()).toEqual(
            [...MEMBERS].sort(),
        );
    });

    it.each(MEMBERS)('exports stitchError.%s as a function', (member) => {
        expect(
            typeof (api.stitchError as Record<string, unknown>)[member],
        ).toBe('function');
    });

    it.each([
        'isStitchError',
        'stitchErrorHandler',
        'stitchOnError',
        'stitchErrorResponse',
        'toHttpException',
    ] as const)('does NOT export %s — the namespace replaced it', (name) => {
        expect(name in (api as Record<string, unknown>)).toBe(false);
    });

    // The one member that deliberately did NOT fold: Nest's handler is a DI-registered class
    // (`useGlobalFilters`, `{ provide: APP_FILTER, useClass }`), the idiom ADR 0012 rule 1
    // blesses. Pinned PRESENT so a later tidy-up cannot sweep it into the namespace.
    it('keeps StitchExceptionFilter as a top-level class', () => {
        expect(typeof api.StitchExceptionFilter).toBe('function');
        expect(api.StitchExceptionFilter.prototype).toBeInstanceOf(
            BaseExceptionFilter,
        );
    });
});

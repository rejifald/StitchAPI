import {
    type StitchErrorLike,
    StitchExceptionFilter,
    isStitchError,
    toHttpException,
} from '../src';

import { type ArgumentsHost, HttpException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

// Mirror what core throws on a failed call (packages/core/src/stitch.ts).
const stitchError = (message: string, status?: number): Error => {
    const e = new Error(message) as Error & { status?: number };
    e.name = 'StitchError';
    if (status !== undefined) e.status = status;
    return e;
};

describe('isStitchError', () => {
    it('recognises the branded error and rejects everything else', () => {
        expect(isStitchError(stitchError('x', 500))).toBe(true);
        expect(isStitchError(new Error('plain'))).toBe(false);
        expect(isStitchError('nope')).toBe(false);
        expect(isStitchError(undefined)).toBe(false);
    });
});

describe('toHttpException', () => {
    it('maps every upstream failure to 502 by default, ignoring the upstream status', () => {
        const ex = toHttpException(stitchError('rate limited', 429));
        expect(ex).toBeInstanceOf(HttpException);
        expect(ex!.getStatus()).toBe(502);
        // the raw message is withheld by default (see the leak-regression block below)
        expect(ex!.message).toBe('Upstream request failed');
        // a network error / timeout (no upstream status) → 502 too
        expect(toHttpException(stitchError('ECONNRESET'))!.getStatus()).toBe(
            502,
        );
    });

    it('accepts a fixed status override', () => {
        expect(
            toHttpException(stitchError('boom', 500), {
                status: 503,
            })!.getStatus(),
        ).toBe(503);
    });

    it('accepts a status function for custom mapping (e.g. propagate the upstream status)', () => {
        const status = (e: StitchErrorLike) => e.status ?? 502;
        expect(
            toHttpException(stitchError('rate limited', 429), {
                status,
            })!.getStatus(),
        ).toBe(429);
        expect(
            toHttpException(stitchError('timeout'), { status })!.getStatus(),
        ).toBe(502);
    });

    it('returns undefined for a non-stitch error (so the caller can rethrow)', () => {
        expect(toHttpException(new Error('other'))).toBeUndefined();
    });

    // Regression: the default response body must not echo the raw upstream/transport
    // message, which can disclose internal network topology or the upstream's status
    // semantics to an untrusted client.
    describe('does not leak the raw error message by default', () => {
        const bodyOf = (ex: HttpException): string =>
            JSON.stringify(ex.getResponse());

        it('a transport failure with an internal hostname is not disclosed', () => {
            const ex = toHttpException(
                stitchError('getaddrinfo ENOTFOUND payments.internal.corp'),
            )!;
            expect(ex.getStatus()).toBe(502);
            const body = bodyOf(ex);
            expect(body).not.toContain('payments.internal.corp');
            expect(body).not.toContain('ENOTFOUND');
            expect(ex.message).not.toContain('payments.internal.corp');
        });

        it("an upstream 401 does not surface as 'HTTP 401' in the body", () => {
            const ex = toHttpException(stitchError('HTTP 401', 401))!;
            expect(ex.getStatus()).toBe(502); // remapped, not the upstream 401
            expect(bodyOf(ex)).not.toContain('HTTP 401');
        });

        it('still exposes the original error as `cause` for server-side logging', () => {
            const original = stitchError(
                'getaddrinfo ENOTFOUND payments.internal.corp',
            );
            const ex = toHttpException(original)!;
            expect(ex.cause).toBe(original);
        });

        it('opt-in `exposeMessage: true` includes the raw message', () => {
            const ex = toHttpException(
                stitchError('getaddrinfo ENOTFOUND payments.internal.corp'),
                { exposeMessage: true },
            )!;
            expect(bodyOf(ex)).toContain('payments.internal.corp');
        });

        it('opt-in `message` override sets a caller-chosen message', () => {
            const fixed = toHttpException(stitchError('HTTP 401', 401), {
                message: 'Payment provider unavailable',
            })!;
            expect(fixed.message).toBe('Payment provider unavailable');
            const fromFn = toHttpException(stitchError('HTTP 429', 429), {
                message: (e) => `upstream said ${e.status}`,
            })!;
            expect(fromFn.message).toBe('upstream said 429');
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
            stitchError('boom', 503),
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
            stitchError('boom', 503),
        );
        expect((seen[0] as HttpException).getStatus()).toBe(503); // propagated via options
    });
});

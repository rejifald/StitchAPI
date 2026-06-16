import {
    type StitchError,
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
        expect(ex!.message).toContain('rate limited'); // message preserved
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
        const status = (e: StitchError) => e.status ?? 502;
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

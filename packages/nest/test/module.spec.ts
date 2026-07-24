// Wiring proof for @stitchapi/nest. We resolve the DynamicModule's provider factories
// directly (no Nest DI container needed) and run the resulting stitches against a mock
// adapter, asserting wire-level effects — the same style as core's tests.
import {
    type NestConfigServiceLike,
    type NestLoggerLike,
    STITCH_SEAM,
    STITCH_STORE,
    STITCH_TRACE,
    SeamRegistry,
    StitchModule,
    defineStitch,
    fromNestConfig,
    nestBorrowStore,
    nestLoggerSink,
} from '../src';

import { Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import type { Adapter, Seam, StitchStore } from 'stitchapi';
import { memoryStore } from 'stitchapi';
import { describe, expect, it } from 'vitest';

// Minimal view of a provider object literal, for poking at the factories.
type FProv = {
    provide: unknown;
    useFactory?: (...args: any[]) => unknown;
    useValue?: unknown;
    inject?: unknown[];
    scope?: unknown;
};

const recordingAdapter = (sink: string[]): Adapter => {
    return async (req) => {
        sink.push(`${req.method} ${req.url}`);
        return { status: 200, headers: {}, body: { ok: true } };
    };
};

describe('StitchModule.forRoot', () => {
    it('wires a seam over the configured adapter; store is a value; lifecycle closes', async () => {
        const calls: string[] = [];
        const mod = StitchModule.forRoot({
            baseUrl: 'https://api.test',
            adapter: recordingAdapter(calls),
        });
        expect(mod.global).toBe(true);

        const providers = mod.providers as FProv[];
        const seamProv = providers.find((p) => p.provide === STITCH_SEAM);
        const storeProv = providers.find((p) => p.provide === STITCH_STORE);
        expect(seamProv?.inject).toEqual([SeamRegistry]);
        expect(storeProv?.useValue).toBeDefined();

        const reg = new SeamRegistry();
        const api = seamProv!.useFactory!(reg) as Seam;
        await api.stitch({ path: '/thing' })();
        expect(calls).toEqual(['GET https://api.test/thing']);

        await reg.closeAll(); // must not throw
    });

    it('defaults tracing OFF (no STITCH_TRACE sink)', () => {
        const providers = StitchModule.forRoot().providers as FProv[];
        const traceProv = providers.find((p) => p.provide === STITCH_TRACE);
        expect(traceProv?.useValue).toBe(false);
    });

    it("expands the 'logger' trace sentinel to a sink", () => {
        const providers = StitchModule.forRoot({ trace: 'logger' })
            .providers as FProv[];
        const traceProv = providers.find((p) => p.provide === STITCH_TRACE);
        expect(
            typeof (traceProv?.useValue as { handle?: unknown }).handle,
        ).toBe('function');
    });
});

describe('StitchModule.forFeature', () => {
    it('builds a feature seam over shared store/trace and binds stitches to it', async () => {
        const calls: string[] = [];
        const GetThing = defineStitch('GET_THING', (h) =>
            h.stitch({ path: '/thing' }),
        );
        const mod = StitchModule.forFeature({
            seam: {
                config: {
                    baseUrl: 'https://feat.test',
                    adapter: recordingAdapter(calls),
                },
            },
            stitches: [GetThing],
        });

        const providers = mod.providers as FProv[];
        const stitchProv = providers.find((p) => p.provide === GetThing.token);
        const seamProv = providers.find((p) => p.provide !== GetThing.token);
        expect(seamProv?.inject).toEqual([
            STITCH_STORE,
            STITCH_TRACE,
            SeamRegistry,
        ]);
        // the stitch binds to the feature seam's token, not the root seam
        expect(stitchProv?.inject?.[0]).toBe(seamProv?.provide);

        const reg = new SeamRegistry();
        const featSeam = seamProv!.useFactory!(
            memoryStore(),
            false,
            reg,
        ) as Seam;
        const stitch = stitchProv!.useFactory!(featSeam) as ReturnType<
            typeof GetThing.build
        >;
        await stitch();
        expect(calls).toEqual(['GET https://feat.test/thing']);
    });

    it('attaches stitches to the root seam when no feature seam is given', () => {
        const GetThing = defineStitch('GET_THING_2', (h) =>
            h.stitch({ path: '/thing' }),
        );
        const providers = StitchModule.forFeature([GetThing])
            .providers as FProv[];
        expect(providers).toHaveLength(1);
        expect(providers[0]?.inject).toEqual([STITCH_SEAM]);
    });

    // Regression (path-vars fallout, #114): a templated-path def's call argument now *requires*
    // `params`, so its `StitchDef` has a narrower (contravariant) input than the loose default.
    // The feature registry must still admit it — `stitches` is bound to the any-input
    // `AnyStitchDef`, mirroring core's `StitchRegistry`. This wouldn't compile before the fix.
    it('accepts a templated-path stitch (required params) in a feature registry', async () => {
        const calls: string[] = [];
        const GetUser = defineStitch('GET_USER', (h) =>
            h.stitch({ path: '/users/{id}' }),
        );
        const mixed = [
            GetUser,
            defineStitch('LIST', (h) => h.stitch({ path: '/users' })),
        ];
        const providers = StitchModule.forFeature({
            seam: {
                config: {
                    baseUrl: 'https://feat.test',
                    adapter: recordingAdapter(calls),
                },
            },
            stitches: mixed,
        }).providers as FProv[];

        const userProv = providers.find((p) => p.provide === GetUser.token);
        const seamProv = providers.find(
            (p) => p.provide !== GetUser.token && p.provide !== mixed[1]!.token,
        );
        const reg = new SeamRegistry();
        const featSeam = seamProv!.useFactory!(
            memoryStore(),
            false,
            reg,
        ) as Seam;
        const getUser = userProv!.useFactory!(featSeam) as ReturnType<
            typeof GetUser.build
        >;
        await getUser({ params: { id: 42 } });
        expect(calls).toEqual(['GET https://feat.test/users/42']);
    });
});

describe('StitchModule.forFeatureScoped', () => {
    it('wires a request-scoped principal seam + request-scoped stitches over shared infra', async () => {
        const calls: string[] = [];
        const TENANT = Symbol('tenant');
        const GetThing = defineStitch((h) => h.stitch({ path: '/thing' }));
        const mod = StitchModule.forFeatureScoped({
            seam: {
                config: {
                    baseUrl: 'https://feat.test',
                    adapter: recordingAdapter(calls),
                },
                token: TENANT,
            },
            stitches: [GetThing],
            principal: (req: { tenantId: string }) => req.tenantId,
        });
        const providers = mod.providers as FProv[];

        const principalProv = providers.find((p) => p.provide === TENANT)!;
        const stitchProv = providers.find((p) => p.provide === GetThing.token)!;
        const baseProv = providers.find(
            (p) => p.provide !== TENANT && p.provide !== GetThing.token,
        )!;

        // principal + stitch are REQUEST-scoped; principal injects the base seam + REQUEST
        expect(principalProv.scope).toBe(Scope.REQUEST);
        expect(stitchProv.scope).toBe(Scope.REQUEST);
        expect(principalProv.inject).toEqual([baseProv.provide, REQUEST]);
        expect(stitchProv.inject).toEqual([TENANT]);

        // resolve the chain against the mock adapter, like the forFeature tests
        const reg = new SeamRegistry();
        const baseSeam = baseProv.useFactory!(
            memoryStore(),
            false,
            reg,
        ) as Seam;
        const principalSeam = principalProv.useFactory!(baseSeam, {
            tenantId: 't1',
        }) as Seam;
        const stitch = stitchProv.useFactory!(principalSeam) as ReturnType<
            typeof GetThing.build
        >;
        await stitch();
        expect(calls).toEqual(['GET https://feat.test/thing']);
    });

    it('binds scoped stitches to the root seam when no feature seam is given', () => {
        const GetThing = defineStitch((h) => h.stitch({ path: '/thing' }));
        const providers = StitchModule.forFeatureScoped({
            stitches: [GetThing],
            principal: () => 't1',
        }).providers as FProv[];
        const principalProv = providers.find(
            (p) => p.provide !== GetThing.token,
        )!;
        // no base feature-seam provider; the principal handle derives from STITCH_SEAM
        expect(principalProv.inject).toEqual([STITCH_SEAM, REQUEST]);
    });
});

describe('defineStitch token', () => {
    it('generates a unique Symbol token when none is given', () => {
        const A = defineStitch((h) => h.stitch({ path: '/a' }));
        const B = defineStitch((h) => h.stitch({ path: '/b' }));
        expect(typeof A.token).toBe('symbol');
        expect(A.token).not.toBe(B.token);
    });

    it('still accepts an explicit (token, build) form', () => {
        const A = defineStitch('GET_A', (h) => h.stitch({ path: '/a' }));
        expect(A.token).toBe('GET_A');
    });

    it('an auto-tokened def wires through forFeature', async () => {
        const calls: string[] = [];
        const GetThing = defineStitch((h) => h.stitch({ path: '/thing' }));
        const providers = StitchModule.forFeature({
            seam: {
                config: {
                    baseUrl: 'https://feat.test',
                    adapter: recordingAdapter(calls),
                },
            },
            stitches: [GetThing],
        }).providers as FProv[];
        const stitchProv = providers.find((p) => p.provide === GetThing.token);
        const seamProv = providers.find((p) => p.provide !== GetThing.token);
        expect(stitchProv).toBeDefined();

        const reg = new SeamRegistry();
        const featSeam = seamProv!.useFactory!(
            memoryStore(),
            false,
            reg,
        ) as Seam;
        const stitch = stitchProv!.useFactory!(featSeam) as ReturnType<
            typeof GetThing.build
        >;
        await stitch();
        expect(calls).toEqual(['GET https://feat.test/thing']);
    });
});

describe('bridges', () => {
    it('nestBorrowStore delegates get/set/incr but omits close', async () => {
        const calls: string[] = [];
        const backing: StitchStore = {
            get: async () => {
                calls.push('get');
                return 1;
            },
            set: async () => {
                calls.push('set');
            },
            incr: async () => {
                calls.push('incr');
                return 2;
            },
            close: async () => {
                calls.push('close');
            },
        };
        const borrowed = nestBorrowStore(backing);
        expect(borrowed.close).toBeUndefined();
        expect(await borrowed.get('k')).toBe(1);
        await borrowed.set('k', 'v');
        expect(await borrowed.incr('k', 1)).toBe(2);
        expect(calls).toEqual(['get', 'set', 'incr']); // close is never delegated
    });

    // A NestLoggerLike that records messages per level.
    const recordingLogger = () => {
        const rec = {
            log: [] as string[],
            warn: [] as string[],
            error: [] as string[],
            debug: [] as string[],
            verbose: [] as string[],
        };
        const logger: NestLoggerLike = {
            log: (m) => rec.log.push(m),
            warn: (m) => rec.warn.push(m),
            error: (m) => rec.error.push(m),
            debug: (m) => rec.debug.push(m),
            verbose: (m) => rec.verbose.push(m),
        };
        return { rec, logger };
    };

    it('nestLoggerSink maps each event to the right level, payload-free, query redacted', () => {
        const { rec, logger } = recordingLogger();
        const sink = nestLoggerSink(logger);
        const ctx = { name: 'x' };

        sink.handle(
            {
                type: 'start',
                name: 'x',
                method: 'GET',
                url: 'https://h/p?token=secret',
                input: { headers: { authorization: 'Bearer s3cret' } },
                at: 0,
            },
            ctx,
        );
        sink.handle(
            {
                type: 'progress',
                phase: 'retry',
                attempt: 2,
                waited: 100,
                at: 0,
            },
            ctx,
        );
        sink.handle(
            { type: 'progress', phase: 'throttled', attempt: 1, at: 0 },
            ctx,
        );
        sink.handle(
            {
                type: 'drift',
                finding: { level: 'error', path: 'a.b', change: 'invalid' },
                at: 0,
            },
            ctx,
        );
        sink.handle(
            {
                type: 'drift',
                finding: { level: 'warn', path: 'a.c', change: 'coerced' },
                at: 0,
            },
            ctx,
        );
        sink.handle(
            {
                type: 'drift',
                finding: { level: 'info', path: 'a.d', change: 'undeclared' },
                at: 0,
            },
            ctx,
        );
        sink.handle(
            {
                type: 'result',
                data: { secretField: 'nope' },
                status: 200,
                attempts: 1,
                at: 0,
            },
            ctx,
        );
        sink.handle(
            { type: 'done', ok: true, elapsed: 12, attempts: 1, at: 0 },
            ctx,
        );
        sink.handle(
            {
                type: 'error',
                name: 'x',
                message: 'boom',
                status: 500,
                attempts: 3,
                at: 0,
            },
            ctx,
        );
        sink.handle({ type: 'delta', chunk: { secret: 'data' }, at: 0 }, ctx);

        // start → debug, query stripped
        expect(rec.debug.some((l) => l.includes('GET https://h/p?…'))).toBe(
            true,
        );
        // retry → warn (surfaced); routine throttle → debug
        expect(
            rec.warn.some(
                (l) => l.includes('retry#2') && l.includes('waited 100ms'),
            ),
        ).toBe(true);
        expect(rec.debug.some((l) => l.includes('throttled#1'))).toBe(true);
        // drift routed by finding.level
        expect(rec.error.some((l) => l.includes('a.b'))).toBe(true);
        expect(rec.warn.some((l) => l.includes('a.c'))).toBe(true);
        expect(rec.debug.some((l) => l.includes('a.d'))).toBe(true);
        // lifecycle: result → verbose, done → debug
        expect(rec.verbose.some((l) => l.includes('200'))).toBe(true);
        expect(rec.debug.some((l) => l.includes('done ok in 12ms'))).toBe(true);
        // error always at error level, with status + attempts
        expect(
            rec.error.some((l) => l.includes('boom') && l.includes('500')),
        ).toBe(true);
        // nothing at info level (start is no longer noisy); delta dropped entirely
        expect(rec.log).toEqual([]);
        // payload-free: no header/body/chunk values leak through any level
        const all = [
            ...rec.log,
            ...rec.warn,
            ...rec.error,
            ...rec.debug,
            ...rec.verbose,
        ].join('\n');
        expect(all).not.toContain('secret');
        expect(all).not.toContain('s3cret');
        expect(all).not.toContain('nope');
    });

    it('nestLoggerSink lifecycle:false drops start/result/done but keeps retry/drift/error', () => {
        const { rec, logger } = recordingLogger();
        const sink = nestLoggerSink(logger, { lifecycle: false });
        const ctx = { name: 'x' };
        sink.handle(
            {
                type: 'start',
                name: 'x',
                method: 'GET',
                url: 'https://h/p',
                input: {},
                at: 0,
            },
            ctx,
        );
        sink.handle(
            { type: 'result', data: 1, status: 200, attempts: 1, at: 0 },
            ctx,
        );
        sink.handle(
            { type: 'done', ok: true, elapsed: 1, attempts: 1, at: 0 },
            ctx,
        );
        sink.handle(
            { type: 'progress', phase: 'retry', attempt: 2, at: 0 },
            ctx,
        );
        sink.handle(
            { type: 'error', name: 'x', message: 'boom', attempts: 1, at: 0 },
            ctx,
        );
        expect(rec.debug).toEqual([]); // start + done suppressed
        expect(rec.verbose).toEqual([]); // result suppressed
        expect(rec.warn.some((l) => l.includes('retry#2'))).toBe(true); // retry kept
        expect(rec.error.some((l) => l.includes('boom'))).toBe(true); // error kept
    });

    it('nestLoggerSink tolerates a logger without debug/verbose (guarded)', () => {
        const warn: string[] = [];
        const partial: NestLoggerLike = {
            log: () => {},
            warn: (m) => warn.push(m),
            error: () => {},
        };
        const sink = nestLoggerSink(partial);
        expect(() =>
            sink.handle(
                {
                    type: 'start',
                    name: 'x',
                    method: 'GET',
                    url: 'https://h',
                    input: {},
                    at: 0,
                },
                { name: 'x' },
            ),
        ).not.toThrow(); // start → debug, absent → no-op
        sink.handle(
            { type: 'progress', phase: 'retry', attempt: 2, at: 0 },
            { name: 'x' },
        );
        expect(warn.length).toBe(1);
    });

    it('fromNestConfig resolves a synchronous secret thunk from a ConfigService-like', () => {
        const config: NestConfigServiceLike = {
            getOrThrow<T = string>(key: string): T {
                return `val:${key}` as T;
            },
        };
        expect(fromNestConfig(config)('API_TOKEN')()).toBe('val:API_TOKEN');
    });

    it('fromNestConfig propagates ConfigService.getOrThrow on a missing key', () => {
        const config: NestConfigServiceLike = {
            getOrThrow<T = string>(key: string): T {
                throw new Error(`Configuration key "${key}" does not exist`);
            },
        };
        // The Nest getOrThrow error still surfaces through the core secretFrom delegation.
        expect(() => fromNestConfig(config)('API_TOKEN')()).toThrow(
            'Configuration key "API_TOKEN" does not exist',
        );
    });

    it('fromNestConfig rejects an empty value (delegates to core secretFrom)', () => {
        const config: NestConfigServiceLike = {
            // Present but blank — Nest's getOrThrow does NOT throw on '' (only on undefined).
            getOrThrow<T = string>(_key: string): T {
                return '' as T;
            },
        };
        // secretFrom rejects '' like env() does, so a blank credential never rides along.
        expect(() => fromNestConfig(config)('API_TOKEN')()).toThrow(
            'missing secret',
        );
    });

    it('nestLoggerSink drops an info (strategy announcement) event', () => {
        const { rec, logger } = recordingLogger();
        const sink = nestLoggerSink(logger);
        // The delegated core sink would log an `info` event at debug, but Nest's level
        // resolver returns null for it — preserving the prior switch, which dropped it.
        sink.handle(
            {
                type: 'info',
                topic: 'auth',
                detail: 'no token; sending unauthenticated',
                at: 0,
            },
            { name: 'x' },
        );
        expect([
            ...rec.log,
            ...rec.warn,
            ...rec.error,
            ...rec.debug,
            ...rec.verbose,
        ]).toEqual([]);
    });
});

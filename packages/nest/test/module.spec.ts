// Wiring proof for @stitchapi/nest. We resolve the DynamicModule's provider factories
// directly (no Nest DI container needed) and run the resulting stitches against a mock
// adapter, asserting wire-level effects — the same style as core's tests.
import {
    type ConfigServiceLike,
    STITCH_SEAM,
    STITCH_STORE,
    STITCH_TRACE,
    SeamRegistry,
    StitchModule,
    borrowStore,
    defineStitch,
    fromConfig,
    loggerSink,
} from '../src';

import { Logger } from '@nestjs/common';
import type { Adapter, Seam, StitchStore } from 'stitchapi';
import { memoryStore } from 'stitchapi';
import { describe, expect, it } from 'vitest';

// Minimal view of a provider object literal, for poking at the factories.
type FProv = {
    provide: unknown;
    useFactory?: (...args: any[]) => unknown;
    useValue?: unknown;
    inject?: unknown[];
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
                baseUrl: 'https://feat.test',
                adapter: recordingAdapter(calls),
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
});

describe('bridges', () => {
    it('borrowStore delegates get/set/incr but omits close', async () => {
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
        const borrowed = borrowStore(backing);
        expect(borrowed.close).toBeUndefined();
        expect(await borrowed.get('k')).toBe(1);
        await borrowed.set('k', 'v');
        expect(await borrowed.incr('k', 1)).toBe(2);
        expect(calls).toEqual(['get', 'set', 'incr']); // close is never delegated
    });

    it('loggerSink logs lifecycle lines and redacts the URL query', () => {
        const logs: string[] = [];
        const errs: string[] = [];
        const fake = {
            log: (m: string) => logs.push(m),
            error: (m: string) => errs.push(m),
            warn: () => {},
            debug: () => {},
        } as unknown as Logger;
        const sink = loggerSink(fake);
        sink.handle(
            {
                type: 'start',
                name: 'x',
                method: 'GET',
                url: 'https://h/p?token=secret',
                input: {},
                at: 0,
            },
            { name: 'x' },
        );
        sink.handle(
            {
                type: 'error',
                name: 'x',
                message: 'boom',
                status: 500,
                attempts: 1,
                at: 0,
            },
            { name: 'x' },
        );
        expect(logs[0]).toContain('GET https://h/p?…');
        expect(logs[0]).not.toContain('secret');
        expect(errs[0]).toContain('boom');
    });

    it('fromConfig resolves a synchronous secret thunk from a ConfigService-like', () => {
        const config: ConfigServiceLike = {
            getOrThrow<T = string>(key: string): T {
                return `val:${key}` as T;
            },
        };
        expect(fromConfig(config)('API_TOKEN')()).toBe('val:API_TOKEN');
    });
});

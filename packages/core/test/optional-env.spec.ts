// `optionalEnv` + `bearer`'s optional-secret path. A required Secret (`bearer(env('X'))`,
// `bearer('literal')`) is unchanged — it throws on a missing var and never announces. An optional
// secret attaches only when present, otherwise skips the header and announces the miss as an
// `info` event (never the token). The unit tests drive `apply` directly; the integration test
// proves the announced `info` event flows through the engine to a trace sink.
//
// `apply` is synchronous on every path here, so each call is `void`-marked to satisfy
// no-floating-promises while keeping the tests synchronous — important for the browser case, whose
// `process` stub must not span an await.
import { memoryStore, stitch } from '../src';
import type {
    AdapterRequest,
    AuthContext,
    StitchEvent,
    TraceSink,
} from '../src';
import { bearer, env, optionalEnv } from '../src/auth';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-optionalenv-${process.pid}.jsonl`,
);

// Clear every env var a test sets, so cases never leak into one another.
afterEach(() => {
    delete process.env['MY_TOKEN'];
    delete process.env['DEMO_TOKEN'];
});

function fakeReq(url: string): AdapterRequest {
    return { url, method: 'GET', headers: {} };
}
function recorder(): {
    ctx: AuthContext;
    infos: { topic: string; detail: string | undefined }[];
} {
    const infos: { topic: string; detail: string | undefined }[] = [];
    const ctx = {
        store: memoryStore(),
        vault: memoryStore(),
        emit: (topic: string, detail?: string) => {
            infos.push({ topic, detail });
        },
    } as AuthContext;
    return { ctx, infos };
}

describe('bearer(optionalEnv()) (unit)', () => {
    test('var set: attaches the header and announces the source, never the token', () => {
        process.env['MY_TOKEN'] = 'sekret-value';
        const req = fakeReq('https://api.example.com/x');
        const { ctx, infos } = recorder();
        void bearer(optionalEnv('MY_TOKEN')).apply(req, ctx);
        expect(req.headers['authorization']).toBe('Bearer sekret-value');
        expect(infos).toHaveLength(1);
        expect(infos[0]?.topic).toBe('auth');
        expect(infos[0]?.detail).toContain('MY_TOKEN');
        expect(infos[0]?.detail).not.toContain('sekret-value');
    });

    test('var unset: no header, announces the miss naming the var', () => {
        const req = fakeReq('https://api.example.com/x');
        const { ctx, infos } = recorder();
        void bearer(optionalEnv('MY_TOKEN')).apply(req, ctx);
        expect(req.headers['authorization']).toBeUndefined();
        expect(infos[0]?.detail).toContain('MY_TOKEN');
        expect(infos[0]?.detail).toContain('not set');
    });

    test('empty var counts as absent: no header attached', () => {
        process.env['MY_TOKEN'] = '';
        const req = fakeReq('https://api.example.com/x');
        const { ctx } = recorder();
        void bearer(optionalEnv('MY_TOKEN')).apply(req, ctx);
        expect(req.headers['authorization']).toBeUndefined();
    });

    test('browser (no process env): resolves absent, attaches nothing', () => {
        const req = fakeReq('https://api.example.com/x');
        const { ctx, infos } = recorder();
        const token = optionalEnv('MY_TOKEN');
        const saved = (globalThis as { process?: unknown }).process;
        (globalThis as { process?: unknown }).process = undefined;
        void bearer(token).apply(req, ctx);
        (globalThis as { process?: unknown }).process = saved;
        expect(req.headers['authorization']).toBeUndefined();
        expect(infos[0]?.detail).toContain('not set');
    });
});

describe('bearer() required path is unchanged', () => {
    test('a required secret still attaches, with no announcement', () => {
        const req = fakeReq('https://api.example.com/x');
        const { ctx, infos } = recorder();
        void bearer('static-token').apply(req, ctx);
        expect(req.headers['authorization']).toBe('Bearer static-token');
        expect(infos).toHaveLength(0);
    });

    test('bearer(env()) throws when the required var is missing', () => {
        const req = fakeReq('https://api.example.com/x');
        const { ctx } = recorder();
        expect(() => {
            void bearer(env('MY_TOKEN')).apply(req, ctx);
        }).toThrow(/missing env var MY_TOKEN/);
    });
});

describe('bearer(optionalEnv()) (integration)', () => {
    let server: MockServer;
    beforeAll(async () => {
        server = await startMockServer();
    });
    afterAll(async () => {
        await server.close();
    });
    beforeEach(() => {
        server.reset();
    });

    test('the token reaches the request and an info event is streamed', async () => {
        process.env['DEMO_TOKEN'] = 'flow-token';
        server.route('GET', '/thing', {
            requireHeader: {
                name: 'authorization',
                value: 'Bearer flow-token',
            },
            body: { ok: true },
        });
        const events: StitchEvent[] = [];
        const sink: TraceSink = {
            handle: (e) => {
                events.push(e);
            },
        };
        const thing = stitch({
            url: `${server.url}/thing`,
            auth: bearer(optionalEnv('DEMO_TOKEN')),
            trace: sink,
        });

        await expect(thing()).resolves.toEqual({ ok: true });

        const info = events.find(
            (e): e is Extract<StitchEvent, { type: 'info' }> =>
                e.type === 'info',
        );
        expect(info).toBeDefined();
        expect(info?.topic).toBe('auth');
        expect(info?.detail).toContain('DEMO_TOKEN');
        expect(info?.detail ?? '').not.toContain('flow-token');
    });
});

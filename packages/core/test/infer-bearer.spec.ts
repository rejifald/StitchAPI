// `inferBearer` — opt-in, self-announcing bearer inference. The unit tests drive `apply` directly
// (it only reads `ctx.emit` + the request URL) so env resolution, the host heuristic, the
// no-match announcement, and the browser no-op are all asserted in isolation; the integration test
// proves the announced `info` event actually flows through the engine to a trace sink.
//
// `apply` is synchronous on every inferBearer path, but its declared type is `void | Promise<void>`
// (the AuthStrategy contract), so each call is `void`-marked to satisfy no-floating-promises while
// keeping the tests synchronous — important for the browser case, whose `process` stub must not
// span an await.
import { inferBearer, memoryStore, stitch } from '../src';
import type {
    AdapterRequest,
    AuthContext,
    StitchEvent,
    TraceSink,
} from '../src';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-infer-${process.pid}.jsonl`,
);

// Clear every env var a test sets, so cases never leak into one another.
afterEach(() => {
    delete process.env['MY_TOKEN'];
    delete process.env['GITHUB_TOKEN'];
    delete process.env['GITHUB_API_KEY'];
    delete process.env['CUSTOM_KEY'];
    delete process.env['INFER_DEMO_TOKEN'];
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

describe('inferBearer (unit)', () => {
    test('explicit env wins; the inference is announced but never the token', () => {
        process.env['MY_TOKEN'] = 'sekret-value';
        const req = fakeReq('https://api.example.com/x');
        const { ctx, infos } = recorder();
        void inferBearer({ env: 'MY_TOKEN' }).apply(req, ctx);
        expect(req.headers['authorization']).toBe('Bearer sekret-value');
        expect(infos).toHaveLength(1);
        expect(infos[0]?.topic).toBe('auth');
        expect(infos[0]?.detail).toContain('MY_TOKEN');
        expect(infos[0]?.detail).not.toContain('sekret-value');
    });

    test('host heuristic maps api.github.com → GITHUB_TOKEN', () => {
        process.env['GITHUB_TOKEN'] = 'gh-tok';
        const req = fakeReq('https://api.github.com/user');
        const { ctx, infos } = recorder();
        void inferBearer().apply(req, ctx);
        expect(req.headers['authorization']).toBe('Bearer gh-tok');
        expect(infos[0]?.detail).toContain('GITHUB_TOKEN');
        expect(infos[0]?.detail).toContain('api.github.com');
    });

    test('falls back to *_API_KEY when *_TOKEN is unset', () => {
        process.env['GITHUB_API_KEY'] = 'gh-key';
        const req = fakeReq('https://api.github.com/user');
        const { ctx } = recorder();
        void inferBearer().apply(req, ctx);
        expect(req.headers['authorization']).toBe('Bearer gh-key');
    });

    test('no matching env var: no header, announces the miss and what it tried', () => {
        const req = fakeReq('https://api.github.com/user');
        const { ctx, infos } = recorder();
        void inferBearer().apply(req, ctx);
        expect(req.headers['authorization']).toBeUndefined();
        expect(infos[0]?.detail).toContain('no token');
        expect(infos[0]?.detail).toContain('GITHUB_TOKEN');
    });

    test('a custom fromHost overrides the default mapping', () => {
        process.env['CUSTOM_KEY'] = 'c';
        const req = fakeReq('https://whatever.example.com/x');
        const { ctx } = recorder();
        void inferBearer({ fromHost: () => ['CUSTOM_KEY'] }).apply(req, ctx);
        expect(req.headers['authorization']).toBe('Bearer c');
    });

    test('browser (no process env): a no-op that announces it did nothing', () => {
        const req = fakeReq('https://api.github.com/user');
        const { ctx, infos } = recorder();
        const saved = (globalThis as { process?: unknown }).process;
        (globalThis as { process?: unknown }).process = undefined;
        void inferBearer().apply(req, ctx);
        (globalThis as { process?: unknown }).process = saved;
        expect(req.headers['authorization']).toBeUndefined();
        expect(infos[0]?.detail).toContain('browser');
    });
});

describe('inferBearer (integration)', () => {
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

    test('the inferred bearer reaches the request and an info event is streamed', async () => {
        process.env['INFER_DEMO_TOKEN'] = 'flow-token';
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
            auth: inferBearer({ env: 'INFER_DEMO_TOKEN' }),
            trace: sink,
        });

        await expect(thing()).resolves.toEqual({ ok: true });

        const info = events.find(
            (e): e is Extract<StitchEvent, { type: 'info' }> =>
                e.type === 'info',
        );
        expect(info).toBeDefined();
        expect(info?.topic).toBe('auth');
        expect(info?.detail).toContain('INFER_DEMO_TOKEN');
        expect(info?.detail ?? '').not.toContain('flow-token');
    });
});

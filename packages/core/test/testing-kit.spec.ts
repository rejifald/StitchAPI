// The published mocking kit (stitchapi/testing): a browser-safe mock transport, fake stitches,
// stream builders, and an event collector — exercised against the REAL engine so the helpers prove
// they drive validation, retry, timeout, and the streaming path. (The vendor conformance verifiers
// in the same entry are covered by conformance-kit.spec.ts.)
import { stitch } from '../src';
import { stream } from '../src/stream';
import {
    collectStitchEvents,
    failStitch,
    mockAdapter,
    sseStream,
    streamOf,
    streamThenError,
    stubStitch,
} from '../src/testing';
import { isStitch } from '../src/types';

import { z } from 'zod';

const td = new TextDecoder();

describe('mockAdapter — testing a stitch definition', () => {
    test('routes by method+path, records the request, validates the response', async () => {
        const api = mockAdapter([
            {
                method: 'GET',
                match: '/users/42',
                respond: { body: { id: 42, name: 'Ada' } },
            },
        ]);
        const getUser = stitch({
            baseUrl: 'https://api.test',
            path: '/users/{id}',
            output: z.object({ id: z.number(), name: z.string() }),
            adapter: api,
        });

        const user = await getUser({ params: { id: 42 } });

        expect(user).toEqual({ id: 42, name: 'Ada' });
        expect(api.callCount('/users/42')).toBe(1);
        expect(api.lastRequest()?.method).toBe('GET');
        expect(api.lastRequest()?.url).toContain('/users/42');
    });

    test('a status sequence drives retry; callCount proves the attempts', async () => {
        const api = mockAdapter({
            match: '/flaky',
            respond: [{ status: 503 }, { status: 503 }, { body: { ok: true } }],
        });
        const call = stitch({
            baseUrl: 'https://api.test',
            path: '/flaky',
            adapter: api,
            retry: { attempts: 3, on: [503], backoff: { base: 1 } },
        });

        await expect(call()).resolves.toEqual({ ok: true });
        expect(api.callCount()).toBe(3);
    });

    test('a function responder sees the per-call index (pagination)', async () => {
        const api = mockAdapter({
            match: '/items',
            respond: ({ index }) => ({ body: { page: index } }),
        });
        const list = stitch({
            baseUrl: 'https://api.test',
            path: '/items',
            adapter: api,
        });

        expect(await list()).toEqual({ page: 0 });
        expect(await list()).toEqual({ page: 1 });
    });

    test('delay is abortable: a per-attempt timeout cancels the slow response', async () => {
        // Same shape as resilience.spec.ts §6: the 2s delay is 100× the deadline so the RATIO
        // separates "aborted" from "waited it out", instead of a tight absolute margin that an
        // event-loop stall on a loaded runner can cross. See that test for the measurements.
        const api = mockAdapter({
            match: '/slow',
            respond: { delay: 2000, body: { ok: true } },
        });
        const call = stitch({
            baseUrl: 'https://api.test',
            path: '/slow',
            adapter: api,
            timeout: { each: 20 },
        });

        const t0 = Date.now();
        const res = await call.safe();
        const elapsed = Date.now() - t0;

        // Failed, and failed *because the deadline passed* — not merely "not ok".
        expect(res.ok).toBe(false);
        expect(res.error?.message ?? '').toMatch(/timed?\s?out|timeout/i);
        // Aborted near the 20ms deadline; loose ceiling, still 2× under the 2s delay.
        expect(elapsed).toBeLessThan(1000);
    });

    test('an unmatched request throws by default', async () => {
        const api = mockAdapter({ match: '/known', respond: { body: {} } });
        const call = stitch({ url: 'https://api.test/unknown', adapter: api });

        const res = await call.safe();
        expect(res.ok).toBe(false);
    });

    test('onUnmatched: 404 replies with a bare status instead of throwing', async () => {
        const api = mockAdapter(
            { match: '/known', respond: { body: {} } },
            { onUnmatched: 404 },
        );
        const call = stitch({ url: 'https://api.test/missing', adapter: api });

        const res = await call.safe();
        expect(res.ok).toBe(false);
        expect(res.error?.status).toBe(404);
    });
});

describe('stream builders + collectStitchEvents', () => {
    test('streamOf drives the stream surface; collectStitchEvents gathers deltas', async () => {
        const api = mockAdapter({
            match: '/s',
            respond: { stream: streamOf(['ab', 'cd']) },
        });
        const s = stream({ url: 'https://api.test/s', adapter: api });

        const ev = await collectStitchEvents(s.stream());

        expect(ev.types).toContain('delta');
        expect(ev.deltas.length).toBe(2);
        expect(ev.done?.ok).toBe(true);
    });

    test('streamThenError surfaces a mid-stream failure, deltas-so-far preserved', async () => {
        const api = mockAdapter({
            match: '/s',
            respond: { stream: streamThenError(['ab']) },
        });
        const s = stream({ url: 'https://api.test/s', adapter: api });

        const ev = await collectStitchEvents(s.stream());

        expect(ev.deltas.length).toBe(1);
        expect(ev.error).toBeDefined();
        expect(ev.done?.ok).toBe(false);
    });

    test('sseStream frames events as a text/event-stream body', async () => {
        const rs = sseStream([
            { data: 'hi', id: '1' },
            { data: { n: 2 }, event: 'tick' },
        ]);

        const reader = rs.getReader();
        let text = '';
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            text += td.decode(value);
        }

        expect(text).toBe('id: 1\ndata: hi\n\nevent: tick\ndata: {"n":2}\n\n');
    });
});

describe('stubStitch / failStitch — testing code that calls a stitch', () => {
    test('stubStitch is a conformant Stitch returning a canned value, with a call spy', async () => {
        const getUser = stubStitch({ id: 42, name: 'Ada' });

        expect(isStitch(getUser)).toBe(true);
        expect(getUser.__stitch).toBe(true);

        const user = await getUser({ params: { id: 42 } });
        expect(user).toEqual({ id: 42, name: 'Ada' });
        expect(getUser.callCount()).toBe(1);
        expect(getUser.calls()[0]).toEqual({ params: { id: 42 } });

        const safe = await getUser.safe({ params: { id: 42 } });
        expect(safe).toEqual({
            ok: true,
            data: { id: 42, name: 'Ada' },
            error: null,
        });
        expect(getUser.callCount()).toBe(2);

        getUser.reset();
        expect(getUser.callCount()).toBe(0);
    });

    test('stubStitch synthesizes a start→result→done stream', async () => {
        const getUser = stubStitch({ id: 1 });

        const ev = await collectStitchEvents(getUser());

        expect(ev.types).toEqual(['start', 'result', 'done']);
        expect(ev.result).toEqual({ id: 1 });
        expect(ev.done?.ok).toBe(true);
    });

    test('stubStitch accepts a function of the call input', async () => {
        const echo = stubStitch((input) => input);
        expect(await echo({ params: { id: 7 } })).toEqual({
            params: { id: 7 },
        });
    });

    test('.with shallow-merges bound input slots', async () => {
        const base = stubStitch((input) => input);
        const bound = base.with({ query: { tenant: 'acme' } });

        expect(await bound({ params: { id: 1 } })).toEqual({
            query: { tenant: 'acme' },
            params: { id: 1 },
        });
    });

    test('failStitch rejects, reports via safe(), and yields start→error→done', async () => {
        const broken = failStitch({ status: 500, message: 'boom' });

        await expect(broken()).rejects.toThrow('boom');

        const safe = await broken.safe();
        expect(safe.ok).toBe(false);
        expect(safe.error?.status).toBe(500);

        const ev = await collectStitchEvents(broken());
        expect(ev.types).toEqual(['start', 'error', 'done']);
        expect(ev.error?.status).toBe(500);
        expect(ev.done?.ok).toBe(false);
    });
});

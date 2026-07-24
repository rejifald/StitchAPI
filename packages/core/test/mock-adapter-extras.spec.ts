// mockAdapter behaviours (src/test-mock.ts) beyond testing-kit.spec.ts's coverage (method+path
// routing, status sequence, function responder, delay, unmatched). Driven at the Adapter layer
// directly — no stitch needed. Pins:
//   - match as a RegExp, a predicate, and the string-substring fallback (beyond exact pathname);
//   - first matching route wins;
//   - a response sequence repeats its LAST entry once exhausted;
//   - build() defaults status to 200, lowercases headers, and maps retryAfterSeconds → retry-after;
//   - the spy: lastRequest(), filtered calls()/callCount(), and reset() (clears the log AND restarts
//     each route's per-call counter).
import { mockAdapter } from '../src/test-mock';
import type { AdapterRequest } from '../src/types';

const req = (url: string, method = 'GET'): AdapterRequest => ({
    url,
    method,
    headers: {},
});

describe('mockAdapter route matching', () => {
    test('matches a RegExp against the full URL', async () => {
        const api = mockAdapter({
            match: /\/users\/\d+/,
            respond: { body: 'user' },
        });
        expect((await api(req('http://h/users/42'))).body).toBe('user');
        await expect(api(req('http://h/users/abc'))).rejects.toThrow(
            /no route matched/,
        );
    });

    test('matches a predicate', async () => {
        const api = mockAdapter(
            { match: (r) => r.method === 'POST', respond: { body: 'posted' } },
            { onUnmatched: 404 },
        );
        expect((await api(req('http://h/a', 'POST'))).body).toBe('posted');
        expect((await api(req('http://h/a', 'GET'))).status).toBe(404);
    });

    test('matches a string as a substring of the full URL (beyond the pathname)', async () => {
        const api = mockAdapter(
            { match: 'token=abc', respond: { body: 'q' } },
            { onUnmatched: 404 },
        );
        expect((await api(req('http://h/x?token=abc'))).body).toBe('q'); // substring hit
        expect((await api(req('http://h/x?token=zzz'))).status).toBe(404);
    });

    test('the first matching route wins', async () => {
        const api = mockAdapter([
            { match: '/x', respond: { body: 'first' } },
            { match: '/x', respond: { body: 'second' } },
        ]);
        expect((await api(req('http://h/x'))).body).toBe('first');
    });
});

describe('mockAdapter responses', () => {
    test('a sequence repeats its last entry once exhausted', async () => {
        const api = mockAdapter({ respond: [{ body: 1 }, { body: 2 }] });
        expect((await api(req('http://h/a'))).body).toBe(1);
        expect((await api(req('http://h/a'))).body).toBe(2);
        expect((await api(req('http://h/a'))).body).toBe(2); // last repeats
    });

    test('defaults status to 200, lowercases headers, maps retryAfterSeconds', async () => {
        const api = mockAdapter({
            respond: { headers: { 'X-Foo': 'Bar' }, retryAfterSeconds: 5 },
        });
        const res = await api(req('http://h/a'));
        expect(res.status).toBe(200);
        expect(res.headers['x-foo']).toBe('Bar'); // header key lowercased
        expect(res.headers['retry-after']).toBe('5'); // retryAfterSeconds → header
    });
});

describe('mockAdapter spy', () => {
    test('lastRequest() / filtered calls() / callCount()', async () => {
        const api = mockAdapter({ respond: { body: 'ok' } }); // catch-all
        await api(req('http://h/a'));
        await api(req('http://h/b', 'POST'));
        expect(api.lastRequest()?.url).toBe('http://h/b');
        expect(api.calls('/a')).toHaveLength(1);
        expect(api.callCount((r) => r.method === 'POST')).toBe(1);
    });

    test('lastRequest() is undefined before any call', () => {
        expect(mockAdapter({ respond: {} }).lastRequest()).toBeUndefined();
    });

    test('reset() clears the log and restarts each route counter', async () => {
        const api = mockAdapter({ respond: [{ body: 1 }, { body: 2 }] });
        expect((await api(req('http://h/a'))).body).toBe(1);
        expect((await api(req('http://h/a'))).body).toBe(2);
        api.reset();
        expect(api.callCount()).toBe(0); // log cleared
        expect((await api(req('http://h/a'))).body).toBe(1); // sequence replays from the start
    });
});

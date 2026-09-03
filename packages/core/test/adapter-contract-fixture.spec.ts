// Direct tests for conformance.fixture (src/testing.ts) — the PURE echo-contract host that
// conformance.adapter drives a transport against, and that users mount to verify a custom adapter.
// conformance-kit.spec.ts only mounts it on node:http and drives the happy routes through
// fetchAdapter; its own routing branches (especially the edges) go unasserted. These pin them:
//   - GET /status/{code} returns that status; an out-of-range / non-numeric code falls through to 404;
//   - a query string is stripped before routing;
//   - /echo reflects the upper-cased method, headers, raw body, and the JSON-parsed body (null when
//     absent or unparseable), for any method;
//   - /text, /json, /slow, and an unknown path each return their documented response.
import { conformance } from '../src/testing';
import type { FixtureRequest } from '../src/testing';

const reqOf = (over: Partial<FixtureRequest> = {}): FixtureRequest => ({
    method: 'GET',
    path: '/',
    headers: {},
    ...over,
});

const bodyJson = (body: string): unknown => JSON.parse(body);

describe('conformance.fixture', () => {
    test('GET /status/{code} returns that status with a JSON body', () => {
        const res = conformance.fixture(reqOf({ path: '/status/404' }));
        expect(res.status).toBe(404);
        expect(res.headers['content-type']).toBe('application/json');
        expect(bodyJson(res.body)).toEqual({ status: 404 });
    });

    test('a non-numeric or out-of-range status code falls through to 404 not_found', () => {
        for (const path of ['/status/abc', '/status/700', '/status/50']) {
            const res = conformance.fixture(reqOf({ path }));
            expect(res.status).toBe(404);
            expect(bodyJson(res.body)).toEqual({ error: 'not_found' });
        }
    });

    test('a query string is stripped before routing', () => {
        expect(
            conformance.fixture(reqOf({ path: '/status/404?x=1' })).status,
        ).toBe(404);
    });

    test('/echo reflects the upper-cased method, body, and parsed JSON', () => {
        const res = conformance.fixture(
            reqOf({ method: 'post', path: '/echo', body: '{"n":1}' }),
        );
        expect(res.status).toBe(200);
        expect(bodyJson(res.body)).toEqual({
            method: 'POST',
            headers: {},
            body: '{"n":1}',
            json: { n: 1 },
        });
    });

    test('/echo json is null for an absent or unparseable body', () => {
        expect(
            (
                bodyJson(
                    conformance.fixture(reqOf({ path: '/echo' })).body,
                ) as {
                    json: unknown;
                }
            ).json,
        ).toBeNull();
        expect(
            (
                bodyJson(
                    conformance.fixture(
                        reqOf({
                            method: 'POST',
                            path: '/echo',
                            body: 'notjson',
                        }),
                    ).body,
                ) as { json: unknown }
            ).json,
        ).toBeNull();
    });

    test('GET /text returns text/plain with the echo header', () => {
        const res = conformance.fixture(reqOf({ path: '/text' }));
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
        expect(res.headers['x-stitch-echo']).toBe('text');
        expect(res.body).toBe('stitch-conformance-text');
    });

    test('GET /json returns the JSON kit body with the echo header', () => {
        const res = conformance.fixture(reqOf({ path: '/json' }));
        expect(res.headers['x-stitch-echo']).toBe('json');
        expect(bodyJson(res.body)).toEqual({
            kit: 'stitchapi',
            numbers: [1, 2, 3],
        });
    });

    test('GET /slow carries delay', () => {
        const res = conformance.fixture(reqOf({ path: '/slow' }));
        expect(res.status).toBe(200);
        expect(res.delay).toBe(300);
        expect(bodyJson(res.body)).toEqual({ slow: true });
    });

    test('an unknown path is 404 not_found', () => {
        const res = conformance.fixture(reqOf({ path: '/nope' }));
        expect(res.status).toBe(404);
        expect(bodyJson(res.body)).toEqual({ error: 'not_found' });
    });
});

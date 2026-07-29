// Direct tests for adapterContractFixture (src/testing.ts) — the PURE echo-contract host that
// verifyAdapterContract drives a transport against, and that users mount to verify a custom adapter.
// conformance-kit.spec.ts only mounts it on node:http and drives the happy routes through
// fetchAdapter; its own routing branches (especially the edges) go unasserted. These pin them:
//   - GET /status/{code} returns that status; an out-of-range / non-numeric code falls through to 404;
//   - a query string is stripped before routing;
//   - /echo reflects the upper-cased method, headers, raw body, and the JSON-parsed body (null when
//     absent or unparseable), for any method;
//   - /text, /json, /slow, and an unknown path each return their documented response.
import { adapterContractFixture } from '../src/testing';
import type { FixtureRequest } from '../src/testing';

const reqOf = (over: Partial<FixtureRequest> = {}): FixtureRequest => ({
    method: 'GET',
    path: '/',
    headers: {},
    ...over,
});

const bodyJson = (body: string): unknown => JSON.parse(body);

describe('adapterContractFixture', () => {
    test('GET /status/{code} returns that status with a JSON body', () => {
        const res = adapterContractFixture(reqOf({ path: '/status/404' }));
        expect(res.status).toBe(404);
        expect(res.headers['content-type']).toBe('application/json');
        expect(bodyJson(res.body)).toEqual({ status: 404 });
    });

    test('a non-numeric or out-of-range status code falls through to 404 not_found', () => {
        for (const path of ['/status/abc', '/status/700', '/status/50']) {
            const res = adapterContractFixture(reqOf({ path }));
            expect(res.status).toBe(404);
            expect(bodyJson(res.body)).toEqual({ error: 'not_found' });
        }
    });

    test('a query string is stripped before routing', () => {
        expect(
            adapterContractFixture(reqOf({ path: '/status/404?x=1' })).status,
        ).toBe(404);
    });

    test('/echo reflects the upper-cased method, body, and parsed JSON', () => {
        const res = adapterContractFixture(
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
                    adapterContractFixture(reqOf({ path: '/echo' })).body,
                ) as {
                    json: unknown;
                }
            ).json,
        ).toBeNull();
        expect(
            (
                bodyJson(
                    adapterContractFixture(
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
        const res = adapterContractFixture(reqOf({ path: '/text' }));
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
        expect(res.headers['x-stitch-echo']).toBe('text');
        expect(res.body).toBe('stitch-conformance-text');
    });

    test('GET /json returns the JSON kit body with the echo header', () => {
        const res = adapterContractFixture(reqOf({ path: '/json' }));
        expect(res.headers['x-stitch-echo']).toBe('json');
        expect(bodyJson(res.body)).toEqual({
            kit: 'stitchapi',
            numbers: [1, 2, 3],
        });
    });

    test('GET /slow carries delay', () => {
        const res = adapterContractFixture(reqOf({ path: '/slow' }));
        expect(res.status).toBe(200);
        expect(res.delay).toBe(300);
        expect(bodyJson(res.body)).toEqual({ slow: true });
    });

    test('an unknown path is 404 not_found', () => {
        const res = adapterContractFixture(reqOf({ path: '/nope' }));
        expect(res.status).toBe(404);
        expect(bodyJson(res.body)).toEqual({ error: 'not_found' });
    });
});

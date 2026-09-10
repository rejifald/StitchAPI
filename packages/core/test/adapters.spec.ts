import { axiosAdapter, stitch } from '../src';
import type { AxiosLike, AxiosLikeConfig, AxiosLikeResponse } from '../src';
import type { Adapter } from '../src/types';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-adapters-${process.pid}.jsonl`,
);

// A fake axios instance that records the configs it received and returns a scripted response.
function recordingClient(
    respond: (cfg: AxiosLikeConfig) => AxiosLikeResponse,
): AxiosLike & { calls: AxiosLikeConfig[] } {
    const calls: AxiosLikeConfig[] = [];
    return {
        calls,
        request: async (config) => {
            calls.push(config);
            return respond(config);
        },
    };
}

const jsonResp = (
    status: number,
    obj: unknown,
    headers: Record<string, string | string[]> = {},
): AxiosLikeResponse => ({
    status,
    headers: { 'content-type': 'application/json', ...headers },
    data: Buffer.from(JSON.stringify(obj)),
});

describe('axiosAdapter', () => {
    test('translates an AdapterRequest into an axios config and parses JSON', async () => {
        const client = recordingClient(() => jsonResp(200, { id: 7 }));
        const res = await axiosAdapter(client)({
            url: 'http://h/u',
            method: 'get',
            headers: {},
        });
        expect(res).toEqual({
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: { id: 7 },
            url: 'http://h/u', // every axios response reports a url (#708 §2)
        });
        const cfg = client.calls[0];
        expect(cfg?.url).toBe('http://h/u');
        expect(cfg?.method).toBe('GET');
        expect(cfg?.responseType).toBe('arraybuffer');
        expect(cfg?.validateStatus?.(500)).toBe(true); // never throw on non-2xx
    });

    test('encodes json and form bodies and sets content-type', async () => {
        const client = recordingClient(() => jsonResp(200, {}));
        const adapter = axiosAdapter(client);
        await adapter({
            url: 'http://h/u',
            method: 'POST',
            headers: {},
            body: { a: 1, b: 'x y' },
            bodyType: 'json',
        });
        expect(client.calls[0]?.data).toBe('{"a":1,"b":"x y"}');
        expect(client.calls[0]?.headers?.['content-type']).toBe(
            'application/json',
        );

        await adapter({
            url: 'http://h/u',
            method: 'POST',
            headers: {},
            body: { a: 1, b: 'x y' },
            bodyType: 'form',
        });
        expect(client.calls[1]?.data).toBe('a=1&b=x+y');
        expect(client.calls[1]?.headers?.['content-type']).toBe(
            'application/x-www-form-urlencoded',
        );
    });

    test('normalizes response headers and joins multi-valued set-cookie', async () => {
        const client = recordingClient(() => ({
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'set-cookie': ['x=1', 'y=2'],
            },
            data: Buffer.from('{"ok":true}'),
        }));
        const res = await axiosAdapter(client)({
            url: 'http://h/u',
            method: 'GET',
            headers: {},
        });
        expect(res.headers['content-type']).toBe('application/json');
        expect(res.headers['set-cookie']).toBe('x=1, y=2');
        expect(res.body).toEqual({ ok: true });
    });

    test('honors response arrayBuffer for binary downloads', async () => {
        const bytes = new Uint8Array([1, 2, 3]);
        const client = recordingClient(() => ({
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
            data: Buffer.from(bytes),
        }));
        const res = await axiosAdapter(client)({
            url: 'http://h/bin',
            method: 'GET',
            headers: {},
            response: 'arrayBuffer',
        });
        expect(res.body).toBeInstanceOf(ArrayBuffer);
        expect(new Uint8Array(res.body as ArrayBuffer)).toEqual(bytes);
    });

    test('merges defaults and forwards the abort signal', async () => {
        const client = recordingClient(() => jsonResp(200, {}));
        const ac = new AbortController();
        await axiosAdapter(client, {
            proxy: false,
            headers: { 'x-base': '1' },
        })({
            url: 'http://h/u',
            method: 'GET',
            headers: { 'x-call': '2' },
            signal: ac.signal,
        });
        const cfg = client.calls[0];
        expect(cfg?.['proxy']).toBe(false);
        expect(cfg?.headers).toMatchObject({ 'x-base': '1', 'x-call': '2' });
        expect(cfg?.signal).toBe(ac.signal);
    });

    // #708 §2: this transport used to return only { status, headers, body } while fetchAdapter
    // returned four keys, so `AdapterResponse.url` — and everything downstream of it, StitchError.url
    // and the `download` filename fallback — was ALWAYS undefined on axios, silently.
    describe('response url', () => {
        test('reports the request url', async () => {
            const client = recordingClient(() => jsonResp(200, {}));
            const res = await axiosAdapter(client)({
                url: 'https://api.test/users/7',
                method: 'GET',
                headers: {},
            });
            expect(res.url).toBe('https://api.test/users/7');
        });

        test('prefers the url axios actually dispatched over the one we handed it', async () => {
            // A request interceptor may rewrite config.url; the response echoes the config that
            // was really sent, so that is the closer account of what was requested.
            const client: AxiosLike = {
                request: async () => ({
                    ...jsonResp(200, {}),
                    config: { url: 'https://api.test/v2/users/7' },
                }),
            };
            const res = await axiosAdapter(client)({
                url: 'https://api.test/v1/users/7',
                method: 'GET',
                headers: {},
            });
            expect(res.url).toBe('https://api.test/v2/users/7');
        });

        test('falls back to the request url when the client echoes no usable config', async () => {
            // A hand-rolled AxiosLike need not echo a config at all, and an empty url is no url.
            const urlFor = async (
                extra: Partial<AxiosLikeResponse>,
            ): Promise<string | undefined> => {
                const client: AxiosLike = {
                    request: async () => ({ ...jsonResp(200, {}), ...extra }),
                };
                const res = await axiosAdapter(client)({
                    url: 'https://api.test/x',
                    method: 'GET',
                    headers: {},
                });
                return res.url;
            };
            expect(await urlFor({})).toBe('https://api.test/x'); // no config echoed
            expect(await urlFor({ config: {} })).toBe('https://api.test/x'); // config, no url
            expect(await urlFor({ config: { url: '' } })).toBe(
                'https://api.test/x', // an empty url is no url
            );
        });

        test('is reported on a failing response too, so StitchError.url is set', async () => {
            const client = recordingClient(() =>
                jsonResp(404, { error: 'nope' }),
            );
            const getUser = stitch({
                url: 'https://api.example.com/users/{id}',
                adapter: axiosAdapter(client),
            });
            await expect(getUser({ params: { id: 7 } })).rejects.toMatchObject({
                name: 'StitchError',
                status: 404,
                url: 'https://api.example.com/users/7',
            });
        });
    });

    test('passes the response status through unchanged', async () => {
        const client = recordingClient(() => jsonResp(503, { error: 'busy' }));
        const res = await axiosAdapter(client)({
            url: 'http://h/u',
            method: 'GET',
            headers: {},
        });
        expect(res.status).toBe(503);
        expect(res.body).toEqual({ error: 'busy' });
    });
});

describe('the adapter seam', () => {
    test('a stitch runs end-to-end over the axios adapter', async () => {
        const client = recordingClient((cfg) =>
            jsonResp(200, { id: Number(cfg.url.split('/').pop()) }),
        );
        const getUser = stitch({
            url: 'https://api.example.com/users/{id}',
            adapter: axiosAdapter(client),
        });
        await expect(getUser({ params: { id: 7 } })).resolves.toEqual({
            id: 7,
        });
        expect(client.calls[0]?.url).toBe('https://api.example.com/users/7');
    });

    test('any custom adapter function satisfies the seam — not just fetch', async () => {
        let sawUrl = '';
        const custom: Adapter = async (req) => {
            sawUrl = req.url;
            return { status: 200, headers: {}, body: { via: 'custom' } };
        };
        const ping = stitch({
            url: 'https://api.example.com/ping',
            adapter: custom,
        });
        await expect(ping()).resolves.toEqual({ via: 'custom' });
        expect(sawUrl).toBe('https://api.example.com/ping');
    });
});

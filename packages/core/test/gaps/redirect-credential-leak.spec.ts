// SECURITY (HIGH) — credential exfiltration on a cross-origin redirect.
//
// Auth strategies put credentials in CUSTOM request headers: `apiKey` → `x-api-key`, `awsSigV4`
// → `authorization` + `x-amz-*`. When an endpoint answers a request with a 3xx redirect, the
// DEFAULT HTTP redirect policy re-sends every request header to the target. undici (Node's fetch)
// and axios's follow-redirects strip `authorization`/`cookie` on a CROSS-origin hop but NOT custom
// headers — so `x-api-key` / `x-amz-*` would leak to an attacker-controlled or unintended host
// (open-redirect, compromised endpoint). That breaks the "capability, not a credential" invariant.
//
// The fix: fetchAdapter follows redirects itself (`redirect: 'manual'` + a bounded loop) and, on a
// cross-origin hop, drops every non-CORS-safelisted request header; axiosAdapter installs a
// `beforeRedirect` hook that applies the same policy. Same-origin redirects keep the headers (the
// common case — auth must keep working).
//
// These tests FAIL before the fix (the second, redirect-target request still carries the
// credential) and PASS after. A same-origin companion asserts we don't OVER-strip.
import { axiosAdapter, env, fetchAdapter, stitch } from '../../src';
import type { AxiosLikeConfig, AxiosLikeResponse } from '../../src';
import { apiKey } from '../../src/auth';
import { headersForRedirect } from '../../src/http-adapter';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Keep this suite's trace sink quiet/captured (matches the other adapter specs).
process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-redirect-leak-${process.pid}.jsonl`,
);

// The sensitive headers that must never survive a cross-origin hop.
const API_KEY = 'sk-secret-key-value';
const AWS_AUTH = 'AWS4-HMAC-SHA256 Credential=AKIA.../...';

// A fetch spy that returns a scripted redirect chain. Each entry is the (status, headers) of the
// next response; a 3xx entry must carry a `location`. It records the headers of every request so a
// test can assert what the redirect target actually received. Typed as `typeof fetch` (the arrow is
// structurally assignable, so no cast is needed).
function redirectingFetch(
    steps: { status: number; headers?: Record<string, string> }[],
): {
    fetch: typeof fetch;
    requests: { url: string; headers: Record<string, string> }[];
} {
    const requests: { url: string; headers: Record<string, string> }[] = [];
    let i = 0;
    const fetch: typeof globalThis.fetch = (input, init) => {
        // fetchAdapter always calls fetch with a string URL as the first arg (never a Request).
        const url = input as string;
        const headers = (init?.headers ?? {}) as Record<string, string>;
        requests.push({ url, headers: { ...headers } });
        const step = steps[Math.min(i, steps.length - 1)];
        i++;
        const h = new Headers(step?.headers ?? {});
        // A terminal 200 returns a tiny JSON body so the adapter's parser has something to read.
        const body =
            step && step.status >= 300 && step.status < 400
                ? ''
                : '{"ok":true}';
        if (!h.has('content-type') && body)
            h.set('content-type', 'application/json');
        return Promise.resolve(
            new Response(body || null, {
                status: step?.status ?? 200,
                headers: h,
            }),
        );
    };
    return { fetch, requests };
}

// Pull a header case-insensitively from a recorded request.
const hdr = (h: Record<string, string>, name: string): string | undefined => {
    const k = Object.keys(h).find(
        (x) => x.toLowerCase() === name.toLowerCase(),
    );
    return k ? h[k] : undefined;
};

describe('fetchAdapter — cross-origin redirect must not forward auth/custom headers', () => {
    test('a 302 to ANOTHER origin drops x-api-key / authorization / x-amz-* on the second request', async () => {
        const { fetch: spy, requests } = redirectingFetch([
            {
                status: 302,
                headers: { location: 'https://evil.example.com/steal' },
            },
            { status: 200 },
        ]);

        const res = await fetchAdapter({ fetch: spy })({
            url: 'https://api.trusted.com/data',
            method: 'GET',
            headers: {
                'x-api-key': API_KEY,
                authorization: AWS_AUTH,
                'x-amz-date': '20260703T000000Z',
                'x-amz-content-sha256': 'abc123',
            },
        });

        // Two hops happened: the original request, then the redirect target.
        expect(requests).toHaveLength(2);
        expect(requests[0]?.url).toBe('https://api.trusted.com/data');
        expect(requests[1]?.url).toBe('https://evil.example.com/steal');

        // The whole point: NONE of the credential/custom headers reached the other origin.
        const leaked = requests[1]?.headers ?? {};
        expect(hdr(leaked, 'x-api-key')).toBeUndefined();
        expect(hdr(leaked, 'authorization')).toBeUndefined();
        expect(hdr(leaked, 'x-amz-date')).toBeUndefined();
        expect(hdr(leaked, 'x-amz-content-sha256')).toBeUndefined();

        // The response still flowed back, and url reflects the final hop.
        expect(res.status).toBe(200);
        expect(res.url).toBe('https://evil.example.com/steal');
    });

    test('end-to-end: a stitch with apiKey() auth does not leak the key across origins', async () => {
        const { fetch: spy, requests } = redirectingFetch([
            {
                status: 307,
                headers: { location: 'https://cdn.other.com/mirror' },
            },
            { status: 200 },
        ]);
        process.env['REDIRECT_TEST_KEY'] = API_KEY;

        const call = stitch({
            url: 'https://api.trusted.com/thing',
            method: 'GET',
            auth: apiKey({ value: env('REDIRECT_TEST_KEY') }),
            adapter: fetchAdapter({ fetch: spy }),
        });
        await call();

        expect(requests).toHaveLength(2);
        // First (trusted) request carried the key; the cross-origin hop must NOT.
        expect(hdr(requests[0]?.headers ?? {}, 'x-api-key')).toBe(API_KEY);
        expect(hdr(requests[1]?.headers ?? {}, 'x-api-key')).toBeUndefined();
    });

    test('a SAME-origin redirect KEEPS the headers (auth must keep working — do not over-strip)', async () => {
        const { fetch: spy, requests } = redirectingFetch([
            {
                status: 302,
                headers: { location: 'https://api.trusted.com/v2/data' },
            },
            { status: 200 },
        ]);

        await fetchAdapter({ fetch: spy })({
            url: 'https://api.trusted.com/data',
            method: 'GET',
            headers: { 'x-api-key': API_KEY, authorization: AWS_AUTH },
        });

        expect(requests).toHaveLength(2);
        // Same origin → the credential still rides the second request.
        expect(hdr(requests[1]?.headers ?? {}, 'x-api-key')).toBe(API_KEY);
        expect(hdr(requests[1]?.headers ?? {}, 'authorization')).toBe(AWS_AUTH);
    });

    test('a same-origin redirect on a DIFFERENT PORT is treated as cross-origin (host includes port)', async () => {
        const { fetch: spy, requests } = redirectingFetch([
            {
                status: 302,
                headers: { location: 'https://api.trusted.com:8443/data' },
            },
            { status: 200 },
        ]);

        await fetchAdapter({ fetch: spy })({
            url: 'https://api.trusted.com/data',
            method: 'GET',
            headers: { 'x-api-key': API_KEY },
        });

        expect(hdr(requests[1]?.headers ?? {}, 'x-api-key')).toBeUndefined();
    });

    test('caps redirect hops so a redirect loop cannot spin forever', async () => {
        // Every response is a same-origin 302 → an infinite loop if uncapped. The loop stops at the
        // hop cap (~20) and returns the last 3xx instead of hanging.
        const { fetch: spy, requests } = redirectingFetch([
            {
                status: 302,
                headers: { location: 'https://api.trusted.com/loop' },
            },
        ]);

        const res = await fetchAdapter({ fetch: spy })({
            url: 'https://api.trusted.com/loop',
            method: 'GET',
            headers: {},
        });

        expect(res.status).toBe(302);
        // Bounded: first request + at most 20 follows.
        expect(requests.length).toBeLessThanOrEqual(21);
        expect(requests.length).toBeGreaterThan(1);
    });
});

// A fake axios instance that captures the config it was handed (so we can drive the installed
// `beforeRedirect` hook exactly as follow-redirects would) and returns a scripted response.
function recordingAxios(respond: (cfg: AxiosLikeConfig) => AxiosLikeResponse): {
    request: (cfg: AxiosLikeConfig) => Promise<AxiosLikeResponse>;
    calls: AxiosLikeConfig[];
} {
    const calls: AxiosLikeConfig[] = [];
    return {
        calls,
        request: async (cfg) => {
            calls.push(cfg);
            return respond(cfg);
        },
    };
}

describe('axiosAdapter — beforeRedirect enforces the same cross-origin strip policy', () => {
    // Drive the adapter once to capture the beforeRedirect hook it installs, then invoke that hook
    // the way follow-redirects does — with an `options` bag describing the next hop.
    async function captureHook(): Promise<
        (options: Record<string, unknown>) => void
    > {
        const client = recordingAxios(() => ({
            status: 200,
            headers: { 'content-type': 'application/json' },
            data: Buffer.from('{"ok":true}'),
        }));
        await axiosAdapter(client)({
            url: 'https://api.trusted.com/data',
            method: 'GET',
            headers: { 'x-api-key': API_KEY, authorization: AWS_AUTH },
        });
        const hook = client.calls[0]?.['beforeRedirect'] as
            | ((options: Record<string, unknown>) => void)
            | undefined;
        if (!hook)
            throw new Error(
                'axiosAdapter did not install a beforeRedirect hook',
            );
        return hook;
    }

    test('a cross-origin next hop strips x-api-key + authorization from the outgoing headers', async () => {
        const hook = await captureHook();
        // follow-redirects passes the outgoing headers on `options.headers`; the hook resets that
        // property (the documented way to change headers from beforeRedirect).
        const options: Record<string, unknown> = {
            headers: {
                'x-api-key': API_KEY,
                authorization: AWS_AUTH,
                accept: 'application/json',
            },
            protocol: 'https:',
            host: 'evil.example.com',
            href: 'https://evil.example.com/steal',
        };
        hook(options);
        const sent = options['headers'] as Record<string, string>;

        expect(sent['x-api-key']).toBeUndefined();
        expect(sent['authorization']).toBeUndefined();
        // A CORS-safelisted header survives.
        expect(sent['accept']).toBe('application/json');
    });

    test('a same-origin next hop KEEPS the headers (does not over-strip)', async () => {
        const hook = await captureHook();
        const options: Record<string, unknown> = {
            headers: { 'x-api-key': API_KEY, authorization: AWS_AUTH },
            protocol: 'https:',
            host: 'api.trusted.com',
            href: 'https://api.trusted.com/v2/data',
        };
        hook(options);
        const sent = options['headers'] as Record<string, string>;

        expect(sent['x-api-key']).toBe(API_KEY);
        expect(sent['authorization']).toBe(AWS_AUTH);
    });
});

describe('headersForRedirect — the shared origin-check + strip policy', () => {
    const secret = {
        'x-api-key': API_KEY,
        authorization: AWS_AUTH,
        cookie: 'session=abc',
        'x-amz-date': '20260703T000000Z',
        accept: 'application/json',
        'content-type': 'application/json',
    };

    test('same origin → identical headers (returned by reference for zero-copy)', () => {
        const out = headersForRedirect(
            secret,
            'https://h.example/a',
            'https://h.example/b',
        );
        expect(out).toBe(secret);
    });

    test('cross origin → only CORS-safelisted headers survive', () => {
        const out = headersForRedirect(
            secret,
            'https://h.example/a',
            'https://other.example/b',
        );
        expect(out).toEqual({
            accept: 'application/json',
            'content-type': 'application/json',
        });
    });

    test('cross scheme (https→http, same host) is cross-origin', () => {
        const out = headersForRedirect(
            secret,
            'https://h.example/a',
            'http://h.example/a',
        );
        expect(out['x-api-key']).toBeUndefined();
    });

    test('an unparseable target fails safe (treated as cross-origin, headers stripped)', () => {
        const out = headersForRedirect(
            secret,
            'https://h.example/a',
            'not a url',
        );
        expect(out['x-api-key']).toBeUndefined();
        expect(out['authorization']).toBeUndefined();
    });
});

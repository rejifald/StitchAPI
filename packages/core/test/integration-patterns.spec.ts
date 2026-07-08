// Validates the runtime against real-world third-party integration ARCHETYPES (modeled from
// production apps, kept deliberately brand-neutral). Each test proves a hand-rolled per-
// integration pain is replaced by one declarative stitch. Headline: a silent HTML-scrape
// breakage becomes a loud drift error.
import { apiKey, bearer, cookieSession, drift, env, stitch } from '../src';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-patterns-${process.pid}.jsonl`,
);

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

// A faithful-enough HTML scraper. The score selector is hardcoded to `td.score` — exactly
// the kind of selector a markup rename (score -> rank) silently breaks.
function scrapeListings(html: unknown): {
    items: Record<string, unknown>[];
} {
    const text = String(html);
    const rows = text.split(/<tr[^>]*class="(?:row1|row2)"[^>]*>/i).slice(1);
    const items = rows.map((row) => {
        const item: Record<string, unknown> = {};
        const title =
            /<td[^>]*class="title"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/i.exec(
                row,
            );
        const score = /<td[^>]*class="score"[^>]*>\s*(\d+)\s*<\/td>/i.exec(
            row,
        )?.[1];
        if (title) {
            item['title'] = title[2]!.trim();
            item['link'] = title[1];
        }
        if (score) item['score'] = Number(score); // omitted when the selector misses
        return item;
    });
    return { items };
}

const listingRow = (scoreClass: string) =>
    `<tr class="row1"><td class="title"><a href="/i/1">Item A</a></td>` +
    `<td class="${scoreClass}">42</td><td><a href="/dl/1">dl</a></td></tr>`;

// =========================================================================================
describe('GraphQL-over-HTTP API (ApiKey header, 1 req/s bucket, retry on 429/5xx)', () => {
    test('sends the ApiKey header and retries on 429, then succeeds', async () => {
        process.env['METADATA_API_KEY'] = 'sk_meta_123';
        server.route('POST', '/graphql', {
            statuses: [429, 200],
            body: { data: { query: { count: 1 } } },
        });

        const query = stitch({
            method: 'POST',
            baseUrl: server.url,
            path: '/graphql',
            auth: apiKey({ name: 'apikey', value: env('METADATA_API_KEY') }),
            retry: { attempts: 5, on: [429, 500, 502, 503], baseDelay: 5 },
            pick: 'data',
        });

        const out = await query({
            body: { query: 'query { query { count } }' },
        });
        expect(out).toEqual({ query: { count: 1 } });
        expect(server.callCount('/graphql')).toBe(2); // 429 then 200
        expect(server.calls('/graphql').at(-1)?.headers['apikey']).toBe(
            'sk_meta_123',
        );
    });

    test('throttles to ~1 request/second across calls', async () => {
        server.route('POST', '/graphql', { body: { data: {} } });
        const q = stitch({
            method: 'POST',
            baseUrl: server.url,
            path: '/graphql',
            auth: apiKey({ name: 'apikey', value: () => 'sk' }),
            throttle: { rate: '1/s' },
        });
        const start = Date.now();
        await q({ body: { query: '{a}' } });
        await q({ body: { query: '{b}' } });
        expect(Date.now() - start).toBeGreaterThanOrEqual(900);
    });
});

// =========================================================================================
describe('Session-cookie admin API (auto re-login on 403)', () => {
    test('auto-logs-in, replays the session cookie, and re-logs-in on a 403 — never exposing the password', async () => {
        process.env['CLIENT_USER'] = 'admin';
        process.env['CLIENT_PASS'] = 'secret';
        server.route('POST', '/auth/login', {
            setCookie: { name: 'SID', value: 'SID-OK' },
            body: { ok: true },
        });
        // first data call 403 (stale/no session) -> after re-login, 200
        server.route('GET', '/resources', {
            statuses: [403, 200],
            body: () => [{ id: 'abc', state: 'active' }],
        });

        const login = stitch({
            method: 'POST',
            baseUrl: server.url,
            path: '/auth/login',
            bodyType: 'form',
        });
        const resources = stitch({
            baseUrl: server.url,
            path: '/resources',
            auth: cookieSession({
                login,
                cookie: 'SID',
                tenancy: 'app',
                refreshOn: 403, // this integration uses 403, not 401 (bare status ≡ [403], CONTRACT.md P7)
                loginInput: () => ({
                    body: {
                        username: env('CLIENT_USER')(),
                        password: env('CLIENT_PASS')(),
                    },
                }),
            }),
        });

        const out = await resources(); // caller passes NO credentials
        expect(out).toEqual([{ id: 'abc', state: 'active' }]);
        expect(server.callCount('/auth/login')).toBe(2); // initial auto-login + refresh after 403
        expect(server.callCount('/resources')).toBe(2);
        expect(server.calls('/resources').at(-1)?.cookies['SID']).toBe(
            'SID-OK',
        );
    });
});

// =========================================================================================
describe('HTML scrape provider — silent markup breakage becomes a loud drift error', () => {
    test('a markup class rename (score -> rank) is caught as a drift ERROR instead of silent undefined', async () => {
        process.env['SCRAPE_USER'] = 'u';
        process.env['SCRAPE_PASS'] = 'p';

        server.route('POST', '/login', {
            setCookie: { name: 'session_id', value: 'SESS' },
            body: 'ok',
        });
        // call #1 has the original markup; call #2 renames the score cell class.
        server.route('GET', '/search', {
            requireCookie: { name: 'session_id' },
            body: [
                `<table>${listingRow('score')}</table>`,
                `<table>${listingRow('rank')}</table>`,
            ],
        });

        const login = stitch({
            method: 'POST',
            baseUrl: server.url,
            path: '/login',
            bodyType: 'form',
        });
        const search = stitch({
            baseUrl: server.url,
            path: '/search',
            auth: cookieSession({
                login,
                cookie: 'session_id',
                tenancy: 'app',
                loginInput: () => ({
                    body: {
                        username: env('SCRAPE_USER')(),
                        password: env('SCRAPE_PASS')(),
                    },
                }),
            }),
            throttle: { rate: '5/s' },
            transform: scrapeListings, // HTML -> { items: [...] }
            pick: 'items',
            // `score` is REQUIRED — the schema is the contract, so a markup rename that drops it
            // is a loud validation error, not a silent gap. No snapshot, no baseline call.
            output: drift(
                z.array(
                    z.object({
                        title: z.string(),
                        link: z.string().optional(),
                        score: z.number(),
                    }),
                ),
            ),
        });

        // call #1: original markup -> score present, validates clean.
        const first = await search({ query: { q: 'item' } });
        expect(first).toEqual([{ title: 'Item A', link: '/i/1', score: 42 }]);

        // call #2: renamed markup -> scraper silently drops score. The runtime must SHOUT.
        const findings: { level: string; path: string; change: string }[] = [];
        let rejected = false;
        try {
            for await (const ev of search.stream({ query: { q: 'item' } })) {
                if (ev.type === 'drift') findings.push(ev.finding);
                if (ev.type === 'error') rejected = true;
            }
        } catch {
            rejected = true;
        }
        const scoreDrift = findings.find((f) => f.path.includes('score'));
        expect(scoreDrift).toBeDefined();
        expect(scoreDrift?.level).toBe('error');
        expect(scoreDrift?.change).toBe('invalid');
        expect(rejected).toBe(true); // a required-field violation is fatal, not silent
    });
});

// =========================================================================================
describe('Diverse co-located auth (three providers, three header formats)', () => {
    test('each provider sends its own auth header format', async () => {
        process.env['REST_API_KEY'] = 'rest_tok';
        process.env['MEDIA_A_TOKEN'] = 'media_a';
        process.env['MEDIA_B_TOKEN'] = 'media_b';
        server.route('GET', '/catalog', { body: { results: [] } });
        server.route('GET', '/system', { body: { name: 'a' } });
        server.route('GET', '/node', { body: { name: 'b' } });

        const restApi = stitch({
            baseUrl: server.url,
            path: '/catalog',
            auth: bearer(env('REST_API_KEY')),
        });
        const mediaA = stitch({
            baseUrl: server.url,
            path: '/system',
            auth: apiKey({
                name: 'authorization',
                value: () => `MediaToken token="${env('MEDIA_A_TOKEN')()}"`,
            }),
        });
        const mediaB = stitch({
            baseUrl: server.url,
            path: '/node',
            auth: apiKey({
                name: 'x-media-token',
                value: env('MEDIA_B_TOKEN'),
            }),
            hooks: {
                onRequest: ({ req }) =>
                    void (req && (req.headers['x-client-id'] = 'app')),
            },
        });

        await restApi();
        await mediaA();
        await mediaB();

        expect(server.calls('/catalog')[0]?.headers['authorization']).toBe(
            'Bearer rest_tok',
        );
        expect(server.calls('/system')[0]?.headers['authorization']).toBe(
            'MediaToken token="media_a"',
        );
        expect(server.calls('/node')[0]?.headers['x-media-token']).toBe(
            'media_b',
        );
        expect(server.calls('/node')[0]?.headers['x-client-id']).toBe('app');
    });
});

// The feature registry. Each demo wires a behavior-simulating mock backend (reusing the
// tested mock-server) and one or more "plays" (a stitch + input) that the server streams
// live to the browser. Keep it brand-neutral — these are integration ARCHETYPES.
import {
    apiKey,
    bearer,
    cookieSession,
    defineStitch,
    drift,
    env,
    graphql,
    preset,
    stitch,
} from '../core/src';
import type { Stitch, StitchInput } from '../core/src/types';
import type { MockServer } from '../core/test/support/mock-server';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export interface Play {
    label?: string;
    stitch: Stitch;
    input?: StitchInput;
}
export interface DemoRun {
    plays: Play[];
    /** optional human note rendered above the event log */
    note?: string;
}
export interface Demo {
    id: string;
    title: string;
    blurb: string;
    group: string;
    setup(mock: MockServer): DemoRun;
}

const snap = (id: string) => join(tmpdir(), `pg-${id}-${Date.now()}.json`);

export const demos: Demo[] = [
    {
        id: 'event-stream',
        group: 'Core',
        title: 'Live event stream + await',
        blurb: 'One GET emits start → request → result → done, streamed live.',
        setup(mock) {
            mock.route('GET', '/hello', {
                delayMs: 300,
                body: { message: 'hello from a stitch' },
            });
            return {
                plays: [
                    { stitch: stitch({ baseUrl: mock.url, path: '/hello' }) },
                ],
            };
        },
    },
    {
        id: 'retry',
        group: 'Resilience',
        title: 'Retry with backoff',
        blurb: 'The server fails twice (503) then succeeds — watch the retry events arrive.',
        setup(mock) {
            mock.route('GET', '/flaky', {
                statuses: [503, 503, 200],
                delayMs: 120,
                body: { ok: true },
            });
            const s = stitch({
                baseUrl: mock.url,
                path: '/flaky',
                retry: { attempts: 3, on: [503], baseMs: 300 },
            });
            return {
                plays: [{ stitch: s }],
                note: 'retry: { attempts: 3, on: [503] } — backoff is visible between attempts.',
            };
        },
    },
    {
        id: 'auth-wall',
        group: 'Auth',
        title: 'Auth-wall: capability, not credential',
        blurb: 'cookieSession auto-logs-in and replays the cookie; the caller passes no secret.',
        setup(mock) {
            process.env.PG_USER = 'admin';
            process.env.PG_PASS = 'secret';
            mock.route('POST', '/login', {
                setCookie: { name: 'SID', value: 'OK' },
                body: { ok: true },
            });
            mock.route('GET', '/me', {
                requireCookie: { name: 'SID' },
                delayMs: 150,
                body: { user: 'ada' },
            });
            const login = stitch({
                method: 'POST',
                baseUrl: mock.url,
                path: '/login',
                bodyType: 'form',
            });
            const me = stitch({
                baseUrl: mock.url,
                path: '/me',
                auth: cookieSession({
                    login,
                    cookie: 'SID',
                    loginInput: () => ({
                        body: {
                            username: env('PG_USER')(),
                            password: env('PG_PASS')(),
                        },
                    }),
                }),
            });
            return {
                plays: [{ stitch: me }],
                note: 'me() is called with NO arguments — the stitch holds the credential.',
            };
        },
    },
    {
        id: 'drift',
        group: 'Contracts',
        title: 'Leveled drift detection',
        blurb: 'Run 1 records the contract; run 2 ships a shape change and fires a drift event.',
        setup(mock) {
            mock.route('GET', '/item', {
                body: [{ id: 1, score: 42 }, { id: 1 }],
            }); // [baseline, score removed]
            const s = stitch({
                baseUrl: mock.url,
                path: '/item',
                output: drift(
                    z.object({ id: z.number(), score: z.number().optional() }),
                    {
                        critical: ['score'],
                        snapshotFile: snap('drift'),
                    },
                ),
            });
            return {
                plays: [
                    { label: 'baseline (records contract)', stitch: s },
                    { label: 'after a breaking change', stitch: s },
                ],
                note: 'critical: ["score"] — losing it on run 2 is a fatal drift error, not a silent undefined.',
            };
        },
    },
    {
        id: 'composition',
        group: 'Composition',
        title: 'Three facades, one engine',
        blurb: 'extends, defineStitch, and the fluent builder produce the same stitch over a shared preset.',
        setup(mock) {
            mock.route('GET', '/thing', { body: { data: { name: 'Ada' } } });
            const base = preset({ baseUrl: mock.url });

            // A) extends: list the preset as a fragment.
            const viaExtends = stitch({
                extends: [base],
                path: '/thing',
                unwrap: 'data',
            });
            // B) defineStitch: bind the preset, then call the returned factory.
            const make = defineStitch(base);
            const viaDefine = make({ path: '/thing', unwrap: 'data' });
            // C) fluent builder: chain over the same preset.
            const viaBuilder = stitch.use(base).get('/thing').unwrap('data');

            return {
                plays: [
                    { label: 'extends', stitch: viaExtends },
                    { label: 'defineStitch', stitch: viaDefine },
                    { label: 'fluent builder', stitch: viaBuilder },
                ],
                note: 'Three facades, one engine.',
            };
        },
    },
    {
        id: 'throttle',
        group: 'Resilience',
        title: 'Proactive throttle (rate limit)',
        blurb: 'rate: "2/s" paces calls client-side — the 2nd and 3rd calls wait their turn before the request fires.',
        setup(mock) {
            mock.route('GET', '/ping', { body: { pong: true } });
            // ONE stitch instance reused across plays: its runtime holds the shared throttle state.
            const s = stitch({
                baseUrl: mock.url,
                path: '/ping',
                throttle: { rate: '2/s' },
            });
            return {
                plays: [
                    { label: 'call 1 (immediate)', stitch: s },
                    { label: 'call 2 (paced)', stitch: s },
                    { label: 'call 3 (paced)', stitch: s },
                ],
                note: 'rate: "2/s" — later calls emit a throttled progress event with waitedMs > 0.',
            };
        },
    },
    {
        id: 'timeout',
        group: 'Resilience',
        title: 'Timeout aborts a slow call',
        blurb: 'The server sleeps 800ms; a 200ms total timeout aborts the request instead of hanging.',
        setup(mock) {
            mock.route('GET', '/slow', { delayMs: 800, body: { ok: true } });
            const s = stitch({
                baseUrl: mock.url,
                path: '/slow',
                timeout: { total: 200 },
            });
            return {
                plays: [{ stitch: s }],
                note: 'timeout: { total: 200 } — the run errors at ~200ms, not after the 800ms server delay.',
            };
        },
    },
    {
        id: 'auth-headers',
        group: 'Auth',
        title: 'Header auth injection (bearer + apiKey)',
        blurb: 'The stitch holds the credential and injects it; the echo route proves the header arrived (200), and rejects without it (401).',
        setup(mock) {
            process.env.PG_BEARER = 'tok_secret_123';
            process.env.PG_KEY = 'key_secret_456';

            // Each route requires its auth header (401 otherwise) and echoes the received value.
            mock.route('GET', '/bearer', {
                requireHeader: { name: 'authorization' },
                body: (_i, req) => ({
                    authorization: req.headers['authorization'],
                }),
            });
            mock.route('GET', '/apikey', {
                requireHeader: { name: 'x-api-key' },
                body: (_i, req) => ({ 'x-api-key': req.headers['x-api-key'] }),
            });

            const bearerStitch = stitch({
                baseUrl: mock.url,
                path: '/bearer',
                auth: bearer(env('PG_BEARER')),
            });
            const apiKeyStitch = stitch({
                baseUrl: mock.url,
                path: '/apikey',
                auth: apiKey({ header: 'x-api-key', value: env('PG_KEY') }),
            });

            return {
                plays: [
                    { label: 'bearer(env("PG_BEARER"))', stitch: bearerStitch },
                    {
                        label: 'apiKey({ header: "x-api-key" })',
                        stitch: apiKeyStitch,
                    },
                ],
                note: 'The result echoes the injected header — the caller passed no secret.',
            };
        },
    },
    {
        id: 'content-refresh',
        group: 'Auth',
        title: 'Content-aware session refresh',
        blurb: 'A 200 that is really a login page is a soft wall — a content predicate triggers re-login, then the real data flows.',
        setup(mock) {
            process.env.PG_SOFT_USER = 'u';
            process.env.PG_SOFT_PASS = 'p';

            mock.route('POST', '/login', {
                setCookie: { name: 'SID', value: 'OK' },
                body: 'ok',
            });
            // call #0: a 200 login page (stale session); call #1: the real data.
            mock.route('GET', '/data', {
                statuses: [200, 200],
                body: ['<html>please log in</html>', { items: [1, 2] }],
            });

            const login = stitch({
                method: 'POST',
                baseUrl: mock.url,
                path: '/login',
                bodyType: 'form',
            });
            const data = stitch({
                baseUrl: mock.url,
                path: '/data',
                auth: cookieSession({
                    login,
                    cookie: 'SID',
                    // status is 200, so only a content predicate can catch this wall:
                    refreshWhen: (res) =>
                        typeof res.body === 'string' &&
                        /log in/i.test(res.body),
                    loginInput: () => ({
                        body: {
                            u: env('PG_SOFT_USER')(),
                            p: env('PG_SOFT_PASS')(),
                        },
                    }),
                }),
            });

            return {
                plays: [{ stitch: data }],
                note: 'refreshWhen sees the login page in the 200 body, re-logs-in, then returns { items: [1, 2] }.',
            };
        },
    },
    {
        id: 'body-encoding',
        group: 'Requests',
        title: 'Request body encoding (form / multipart)',
        blurb: 'The same stitch shape sends url-encoded or multipart bodies; the echo route shows the content-type and what it received.',
        setup(mock) {
            // Echo the received content-type + body so encoding is visible in the result.
            mock.route('POST', '/echo', {
                body: (_i, req) => ({
                    contentType: req.headers['content-type'],
                    received: req.body,
                }),
            });

            const form = stitch({
                method: 'POST',
                baseUrl: mock.url,
                path: '/echo',
                bodyType: 'form',
            });
            const multipart = stitch({
                method: 'POST',
                baseUrl: mock.url,
                path: '/echo',
                bodyType: 'multipart',
            });

            return {
                plays: [
                    {
                        label: 'form',
                        stitch: form,
                        input: { body: { a: 1, b: 'x y' } },
                    },
                    {
                        label: 'multipart',
                        stitch: multipart,
                        input: {
                            body: {
                                field: 'v',
                                file: {
                                    value: new Uint8Array([1, 2, 3]),
                                    filename: 'a.bin',
                                },
                            },
                        },
                    },
                ],
                note: 'bodyType: "form" → x-www-form-urlencoded; "multipart" → multipart/form-data with a named file part.',
            };
        },
    },
    {
        id: 'graphql',
        group: 'Kinds',
        title: 'GraphQL-over-HTTP (data + errors)',
        blurb: 'A graphql() stitch posts { query, variables } and unwraps data; a 200 carrying errors[] surfaces as an error.',
        setup(mock) {
            mock.route('POST', '/graphql', {
                body: [
                    { data: { thing: { name: 'Ada' } } },
                    { errors: [{ message: 'thing not found' }] },
                ],
            });
            const s = graphql({
                baseUrl: mock.url,
                query: 'query($id: ID) { thing(id: $id) { name } }',
            });
            return {
                plays: [
                    {
                        label: 'resolves',
                        stitch: s,
                        input: { variables: { id: 1 } },
                    },
                    {
                        label: 'GraphQL error',
                        stitch: s,
                        input: { variables: { id: 999 } },
                    },
                ],
                note: 'Play 2 returns HTTP 200 but carries errors[] — the runtime treats it as a failure.',
            };
        },
    },
    {
        id: 'scrape-drift',
        group: 'Contracts',
        title: 'Silent scrape breakage → loud drift error',
        blurb: 'A hardcoded HTML selector (td.score) silently drops a field when markup is renamed — drift turns that into a fatal contract error.',
        setup(mock) {
            // A small scraper: one row per <tr>, title from td.title's anchor, score from td.score.
            // When the score cell's class is renamed, the selector misses and score is OMITTED.
            const scrape = (
                html: unknown,
            ): { items: Array<Record<string, unknown>> } => {
                const text = String(html);
                const rows = text.split(/<tr[^>]*>/i).slice(1);
                const items = rows.map((row) => {
                    const item: Record<string, unknown> = {};
                    const title =
                        /<td[^>]*class="title"[^>]*>\s*<a[^>]*>([^<]+)<\/a>/i.exec(
                            row,
                        );
                    const score =
                        /<td[^>]*class="score"[^>]*>\s*(\d+)\s*<\/td>/i.exec(
                            row,
                        )?.[1];
                    if (title) item.title = title[1].trim();
                    if (score !== undefined) item.score = Number(score); // omitted when the class is renamed
                    return item;
                });
                return { items };
            };

            const row = (scoreClass: string) =>
                `<tr><td class="title"><a href="/i/1">Item A</a></td><td class="${scoreClass}">42</td></tr>`;
            // call #1: original markup (td.score); call #2: class renamed to td.rank.
            mock.route('GET', '/search', {
                body: [
                    `<table>${row('score')}</table>`,
                    `<table>${row('rank')}</table>`,
                ],
            });

            const s = stitch({
                baseUrl: mock.url,
                path: '/search',
                transform: scrape,
                unwrap: 'items',
                output: drift(
                    z.array(
                        z.object({
                            title: z.string(),
                            score: z.number().optional(),
                        }),
                    ),
                    {
                        critical: ['[].score'],
                        snapshotFile: snap('scrape'),
                    },
                ),
            });

            return {
                plays: [
                    { label: 'baseline (score present)', stitch: s },
                    { label: 'markup renamed (score dropped)', stitch: s },
                ],
                note: 'critical: ["[].score"] — a renamed selector silently loses score; the runtime fires a fatal drift error instead.',
            };
        },
    },
    {
        id: 'static-headers',
        group: 'Requests',
        title: 'Static headers: merge + override',
        blurb: 'A preset header, a stitch header, and a per-call header layer and override — the echo route shows the final set.',
        setup(mock) {
            mock.route('GET', '/echo-headers', {
                body: (_i, req) => ({ received: req.headers }),
            });
            const base = preset({ headers: { 'x-trace': 't1' } });
            const s = stitch({
                extends: [base],
                baseUrl: mock.url,
                path: '/echo-headers',
                headers: { 'x-app': 'demo' },
            });
            return {
                plays: [
                    { stitch: s, input: { headers: { 'x-app': 'override' } } },
                ],
                note: 'x-trace from the preset survives; x-app from the stitch is overridden by the per-call header.',
            };
        },
    },
];

// Re-exported so the demo-completion agent can use the same helpers/types.
export {
    apiKey,
    bearer,
    cookieSession,
    drift,
    env,
    graphql,
    preset,
    stitch,
    z,
    snap,
};

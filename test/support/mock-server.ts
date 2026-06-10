import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

export interface ReqInfo {
    method: string;
    path: string;
    headers: Record<string, string>;
    cookies: Record<string, string>;
    query: Record<string, string>;
    body: unknown;
}

export interface RouteBehavior {
    statuses?: number[];
    delayMs?: number | number[];
    body?: unknown | unknown[] | ((callIndex: number, req: ReqInfo) => unknown);
    requireCookie?: { name: string; value?: string };
    requireHeader?: { name: string; value?: string };
    setCookie?: { name: string; value: string };
    setCookies?: Array<{ name: string; value: string }>;
    retryAfter?: number;
    headers?: Record<string, string>;
}

export interface MockServer {
    url: string;
    route(method: string, path: string, behavior: RouteBehavior): void;
    calls(path?: string): ReqInfo[];
    callCount(path?: string): number;
    reset(): void;
    close(): Promise<void>;
}

const at = (arr: unknown[], i: number): unknown =>
    arr[Math.min(i, arr.length - 1)];

const parseCookies = (header: string | undefined): Record<string, string> => {
    const out: Record<string, string> = {};
    if (!header) return out;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    return out;
};

const collectHeaders = (req: IncomingMessage): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
        out[k.toLowerCase()] = Array.isArray(v)
            ? v.join(', ')
            : String(v ?? '');
    }
    return out;
};

const readBody = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolve) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (!raw) return resolve(undefined);
            try {
                resolve(JSON.parse(raw));
            } catch {
                resolve(raw);
            }
        });
        req.on('error', () => resolve(undefined));
    });

export function startMockServer(): Promise<MockServer> {
    const routes = new Map<string, RouteBehavior>();
    const counters = new Map<string, number>();
    const log: ReqInfo[] = [];
    const key = (method: string, path: string): string =>
        `${method.toUpperCase()} ${path}`;

    const handler = async (
        req: IncomingMessage,
        res: ServerResponse,
    ): Promise<void> => {
        const method = (req.method ?? 'GET').toUpperCase();
        const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
        const path = parsed.pathname;
        const query: Record<string, string> = {};
        for (const [k, v] of parsed.searchParams.entries()) query[k] = v;
        const headers = collectHeaders(req);
        const info: ReqInfo = {
            method,
            path,
            headers,
            cookies: parseCookies(headers.cookie),
            query,
            body: await readBody(req),
        };
        log.push(info);

        const rk = key(method, path);
        const behavior = routes.get(rk);
        const send = (
            status: number,
            payload: unknown,
            extra?: RouteBehavior,
        ): void => {
            const out: Record<string, string | string[]> = {
                'content-type': 'application/json',
            };
            if (extra?.headers) Object.assign(out, extra.headers);
            if (extra?.setCookie)
                out['Set-Cookie'] =
                    `${extra.setCookie.name}=${extra.setCookie.value}`;
            if (extra?.setCookies)
                // Multiple Set-Cookie headers (array value → one header line each).
                out['Set-Cookie'] = extra.setCookies.map(
                    (c) => `${c.name}=${c.value}`,
                );
            if (extra?.retryAfter !== undefined)
                out['Retry-After'] = String(extra.retryAfter);
            res.writeHead(status, out);
            res.end(JSON.stringify(payload));
        };

        if (!behavior) return send(404, { error: 'not_found' });

        const ck = behavior.requireCookie;
        if (
            ck &&
            (info.cookies[ck.name] === undefined ||
                (ck.value !== undefined && info.cookies[ck.name] !== ck.value))
        )
            return send(401, { error: 'unauthorized' });
        const hd = behavior.requireHeader;
        if (hd) {
            const have = headers[hd.name.toLowerCase()];
            if (
                have === undefined ||
                (hd.value !== undefined && have !== hd.value)
            )
                return send(401, { error: 'unauthorized' });
        }

        const idx = counters.get(rk) ?? 0;
        counters.set(rk, idx + 1);

        const status = behavior.statuses
            ? (at(behavior.statuses, idx) as number)
            : 200;
        let body: unknown = {};
        if (typeof behavior.body === 'function') {
            body = (behavior.body as (i: number, r: ReqInfo) => unknown)(
                idx,
                info,
            );
        } else if (Array.isArray(behavior.body)) {
            body = at(behavior.body, idx);
        } else if (behavior.body !== undefined) {
            body = behavior.body;
        }

        let delay = 0;
        if (Array.isArray(behavior.delayMs))
            delay = (at(behavior.delayMs, idx) as number) ?? 0;
        else if (typeof behavior.delayMs === 'number') delay = behavior.delayMs;

        const respond = (): void => send(status, body, behavior);
        if (delay > 0) setTimeout(respond, delay);
        else respond();
    };

    const server: Server = createServer((req, res) => {
        handler(req, res).catch(() => {
            if (!res.headersSent)
                res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'internal' }));
        });
    });

    const filter = (path?: string): ReqInfo[] =>
        path ? log.filter((r) => r.path === path) : log.slice();

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            resolve({
                url: `http://127.0.0.1:${port}`,
                route(method, path, behavior) {
                    routes.set(key(method, path), behavior);
                },
                calls: filter,
                callCount: (path) => filter(path).length,
                reset() {
                    routes.clear();
                    counters.clear();
                    log.length = 0;
                },
                close: () =>
                    new Promise<void>((res) => server.close(() => res())),
            });
        });
    });
}

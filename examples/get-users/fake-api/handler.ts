import { USERS } from './users';

export interface FakeResponse {
    status: number;
    body: unknown;
}

const SUPPORT = {
    url: 'https://github.com/rejifald/StitchAPI',
    text: 'This data is served by the in-sandbox fake API — no external service involved.',
};

/**
 * A tiny framework-agnostic request handler. It knows nothing about Vite, Node
 * servers, or browsers — it just maps a (method, pathname, query) tuple to a
 * JSON response. That keeps the "fake API" reusable: the Vite plugin mounts it
 * as middleware, but you could just as easily drop it behind Express, MSW, or a
 * Cloudflare Worker.
 */
export function handleRequest(
    method: string,
    pathname: string,
    query: URLSearchParams,
): FakeResponse | null {
    if (method !== 'GET') {
        return null;
    }

    // GET /api/users/:id
    const single = /^\/api\/users\/(\d+)$/.exec(pathname);
    if (single) {
        const id = Number(single[1]);
        const user = USERS.find((u) => u.id === id);

        if (!user) {
            return { status: 404, body: {} };
        }

        return { status: 200, body: { data: user, support: SUPPORT } };
    }

    // GET /api/users
    if (pathname === '/api/users') {
        const perPage = clampInt(query.get('per_page'), 6, 1, 12);
        const page = clampInt(query.get('page'), 1, 1, Math.ceil(USERS.length / perPage));
        const start = (page - 1) * perPage;
        const data = USERS.slice(start, start + perPage);

        return {
            status: 200,
            body: {
                page,
                per_page: perPage,
                total: USERS.length,
                total_pages: Math.ceil(USERS.length / perPage),
                data,
                support: SUPPORT,
            },
        };
    }

    return null;
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
    const parsed = raw === null ? NaN : Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) {
        return fallback;
    }
    return Math.min(Math.max(parsed, min), max);
}

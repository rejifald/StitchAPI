// Pagination: one logical stitch call that follows pages and aggregates items. Each page is
// a full request (so auth/retry/throttle apply) and emits a `paginate` progress event.
import { graphql, stitch } from '../src';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-paginate-${process.pid}.jsonl`,
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

// A 3-page endpoint keyed off ?page=N.
function paged() {
    return (_i: number, req: { query: Record<string, string> }) => {
        const page = Number(req.query['page'] ?? '1');
        const pages = [[1, 2], [3, 4], [5]];
        const data = pages[page - 1] ?? [];
        return { data, page, hasMore: page < pages.length };
    };
}

const listAll = () =>
    stitch<number[]>({
        baseUrl: server.url,
        path: '/list',
        unwrap: 'data',
        paginate: {
            next: (body, fetched) =>
                (body as { hasMore: boolean }).hasMore
                    ? { query: { page: fetched + 1 } }
                    : undefined,
        },
    });

test('follows pages and aggregates items into one result', async () => {
    server.route('GET', '/list', { body: paged() });
    await expect(listAll()()).resolves.toEqual([1, 2, 3, 4, 5]);
    expect(server.callCount('/list')).toBe(3); // three real requests, one logical call
});

test('emits a paginate progress event per page', async () => {
    server.route('GET', '/list', { body: paged() });
    const pages: unknown[] = [];
    let result: unknown;
    for await (const ev of listAll().stream()) {
        if (ev.type === 'progress' && ev.phase === 'paginate') pages.push(ev);
        if (ev.type === 'result') result = ev.value;
    }
    expect(pages.length).toBe(3);
    expect(result).toEqual([1, 2, 3, 4, 5]);
});

test('paginated GraphQL advances its cursor through the variables slot', async () => {
    // The page is selected by the `after` VARIABLE the paginator threads back — exactly how a
    // cursor-paginated GraphQL API works. If the engine drops `variables` when folding the next
    // page's input, page 2 loses the cursor, re-fetches page 1, and loops until `max`.
    interface GqlReq {
        variables?: { after?: string };
    }
    const page = (
        nodes: number[],
        endCursor: string | undefined,
        hasNextPage: boolean,
    ) => ({ data: { users: { nodes, pageInfo: { endCursor, hasNextPage } } } });
    server.route('POST', '/gql', {
        body: (_i: number, req: { body: unknown }) => {
            const after = (req.body as GqlReq).variables?.after;
            if (!after) return page([1, 2], 'c1', true);
            if (after === 'c1') return page([3, 4], undefined, false);
            return page([], undefined, false);
        },
    });
    const listUsers = graphql({
        baseUrl: server.url,
        path: '/gql',
        query: 'query($after: String) { users(after: $after) { nodes pageInfo { endCursor hasNextPage } } }',
        unwrap: 'data.users.nodes',
        paginate: {
            next: (body) => {
                const pi = (
                    body as {
                        data: {
                            users: {
                                pageInfo: {
                                    endCursor?: string;
                                    hasNextPage: boolean;
                                };
                            };
                        };
                    }
                ).data.users.pageInfo;
                return pi.hasNextPage
                    ? { variables: { after: pi.endCursor } }
                    : undefined;
            },
        },
    });
    await expect(listUsers()).resolves.toEqual([1, 2, 3, 4]);
    expect(server.callCount('/gql')).toBe(2); // two real requests; the cursor advanced
});

test('max caps the page loop (guards a runaway paginator)', async () => {
    server.route('GET', '/loop', {
        body: () => ({ data: [1], hasMore: true }),
    }); // never signals "done"
    const list = stitch({
        baseUrl: server.url,
        path: '/loop',
        unwrap: 'data',
        paginate: { next: () => ({}), max: 2 },
    });
    await list();
    expect(server.callCount('/loop')).toBe(2); // stopped at the cap, not infinitely
});

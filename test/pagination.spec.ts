// Pagination: one logical stitch call that follows pages and aggregates items. Each page is
// a full request (so auth/retry/throttle apply) and emits a `paginate` progress event.
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.STITCH_TRACE_FILE = join(tmpdir(), `stitch-paginate-${process.pid}.jsonl`);

import { stitch } from '../src';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

let server: MockServer;
beforeAll(async () => {
    server = await startMockServer();
});
afterAll(async () => {
    await server.close();
});
beforeEach(() => server.reset());

// A 3-page endpoint keyed off ?page=N.
function paged() {
    return (_i: number, req: { query: Record<string, string> }) => {
        const page = Number(req.query.page ?? '1');
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
            next: (body, fetched) => ((body as { hasMore: boolean }).hasMore ? { query: { page: fetched + 1 } } : undefined),
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

test('max caps the page loop (guards a runaway paginator)', async () => {
    server.route('GET', '/loop', { body: () => ({ data: [1], hasMore: true }) }); // never signals "done"
    const list = stitch({
        baseUrl: server.url,
        path: '/loop',
        unwrap: 'data',
        paginate: { next: () => ({}), max: 2 },
    });
    await list();
    expect(server.callCount('/loop')).toBe(2); // stopped at the cap, not infinitely
});

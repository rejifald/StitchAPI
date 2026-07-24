// Pins docs/GAP-AUDIT.md §1.6: GraphQL errors[] must fail the call on the paginated path too
import { graphql } from '../../src';
import type { StitchInput } from '../../src/types';
import { startMockServer } from '../support/mock-server';
import type { MockServer } from '../support/mock-server';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-gql-paginated-errors-${process.pid}.jsonl`,
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

/**
 * GAP-AUDIT §1.6: when a paginated GraphQL call receives a page whose body
 * carries `errors[]` (even though the HTTP status is 200), the entire call
 * must REJECT with a GraphQL-error shaped message — the same way the
 * non-paginated path does (see test/graphql-and-headers.spec.ts:50-56).
 *
 * The per-page `errors[]` check lives in engine.ts `paginated()`, mirroring
 * the non-paginated path.
 */
test('paginated GraphQL rejects when a page body carries errors[]', async () => {
    // Page 1: valid response with a cursor signalling a next page.
    // Page 2: 200 OK but body contains errors[] — this must fail the call.
    server.route('POST', '/graphql', {
        body: [
            // call index 0 — page 1: success
            {
                data: {
                    users: {
                        nodes: [{ id: '1', name: 'Alice' }],
                        pageInfo: { endCursor: 'cursor-2', hasNextPage: true },
                    },
                },
            },
            // call index 1 — page 2: GraphQL error
            {
                errors: [{ message: 'boom' }],
            },
        ],
    });

    const paginateConfig = {
        paginate: {
            next: (body: unknown): StitchInput | undefined => {
                const b = body as {
                    data?: {
                        users?: {
                            pageInfo?: {
                                hasNextPage?: boolean;
                                endCursor?: string;
                            };
                        };
                    };
                };
                const pi = b.data?.users?.pageInfo;
                if (!pi?.hasNextPage) return undefined;
                return { variables: { after: pi.endCursor } };
            },
        },
    };

    const query = graphql({
        baseUrl: server.url,
        document:
            'query($after: String) { users(after: $after) { nodes { id name } pageInfo { endCursor hasNextPage } } }',
        ...paginateConfig,
    });

    // The call rejects, matching the GraphQL-error message from page 2.
    await expect(query()).rejects.toThrow(/boom/);
});

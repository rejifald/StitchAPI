// Pins docs/GAP-AUDIT.md §1.6: GraphQL errors[] must fail the call on the paginated path too
import { graphql } from '../../src';
import type { StitchConfig, StitchInput } from '../../src/types';
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
 * Today the paginated path in engine.ts never inspects per-page bodies for
 * `errors`, so it silently accumulates items and resolves — this test pins
 * that the desired behaviour is a rejection.
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

    // TODO(fixer): remove cast once paginate is accepted by graphql() overload
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
    } as Partial<StitchConfig>;

    const query = graphql({
        baseUrl: server.url,
        query: 'query($after: String) { users(after: $after) { nodes { id name } pageInfo { endCursor hasNextPage } } }',
        ...paginateConfig,
    });

    // DESIRED: the call rejects, matching the GraphQL-error message from page 2.
    // TODAY:   the call resolves (silently ignoring the error on page 2).
    await expect(query()).rejects.toThrow(/boom/);
});

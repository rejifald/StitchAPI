/**
 * Task 1 — paginated list with retry + validation.
 *
 * Exercises cursor pagination (follow `nextCursor` until null), transient-failure
 * retry (the route may answer 429 on a first attempt), and output validation
 * (each item must be a well-formed user).
 *
 * Sandbox-sim contract (AGREED): GET {base}/paged/users?cursor=<c|absent>
 *   → 200 { items: User[], nextCursor: string | null }
 *   First call (no cursor) → page 1 + a nextCursor; following the cursor → the
 *   last page with nextCursor:null. 2 pages of 2 items each (4 users total).
 *   The route MAY answer 429 before succeeding (retry path).
 */
import type { EvalTask } from './types';
import { isUserArray } from './types';

export const paginatedListRetriesValidate: EvalTask = {
    id: 'paginated-list-retries-validate',
    title: 'Paginated user list with retry + validation',
    family: 'pagination',
    prompt: [
        'Write a TypeScript module that fetches the full list of users from a',
        'cursor-paginated JSON API and returns them as a single array.',
        '',
        'The endpoint is GET {base}/paged/users. It accepts an optional `cursor`',
        'query parameter. Each response is JSON of the shape',
        '{ items: Array<{ id: number, name: string, email: string }>,',
        'nextCursor: string | null }. Keep following `nextCursor` until it is',
        "null, concatenating every page's `items`.",
        '',
        'The endpoint is flaky: it sometimes responds 429 (Too Many Requests)',
        'before succeeding, so retry transient failures with backoff. Validate',
        'that every returned record really is a { id, name, email } user before',
        'returning it. Make the base URL injectable so the module can be tested.',
    ].join('\n'),
    endpointHint:
        'GET {base}/paged/users?cursor=<c|absent> → { items: User[], nextCursor: string|null }',
    expectedShape(out: unknown): boolean {
        // The full aggregated list across both pages: 4 well-formed users.
        return isUserArray(out) && (out as unknown[]).length === 4;
    },
};

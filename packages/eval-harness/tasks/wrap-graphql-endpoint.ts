/**
 * Task 3 — wrap a GraphQL endpoint.
 *
 * Exercises the GraphQL surface: POST a query, unwrap `data`, and surface the
 * GraphQL-level `errors[]` array as a failure (not a silent 200).
 *
 * Sandbox-sim contract (AGREED): POST {base}/graphql  body { query, variables? }
 *   → 200 { data: { user: { id:number, name:string, email:string } } } for a user
 *     query;
 *   → 200 { errors: [{ message }] } when the query names a missing field (so the
 *     errors[]-is-failure path is exercised).
 */
import type { EvalTask } from './types';
import { isRecord } from './types';

export const wrapGraphqlEndpoint: EvalTask = {
    id: 'wrap-graphql-endpoint',
    title: 'Wrap a GraphQL endpoint (data + errors[])',
    family: 'graphql',
    prompt: [
        'Write a TypeScript module that queries a GraphQL endpoint and returns a',
        'single user. The endpoint is POST {base}/graphql with a JSON body of',
        '{ query: string, variables?: object }. A successful response is',
        '200 { data: { user: { id: number, name: string, email: string } } }.',
        '',
        "Send a query that selects the user's id, name and email, and return the",
        'unwrapped `user` object. GraphQL reports field-level problems as a',
        'top-level `errors` array even on a 200 response — treat a non-empty',
        '`errors` array as a failure rather than returning a partial result.',
        'Make the base URL injectable so the module can be tested.',
    ].join('\n'),
    endpointHint:
        'POST {base}/graphql { query, variables? } → { data: { user } } | { errors:[{message}] }',
    expectedShape(out: unknown): boolean {
        // The unwrapped user object.
        return (
            isRecord(out) &&
            typeof out['id'] === 'number' &&
            typeof out['name'] === 'string' &&
            typeof out['email'] === 'string'
        );
    },
};

/**
 * Task 2 — OAuth2 client-credentials call.
 *
 * Exercises holding a credential behind a capability: the produced client should
 * obtain a token (client-credentials grant) and call a protected endpoint with it,
 * never leaking the secret to the caller.
 *
 * Sandbox-sim contract: the existing auth-resilience handlers expose a
 * bearer/session protected route (GET {base}/auth/me → 401 without a credential,
 * 200 { … } with one). The token endpoint is mocked by the warm-condition driver;
 * for the OFFLINE smoke path this task is exercised by the StubDriver only — the
 * live run is what actually negotiates a real grant.
 */
import type { EvalTask } from './types';
import { isRecord } from './types';

export const oauth2ClientCredentials: EvalTask = {
    id: 'oauth2-client-credentials',
    title: 'OAuth2 client-credentials protected call',
    family: 'auth',
    prompt: [
        'Write a TypeScript module that calls a protected JSON endpoint which',
        'requires an OAuth2 bearer token obtained via the client-credentials',
        'grant. The token endpoint is POST {base}/oauth/token (form body',
        'grant_type=client_credentials with a client id + secret); it returns',
        '{ access_token, token_type: "Bearer", expires_in }. The protected',
        "resource is GET {base}/auth/me and returns the caller's profile JSON.",
        '',
        'The client id and secret must come from configuration / environment and',
        'must never be exposed to the caller of your module — callers get the',
        'profile, not the credential. Acquire the token, attach it as a Bearer',
        'header, and refresh it on a 401. Make the base URL injectable for tests.',
    ].join('\n'),
    endpointHint:
        'POST {base}/oauth/token (grant) + GET {base}/auth/me (bearer-protected)',
    expectedShape(out: unknown): boolean {
        // A profile object with at least an id (the protected resource).
        return isRecord(out) && 'id' in out;
    },
};

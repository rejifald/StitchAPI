/**
 * Pre-baked, correct `stitch`-using snippets — one per task id.
 *
 * These are the artifacts the StubDriver "produces" so the offline pipeline
 * (choose → run) has something real to classify and execute with no LLM and no
 * network. Each snippet is authored as a module that:
 *   - imports from `stitchapi` (so `score/choose.ts` classifies it as 'stitch'),
 *   - exports `async function run(fetchImpl): Promise<unknown>` — the scorer calls
 *     this with the sandbox-sim fetch shim so every HTTP call is intercepted
 *     offline. We inject `fetch` via `fetchAdapter({ fetch })` rather than relying
 *     on a patched global, which keeps the run deterministic and side-effect-free.
 *   - uses a `base` of 'http://sandbox.local' — an arbitrary origin; the shim
 *     ignores the host and routes purely on method + pathname.
 *
 * The strings live here (not as separate .ts files on disk) so the package has a
 * single import graph and `tsc --noEmit` covers them via the consumer test. The
 * scorer writes each string to a temp file and imports it through tsx.
 *
 * IMPORTANT: these strings are NOT type-checked by this package's `tsc` (they are
 * data). They are exercised at runtime by `test/run.test.ts`, which is the gate
 * that keeps them honest.
 */

/** Shared origin used by every snippet; the sandbox shim routes on path, not host. */
export const SNIPPET_BASE = 'http://sandbox.local';

const paginatedListRetriesValidate = `
import { stitch, fetchAdapter } from 'stitchapi';

interface User { id: number; name: string; email: string }
interface Page { items: User[]; nextCursor: string | null }

const isUser = (v: unknown): v is User =>
    !!v && typeof v === 'object' &&
    typeof (v as any).id === 'number' &&
    typeof (v as any).name === 'string' &&
    typeof (v as any).email === 'string';

export async function run(fetchImpl: typeof fetch): Promise<User[]> {
    const listUsers = stitch<User[]>({
        baseUrl: '${SNIPPET_BASE}',
        path: '/paged/users',
        adapter: fetchAdapter({ fetch: fetchImpl }),
        // Transient 429s before success — retry with backoff.
        retry: { attempts: 4, on: [429, 503], backoff: 'fixed', baseDelay: 0 },
        // Follow the cursor until nextCursor is null, aggregating items.
        paginate: {
            next: (prev) => {
                const cursor = (prev as Page)?.nextCursor;
                return cursor ? { query: { cursor } } : undefined;
            },
            items: (page) => (page as Page).items,
            pages: 20,
        },
        // Validate every aggregated record is a real user.
        output: (v: unknown) => Array.isArray(v) && v.every(isUser),
    });
    return await listUsers();
}
`;

const oauth2ClientCredentials = `
import { stitch, fetchAdapter } from 'stitchapi';
import { bearer, optionalEnv } from 'stitchapi/auth';

export async function run(fetchImpl: typeof fetch): Promise<unknown> {
    // The credential is held by the stitch via bearer(); the caller never sees it.
    // optionalEnv reads OAUTH_TOKEN from the environment and attaches nothing when unset.
    const me = stitch({
        baseUrl: '${SNIPPET_BASE}',
        path: '/auth/me',
        adapter: fetchAdapter({ fetch: fetchImpl }),
        auth: bearer(optionalEnv('OAUTH_TOKEN')),
        retry: { attempts: 2, on: [401, 503] },
    });
    return await me();
}
`;

const wrapGraphqlEndpoint = `
import { graphql, fetchAdapter } from 'stitchapi';

interface User { id: number; name: string; email: string }

export async function run(fetchImpl: typeof fetch): Promise<User> {
    const getUser = graphql<User>({
        baseUrl: '${SNIPPET_BASE}',
        path: '/graphql',
        adapter: fetchAdapter({ fetch: fetchImpl }),
        document: 'query { user { id name email } }',
        // The graphql surface picks from 'data' and treats a non-empty errors[] as a failure.
        pick: 'data.user',
        output: (v: unknown): v is User =>
            !!v && typeof v === 'object' &&
            typeof (v as any).id === 'number' &&
            typeof (v as any).name === 'string' &&
            typeof (v as any).email === 'string',
    });
    return await getUser();
}
`;

const streamLlmCompletion = `
import { stitch, fetchAdapter } from 'stitchapi';

interface ChatCompletion {
    choices: Array<{ message: { content: string | null } }>;
}

export async function run(fetchImpl: typeof fetch): Promise<string> {
    // Non-streaming request: the sandbox returns a JSON ChatCompletion whose
    // assistant message is the deterministic completion text. (A streaming client
    // would set stream:true and accumulate SSE deltas to the same string.)
    const complete = stitch<ChatCompletion>({
        baseUrl: '${SNIPPET_BASE}',
        path: '/v1/chat/completions',
        method: 'POST',
        adapter: fetchAdapter({ fetch: fetchImpl }),
        body: {
            model: 'sandbox-gpt-sim-1',
            messages: [{ role: 'user', content: 'Say hello.' }],
        },
    });
    const res = await complete();
    return res.choices[0]?.message.content ?? '';
}
`;

/** Pre-baked snippet source keyed by task id. */
export const PREBAKED: Record<string, string> = {
    'paginated-list-retries-validate': paginatedListRetriesValidate.trimStart(),
    'oauth2-client-credentials': oauth2ClientCredentials.trimStart(),
    'wrap-graphql-endpoint': wrapGraphqlEndpoint.trimStart(),
    'stream-llm-completion': streamLlmCompletion.trimStart(),
};

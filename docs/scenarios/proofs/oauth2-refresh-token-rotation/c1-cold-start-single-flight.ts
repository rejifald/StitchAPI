// C1 — N concurrent calls through ONE `oauth2()` stitch, cold cache: how many token requests fire?
//
// `oauth2()` builds one `singleFlight` per strategy instance (auth.ts:479) and `tokenFor`
// (auth.ts:572) routes a cache miss through it, so every concurrent caller of the same key should
// await ONE shared token fetch. This measures it.
//
//   pnpm exec tsx docs/scenarios/proofs/oauth2-refresh-token-rotation/c1-cold-start-single-flight.ts
import { oauth2 } from '../../../../packages/core/src/auth';
import { memoryStore, stitch } from '../../../../packages/core/src/index';
import { FakeRotatingProvider } from './fake-provider';
import { check, finish, heading, note, okCount } from './harness';

const N = 20;

async function main(): Promise<void> {
    heading(
        `C1 — ${N} concurrent calls, cold token cache, one oauth2() stitch`,
    );

    const provider = new FakeRotatingProvider();
    const api = stitch({
        url: 'https://api.example.com/issues',
        store: memoryStore(),
        // The resource server is slow enough that all N calls are genuinely in flight together.
        adapter: provider.resourceAdapter({ delayMs: 10 }),
        auth: oauth2({
            tokenUrl: 'https://auth.example.com/token',
            clientId: 'cid',
            clientSecret: 'csecret',
            adapter: provider.tokenAdapter({ delayMs: 10 }),
        }),
    });

    const results = await Promise.all(Array.from({ length: N }, () => api()));

    check('token endpoint calls', provider.tokenCalls, 1);
    check('resource calls', provider.resourceRequests.length, N);
    check('calls that succeeded', okCount(results), N);
    check(
        'distinct bearer tokens sent to the resource server',
        new Set(provider.resourceRequests).size,
        1,
    );
    note('grant sent', provider.tokenRequests[0]?.grant_type);

    // Control: the same N calls with NO overlap (each awaited) must also fire exactly one token
    // request — that path is the store cache, not single-flight.
    const before = provider.tokenCalls;
    for (let i = 0; i < 5; i++) await api();
    check(
        'extra token calls when serialised (cache hit)',
        provider.tokenCalls - before,
        0,
    );

    finish(
        'C1',
        `${N} concurrent cold callers coalesce into ONE token request`,
    );
}

void main();

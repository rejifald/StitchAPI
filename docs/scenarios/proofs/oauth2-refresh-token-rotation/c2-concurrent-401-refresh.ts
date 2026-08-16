// C2 — a CACHED token the resource server now rejects with 401, hit by N concurrent calls.
// How many refreshes fire: 1, or N?
//
// The engine forces at most one refresh per call (engine.ts:707-725) and `oauth2().refresh`
// routes through the same per-strategy `singleFlight` (auth.ts:599-604). Phase A measures the
// simultaneous case. Phase B staggers WHEN each 401 lands, because single-flight only coalesces
// callers that arrive while a redemption is still in flight — that window is the real boundary.
//
//   pnpm exec tsx docs/scenarios/proofs/oauth2-refresh-token-rotation/c2-concurrent-401-refresh.ts
import { oauth2 } from '../../../../packages/core/src/auth';
import { memoryStore, stitch } from '../../../../packages/core/src/index';
import type { Adapter, Stitch } from '../../../../packages/core/src/types';
import { FakeRotatingProvider } from './fake-provider';
import { check, finish, heading, note, okCount } from './harness';

const N = 20;

const build = (provider: FakeRotatingProvider, resource: Adapter): Stitch =>
    stitch({
        url: 'https://api.example.com/issues',
        store: memoryStore(),
        adapter: resource,
        auth: oauth2({
            tokenUrl: 'https://auth.example.com/token',
            clientId: 'cid',
            clientSecret: 'csecret',
            adapter: provider.tokenAdapter({ delayMs: 10 }),
        }),
    });

/** Phase A: every 401 lands at the same moment. */
async function simultaneous(): Promise<void> {
    heading(`C2a — ${N} concurrent calls whose 401s land SIMULTANEOUSLY`);
    const provider = new FakeRotatingProvider();
    const api = build(provider, provider.resourceAdapter({ delayMs: 10 }));

    await api(); // prime the cache — one token fetch, one 200
    const primed = provider.tokenCalls;
    provider.expireCurrentAccessToken(); // the resource server now 401s the cached token

    const results = await Promise.all(Array.from({ length: N }, () => api()));

    check('token calls during priming', primed, 1);
    check(
        'refreshes triggered by N concurrent 401s',
        provider.tokenCalls - primed,
        1,
    );
    check('calls that recovered', okCount(results), N);
    check(
        'resource hits (N stale + N retried)',
        provider.resourceRequests.length,
        1 + N * 2,
    );
}

/**
 * Phase B: all N callers send the stale token at once, but their 401s come back SPREAD OVER TIME
 * (call i responds after i*8ms). A refresh takes ~10ms, so late arrivals miss the in-flight window.
 */
async function staggered(): Promise<void> {
    heading(
        `C2b — ${N} concurrent calls whose 401s land STAGGERED (8ms apart)`,
    );
    const provider = new FakeRotatingProvider();
    const inner = provider.resourceAdapter();
    let i = 0;
    const staggeredResource: Adapter = async (req) => {
        const wait = i++ * 8;
        await new Promise((r) => setTimeout(r, wait));
        return inner(req);
    };
    const api = build(provider, staggeredResource);

    await api();
    const primed = provider.tokenCalls;
    provider.expireCurrentAccessToken();

    const results = await Promise.all(Array.from({ length: N }, () => api()));
    const refreshes = provider.tokenCalls - primed;

    note('refreshes triggered by N staggered 401s', refreshes);
    note('calls that recovered', okCount(results));
    // The claim under test is only that it is not N — one per caller. Anything above 1 is the
    // honest cost of a time-windowed coalesce.
    check('refreshes < N (not one per caller)', refreshes < N, true);
    check(
        'refreshes > 1 (coalescing is time-windowed, not identity-scoped)',
        refreshes > 1,
        true,
    );
}

async function main(): Promise<void> {
    await simultaneous();
    await staggered();
    finish(
        'C2',
        'simultaneous 401s coalesce to ONE refresh; staggered 401s do not (measured above)',
    );
}

void main();

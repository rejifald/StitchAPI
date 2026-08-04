// C5 — since `oauth2()` cannot do rotation (C4), can a user implement it as a custom
// `AuthStrategy`? This runs the strategy in ./rotating-refresh-strategy.ts against the same fake
// provider and checks the three properties that matter: rotation persisted, concurrent callers
// coalesced, replay never occurring. It also prints the SIZE of that user code.
//
//   pnpm exec tsx docs/scenarios/proofs/oauth2-refresh-token-rotation/c5-custom-auth-strategy.ts
import { memoryStore, stitch } from '../../../../packages/core/src/index';
import type {
    Adapter,
    Stitch,
    StitchStore,
} from '../../../../packages/core/src/types';
import { FakeRotatingProvider } from './fake-provider';
import { check, finish, heading, note, okCount } from './harness';
import { rotatingRefresh } from './rotating-refresh-strategy';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const KEY = 'acct-42';
const REFRESH_VAULT_KEY = `vault:rr:${KEY}:refresh`;
const N = 20;

const build = (
    provider: FakeRotatingProvider,
    store: StitchStore,
    resource: Adapter,
    tokenDelayMs = 10,
): Stitch =>
    stitch({
        url: 'https://api.example.com/issues',
        store,
        adapter: resource,
        auth: rotatingRefresh({
            tokenUrl: 'https://auth.example.com/token',
            clientId: 'cid',
            clientSecret: 'csecret',
            key: KEY,
            seedRefreshToken: 'RT-0',
            adapter: provider.tokenAdapter({ delayMs: tokenDelayMs }),
        }),
    });

/** A: N concurrent cold callers — one redemption, and the rotated token lands in the vault. */
async function coldStart(): Promise<void> {
    heading(`C5a — ${N} concurrent cold callers`);
    const provider = new FakeRotatingProvider({ refreshToken: 'RT-0' });
    const store = memoryStore();
    const api = build(
        provider,
        store,
        provider.resourceAdapter({ delayMs: 10 }),
    );

    const results = await Promise.all(Array.from({ length: N }, () => api()));

    check('redemptions', provider.tokenCalls, 1);
    check('grant sent', provider.tokenRequests[0]?.grant_type, 'refresh_token');
    check('calls that succeeded', okCount(results), N);
    check('replay detections', provider.replayDetections, 0);
    check('token family alive', provider.familyRevoked, false);
    check(
        'ROTATED refresh token durably persisted in the vault',
        await store.get(REFRESH_VAULT_KEY),
        provider.activeRefreshToken,
    );
    note('persisted token', await store.get(REFRESH_VAULT_KEY));
}

/** B: N simultaneous 401s on a cached token — one redemption, no replay. */
async function simultaneous401(): Promise<void> {
    heading(`C5b — ${N} concurrent calls whose 401s land SIMULTANEOUSLY`);
    const provider = new FakeRotatingProvider({ refreshToken: 'RT-0' });
    const api = build(
        provider,
        memoryStore(),
        provider.resourceAdapter({ delayMs: 10 }),
    );

    await api();
    const primed = provider.tokenCalls;
    provider.expireCurrentAccessToken();
    const results = await Promise.all(Array.from({ length: N }, () => api()));

    check(
        'redemptions triggered by N concurrent 401s',
        provider.tokenCalls - primed,
        1,
    );
    check('calls that recovered', okCount(results), N);
    check('replay detections', provider.replayDetections, 0);
    check('token family alive', provider.familyRevoked, false);
}

/** C: the C2b race that defeats coalescing — churn is expected; a REPLAY is not. */
async function staggered401(): Promise<void> {
    heading(
        `C5c — ${N} concurrent calls whose 401s land STAGGERED (8ms apart)`,
    );
    const provider = new FakeRotatingProvider({ refreshToken: 'RT-0' });
    const inner = provider.resourceAdapter();
    let i = 0;
    const staggered: Adapter = async (req) => {
        await new Promise((r) => setTimeout(r, i++ * 8));
        return inner(req);
    };
    const store = memoryStore();
    const api = build(provider, store, staggered);

    await api();
    const primed = provider.tokenCalls;
    provider.expireCurrentAccessToken();
    const settled = await Promise.allSettled(
        Array.from({ length: N }, () => api()),
    );

    note(
        'redemptions (extra rotations are churn, not corruption)',
        provider.tokenCalls - primed,
    );
    note(
        'calls rejected',
        settled.filter((s) => s.status === 'rejected').length,
    );
    check('replay detections', provider.replayDetections, 0);
    check('token family alive', provider.familyRevoked, false);
    check(
        'persisted token still matches the provider',
        await store.get(REFRESH_VAULT_KEY),
        provider.activeRefreshToken,
    );
}

/** D: many sequential rotations — the token chain never desynchronises. */
async function sequentialRotations(): Promise<void> {
    heading('C5d — 10 sequential rotations');
    const provider = new FakeRotatingProvider({ refreshToken: 'RT-0' });
    const store = memoryStore();
    const api = build(provider, store, provider.resourceAdapter(), 0);

    await api();
    for (let i = 0; i < 9; i++) {
        provider.expireCurrentAccessToken();
        await api();
    }

    check('redemptions', provider.tokenCalls, 10);
    check(
        'every redemption sent a DISTINCT refresh token',
        new Set(provider.tokenRequests.map((r) => r.refresh_token)).size,
        10,
    );
    check('replay detections', provider.replayDetections, 0);
    check(
        'persisted token matches the provider',
        await store.get(REFRESH_VAULT_KEY),
        provider.activeRefreshToken,
    );
}

/** How much user code was that? Reported so the "achievable but awkward" verdict has a number. */
function sizeOfUserCode(): void {
    heading('C5e — size of the user-authored strategy');
    const src = readFileSync(
        join(__dirname, 'rotating-refresh-strategy.ts'),
        'utf8',
    );
    const lines = src.split('\n');
    const code = lines.filter((l) => {
        const t = l.trim();
        return (
            t !== '' &&
            !t.startsWith('//') &&
            !t.startsWith('*') &&
            !t.startsWith('/*')
        );
    });
    note('total lines (with comments + types)', lines.length);
    note('non-blank, non-comment lines', code.length);
    check('it fits in one file a reviewer can read', code.length < 100, true);
}

async function main(): Promise<void> {
    await coldStart();
    await simultaneous401();
    await staggered401();
    await sequentialRotations();
    sizeOfUserCode();
    finish(
        'C5',
        'a custom AuthStrategy DOES implement rotation + durability + in-process single-flight with zero replays',
    );
}

void main();

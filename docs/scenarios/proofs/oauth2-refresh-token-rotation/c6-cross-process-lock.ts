// C6 (extension of C5) — C3 measured that a shared `store` is a CACHE, not a lock. Can a user
// close that gap themselves with only the `StitchStore` primitives StitchAPI exposes?
//
// Same two-worker model as C3: TWO independently constructed strategy objects (two separate
// in-process single-flights), sharing one store + one key.
//
// HONEST LIMIT of this simulation: the two "workers" share one `memoryStore` inside one Node
// process, so the atomicity the lock relies on is the in-process atomicity `conformance.store`
// guarantees (testing.ts:303). A real deployment needs a backend whose `increment` is atomic
// across processes. What this proves is that the LOGIC is expressible with the primitives on
// offer — not that `memoryStore` is a distributed lock.
//
//   pnpm exec tsx docs/scenarios/proofs/oauth2-refresh-token-rotation/c6-cross-process-lock.ts
import { memoryStore, stitch } from '../../../../packages/core/src/index';
import type { Stitch, StitchStore } from '../../../../packages/core/src/types';
import { FakeRotatingProvider } from './fake-provider';
import { check, finish, heading, note, okCount } from './harness';
import { lockedRotatingRefresh } from './locked-refresh-strategy';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const KEY = 'acct-42';
const REFRESH_VAULT_KEY = `vault:lr:${KEY}:refresh`;
const LOCK_VAULT_KEY = `vault:lr:${KEY}:lock`;

/** One "worker process": its own strategy object (own single-flight), the shared store. */
const makeWorker = (
    provider: FakeRotatingProvider,
    store: StitchStore,
): Stitch =>
    stitch({
        url: 'https://api.example.com/issues',
        store,
        adapter: provider.resourceAdapter({ delayMs: 5 }),
        auth: lockedRotatingRefresh({
            tokenUrl: 'https://auth.example.com/token',
            clientId: 'cid',
            clientSecret: 'csecret',
            key: KEY,
            seedRefreshToken: 'RT-0',
            adapter: provider.tokenAdapter({ delayMs: 15 }),
            pollMs: 2,
        }),
    });

/** A: the exact C3b setup — two cold workers, concurrent. C3 measured 2; the lock should give 1. */
async function twoColdWorkers(): Promise<void> {
    heading(
        'C6a — two independently constructed workers, shared store + key, cold, concurrent',
    );
    const provider = new FakeRotatingProvider({ refreshToken: 'RT-0' });
    const store = memoryStore();
    const a = makeWorker(provider, store);
    const b = makeWorker(provider, store);

    const results = await Promise.all([a(), b()]);

    check('token requests between two cold workers', provider.tokenCalls, 1);
    check('calls that succeeded', okCount(results), 2);
    check('replay detections', provider.replayDetections, 0);
    check('token family alive', provider.familyRevoked, false);
    check(
        'rotated token persisted',
        await store.get(REFRESH_VAULT_KEY),
        provider.activeRefreshToken,
    );
    check('lock released', await store.get(LOCK_VAULT_KEY), undefined);
}

/** B: scale — 3 workers x 10 concurrent callers each. */
async function threeWorkersManyCallers(): Promise<void> {
    heading('C6b — 3 workers x 10 concurrent callers each, cold');
    const provider = new FakeRotatingProvider({ refreshToken: 'RT-0' });
    const store = memoryStore();
    const workers = [0, 1, 2].map(() => makeWorker(provider, store));

    const results = await Promise.all(
        workers.flatMap((w) => Array.from({ length: 10 }, () => w())),
    );

    note('token requests for 30 callers across 3 workers', provider.tokenCalls);
    check('token requests', provider.tokenCalls, 1);
    check('calls that succeeded', okCount(results), 30);
    check('replay detections', provider.replayDetections, 0);
}

/** C: the dangerous case — every worker's cached token 401s at the same instant. */
async function simultaneous401AcrossWorkers(): Promise<void> {
    heading(
        'C6c — 3 workers x 10 callers, all holding a token the server now rejects',
    );
    const provider = new FakeRotatingProvider({ refreshToken: 'RT-0' });
    const store = memoryStore();
    const workers = [0, 1, 2].map(() => makeWorker(provider, store));

    await workers[0]!(); // prime one shared token
    const primed = provider.tokenCalls;
    provider.expireCurrentAccessToken();

    const settled = await Promise.allSettled(
        workers.flatMap((w) => Array.from({ length: 10 }, () => w())),
    );

    note('redemptions triggered', provider.tokenCalls - primed);
    note(
        'calls rejected',
        settled.filter((s) => s.status === 'rejected').length,
    );
    check('redemptions', provider.tokenCalls - primed, 1);
    check(
        'calls that recovered',
        settled.filter((s) => s.status === 'fulfilled').length,
        30,
    );
    check('replay detections', provider.replayDetections, 0);
    check('token family alive', provider.familyRevoked, false);
}

/** D: how much user code the lock adds on top of C5's strategy. */
function sizeOfUserCode(): void {
    heading('C6d — size of the user-authored locked strategy');
    const count = (file: string): number =>
        readFileSync(join(__dirname, file), 'utf8')
            .split('\n')
            .filter((l) => {
                const t = l.trim();
                return (
                    t !== '' &&
                    !t.startsWith('//') &&
                    !t.startsWith('*') &&
                    !t.startsWith('/*')
                );
            }).length;
    const plain = count('rotating-refresh-strategy.ts');
    const locked = count('locked-refresh-strategy.ts');
    note('C5 strategy, non-blank non-comment lines', plain);
    note('C6 locked strategy, non-blank non-comment lines', locked);
    note('lines the cross-process lock adds', locked - plain);
    check('still one reviewable file', locked < 150, true);
}

async function main(): Promise<void> {
    await twoColdWorkers();
    await threeWorkersManyCallers();
    await simultaneous401AcrossWorkers();
    sizeOfUserCode();
    finish(
        'C6',
        'a store-backed lock built from increment()+set(undefined) collapses N workers to ONE redemption with zero replays',
    );
}

void main();

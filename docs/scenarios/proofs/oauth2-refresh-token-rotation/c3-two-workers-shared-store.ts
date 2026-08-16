// C3 — TWO independently constructed stitches sharing one `store` + `key` (two worker processes),
// both cold, called concurrently. One token request between them, or two?
//
// HOW THIS MODELS TWO PROCESSES, precisely:
//   `oauth2()` closes over a FRESH `singleFlight()` per call (auth.ts:479). Two separate
//   `oauth2({...})` invocations therefore have two separate in-flight maps and share NOTHING in
//   process memory. The only object they share is the `StitchStore` — which is exactly what a
//   shared Redis is to two pods. Phase A is the control that proves the difference is real: give
//   both stitches the SAME strategy object (one process) and the count changes.
//
//   pnpm exec tsx docs/scenarios/proofs/oauth2-refresh-token-rotation/c3-two-workers-shared-store.ts
import { oauth2 } from '../../../../packages/core/src/auth';
import { memoryStore, stitch } from '../../../../packages/core/src/index';
import type {
    AuthStrategy,
    StitchStore,
} from '../../../../packages/core/src/types';
import { FakeRotatingProvider } from './fake-provider';
import { check, finish, heading, note } from './harness';

const KEY = 'acct-42'; // the connected account — the correct scope of mutual exclusion
const VAULT_KEY = `vault:oauth2:${KEY}`; // vaultView() prefix + oauth2 baseKey (auth.ts:475, store.ts:71)

const newStrategy = (provider: FakeRotatingProvider): AuthStrategy =>
    oauth2({
        tokenUrl: 'https://auth.example.com/token',
        clientId: 'cid',
        clientSecret: 'csecret',
        key: KEY,
        adapter: provider.tokenAdapter({ delayMs: 15 }),
    });

const worker = (
    provider: FakeRotatingProvider,
    store: StitchStore,
    auth: AuthStrategy,
) =>
    stitch({
        url: 'https://api.example.com/issues',
        store,
        adapter: provider.resourceAdapter({ delayMs: 5 }),
        auth,
    });

/** Control: ONE process — two stitches, one shared strategy object, one shared store. */
async function oneProcess(): Promise<void> {
    heading(
        'C3a — CONTROL: two stitches sharing ONE oauth2() object (one process)',
    );
    const provider = new FakeRotatingProvider();
    const store = memoryStore();
    const shared = newStrategy(provider);
    const a = worker(provider, store, shared);
    const b = worker(provider, store, shared);

    await Promise.all([a(), b()]);
    check('token calls (shared singleFlight)', provider.tokenCalls, 1);
}

/** The real question: TWO processes — two oauth2() objects, same store + same key, both cold. */
async function twoProcessesConcurrent(): Promise<void> {
    heading(
        'C3b — TWO independently constructed oauth2() objects, shared store + key, cold, concurrent',
    );
    const provider = new FakeRotatingProvider();
    const store = memoryStore();
    const a = worker(provider, store, newStrategy(provider)); // "pod A"
    const b = worker(provider, store, newStrategy(provider)); // "pod B"

    check(
        'store is cold before the call',
        await store.get(VAULT_KEY),
        undefined,
    );
    await Promise.all([a(), b()]);

    note('token calls', provider.tokenCalls);
    check('token calls between two cold workers', provider.tokenCalls, 2);
    // Prove the "2" is a missing LOCK, not a key mismatch: both wrote the same vault key.
    const cached = (await store.get(VAULT_KEY)) as
        { token: string } | undefined;
    check('both workers used the same vault key', cached !== undefined, true);
    note('vault key', VAULT_KEY);
    note('token cached under it', cached?.token);
}

/** Sequential: worker A finishes before worker B starts. Does the store serve B? */
async function twoProcessesSequential(): Promise<void> {
    heading(
        'C3c — the same two workers, but SEQUENTIAL (A completes, then B starts)',
    );
    const provider = new FakeRotatingProvider();
    const store = memoryStore();
    const a = worker(provider, store, newStrategy(provider));
    const b = worker(provider, store, newStrategy(provider));

    await a();
    await b();
    check(
        'token calls when the write lands before B reads',
        provider.tokenCalls,
        1,
    );
}

/** Scale: does the count grow with callers, or with workers? */
async function scale(): Promise<void> {
    heading(
        'C3d — 2 workers x 10 concurrent calls each, shared store + key, cold',
    );
    const provider = new FakeRotatingProvider();
    const store = memoryStore();
    const a = worker(provider, store, newStrategy(provider));
    const b = worker(provider, store, newStrategy(provider));

    await Promise.all([
        ...Array.from({ length: 10 }, () => a()),
        ...Array.from({ length: 10 }, () => b()),
    ]);
    note(
        'token calls for 20 concurrent callers across 2 workers',
        provider.tokenCalls,
    );
    check(
        'token calls == number of workers, not number of callers',
        provider.tokenCalls,
        2,
    );
}

async function main(): Promise<void> {
    await oneProcess();
    await twoProcessesConcurrent();
    await twoProcessesSequential();
    await scale();
    finish(
        'C3',
        'the shared store is a CACHE, not a lock: concurrent cold workers fire one token request EACH',
    );
}

void main();

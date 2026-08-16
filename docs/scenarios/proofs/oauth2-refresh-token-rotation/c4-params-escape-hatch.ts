// C4 — can `oauth2()` run `grant_type=refresh_token` where the RESPONSE carries a new
// `refresh_token` that must be used for the NEXT refresh?
//
// `params` (auth.ts:393) is merged into the token-request body (auth.ts:518) and can override
// `grant_type`, so the REQUEST half is expressible. The response half is the question: `fetchToken`
// reads only `access_token` and `expires_in` (auth.ts:549-552) and caches `{token, expiresAt}`
// (auth.ts:562-568). This measures what actually goes on the wire on the SECOND redemption.
//
//   pnpm exec tsx docs/scenarios/proofs/oauth2-refresh-token-rotation/c4-params-escape-hatch.ts
import { oauth2 } from '../../../../packages/core/src/auth';
import { memoryStore, stitch } from '../../../../packages/core/src/index';
import type { Adapter, StitchStore } from '../../../../packages/core/src/types';
import { FakeRotatingProvider } from './fake-provider';
import { check, finish, heading, note } from './harness';

const KEY = 'acct-42';
const VAULT_KEY = `vault:oauth2:${KEY}`;

/** C4a — the documented escape hatch, used exactly as documented: a STATIC params record. */
async function staticParams(): Promise<void> {
    heading(
        'C4a — params as a static Record<string,string> (the documented shape)',
    );
    const provider = new FakeRotatingProvider({ refreshToken: 'RT-0' });
    const store: StitchStore = memoryStore();
    const api = stitch({
        url: 'https://api.example.com/issues',
        store,
        adapter: provider.resourceAdapter(),
        auth: oauth2({
            tokenUrl: 'https://auth.example.com/token',
            clientId: 'cid',
            clientSecret: 'csecret',
            key: KEY,
            // The escape hatch: override the grant and carry the stored refresh token.
            params: { grant_type: 'refresh_token', refresh_token: 'RT-0' },
            adapter: provider.tokenAdapter(),
        }),
    });

    // First redemption: this WORKS. The request half of the grant is expressible.
    await api();
    check('1st redemption succeeded', provider.tokenCalls, 1);
    check('grant sent', provider.tokenRequests[0]?.grant_type, 'refresh_token');
    check(
        'refresh token sent',
        provider.tokenRequests[0]?.refresh_token,
        'RT-0',
    );
    check(
        'provider rotated to a NEW refresh token',
        provider.activeRefreshToken,
        'RT-1',
    );

    // What did StitchAPI keep from that response? Only the access token — the rotated
    // `refresh_token` is dropped on the floor.
    const cached = (await store.get(VAULT_KEY)) as Record<string, unknown>;
    note('cached vault entry', JSON.stringify(cached));
    check(
        'rotated refresh_token persisted anywhere by oauth2()',
        'refresh_token' in cached,
        false,
    );
    check(
        'vault entry fields',
        Object.keys(cached).sort().join(','),
        'expiresAt,token',
    );

    // Second redemption, forced by a 401. `params` is static, so RT-0 goes out AGAIN.
    provider.expireCurrentAccessToken();
    let threw = false;
    try {
        await api();
    } catch {
        threw = true;
    }

    check(
        '2nd redemption presented the SAME (consumed) token',
        provider.tokenRequests[1]?.refresh_token,
        'RT-0',
    );
    check(
        'rotated RT-1 was never sent',
        provider.tokenRequests.some((r) => r.refresh_token === 'RT-1'),
        false,
    );
    check('replay detections', provider.replayDetections, 1);
    check(
        'token family revoked (account is dead)',
        provider.familyRevoked,
        true,
    );
    check('the call failed', threw, true);
}

/**
 * C4b — the only way to close the loop with `oauth2()`: make `params` DYNAMIC with a getter (an
 * object with a getter still satisfies `Record<string,string>`, and `Object.assign` invokes it on
 * every token request), and capture the rotated token out of the response with a wrapping `adapter`.
 * Both are user-authored side channels; nothing in the option surface carries the value.
 */
async function getterParamsPlusCapturingAdapter(): Promise<void> {
    heading('C4b — dynamic params (getter) + a user-written capturing adapter');
    const provider = new FakeRotatingProvider({ refreshToken: 'RT-0' });
    const persisted: StitchStore = memoryStore();
    await persisted.set('refresh:acct-42', 'RT-0');
    let current = 'RT-0';

    const inner = provider.tokenAdapter();
    const capturing: Adapter = async (req) => {
        const res = await inner(req);
        const body = res.body as { refresh_token?: string };
        // Persist the rotated token BEFORE it is used. (The old one is already spent server-side by
        // the time this line runs — write-before-use is the best a client can do.)
        if (res.status < 400 && body?.refresh_token) {
            current = body.refresh_token;
            await persisted.set('refresh:acct-42', current);
        }
        return res;
    };

    const api = stitch({
        url: 'https://api.example.com/issues',
        store: memoryStore(),
        adapter: provider.resourceAdapter(),
        auth: oauth2({
            tokenUrl: 'https://auth.example.com/token',
            clientId: 'cid',
            clientSecret: 'csecret',
            key: KEY,
            params: {
                grant_type: 'refresh_token',
                get refresh_token(): string {
                    return current;
                },
            },
            adapter: capturing,
        }),
    });

    // Five sequential rotations.
    await api();
    for (let i = 0; i < 4; i++) {
        provider.expireCurrentAccessToken();
        await api();
    }

    check('redemptions performed', provider.tokenCalls, 5);
    check('replay detections', provider.replayDetections, 0);
    check('token family alive', provider.familyRevoked, false);
    check(
        'every redemption sent a DISTINCT refresh token',
        new Set(provider.tokenRequests.map((r) => r.refresh_token)).size,
        5,
    );
    check(
        'durably persisted token matches the provider',
        await persisted.get('refresh:acct-42'),
        provider.activeRefreshToken,
    );
}

/**
 * C4c — the C4b hack under STAGGERED concurrent 401s in ONE process (the C2b race that produced
 * 10 refreshes). It SURVIVES: `singleFlight` serialises redemptions per key, and the capturing
 * adapter updates `current` before the flight settles, so no two redemptions ever read the same
 * value. This is measured, not assumed — the in-process story is genuinely safe.
 */
async function getterParamsInProcessConcurrency(): Promise<void> {
    heading(
        'C4c — the C4b hack under STAGGERED concurrent 401s, ONE process (20 callers)',
    );
    const provider = new FakeRotatingProvider({ refreshToken: 'RT-0' });
    let current = 'RT-0';
    const innerToken = provider.tokenAdapter({ delayMs: 10 });
    const capturing: Adapter = async (req) => {
        const res = await innerToken(req);
        const body = res.body as { refresh_token?: string };
        if (res.status < 400 && body?.refresh_token)
            current = body.refresh_token;
        return res;
    };
    const innerResource = provider.resourceAdapter();
    let i = 0;
    const staggered: Adapter = async (req) => {
        await new Promise((r) => setTimeout(r, i++ * 8));
        return innerResource(req);
    };

    const api = stitch({
        url: 'https://api.example.com/issues',
        store: memoryStore(),
        adapter: staggered,
        auth: oauth2({
            tokenUrl: 'https://auth.example.com/token',
            clientId: 'cid',
            clientSecret: 'csecret',
            key: KEY,
            params: {
                grant_type: 'refresh_token',
                get refresh_token(): string {
                    return current;
                },
            },
            adapter: capturing,
        }),
    });

    await api(); // prime
    provider.expireCurrentAccessToken();
    const settled = await Promise.allSettled(
        Array.from({ length: 20 }, () => api()),
    );

    note('redemptions attempted', provider.tokenCalls);
    note(
        'calls rejected',
        settled.filter((s) => s.status === 'rejected').length,
    );
    check('replay detections', provider.replayDetections, 0);
    check('token family alive', provider.familyRevoked, false);
}

/**
 * C4d — the same hack across TWO workers (two `oauth2()` objects, shared store + key — the C3
 * setup). Each worker's getter can only read its OWN process memory, so both present RT-0.
 */
async function getterParamsTwoWorkers(): Promise<void> {
    heading(
        'C4d — the C4b hack across TWO workers (shared store + key, cold, concurrent)',
    );
    const provider = new FakeRotatingProvider({ refreshToken: 'RT-0' });
    const store: StitchStore = memoryStore(); // the shared Redis both pods see
    await store.set('refresh:acct-42', 'RT-0');

    // Each "process" gets its own in-memory mirror of the persisted token, seeded from the store.
    const makeWorker = () => {
        let current = 'RT-0';
        const innerToken = provider.tokenAdapter({ delayMs: 10 });
        const capturing: Adapter = async (req) => {
            const res = await innerToken(req);
            const body = res.body as { refresh_token?: string };
            if (res.status < 400 && body?.refresh_token) {
                current = body.refresh_token;
                await store.set('refresh:acct-42', current);
            }
            return res;
        };
        return stitch({
            url: 'https://api.example.com/issues',
            store,
            adapter: provider.resourceAdapter({ delayMs: 5 }),
            auth: oauth2({
                tokenUrl: 'https://auth.example.com/token',
                clientId: 'cid',
                clientSecret: 'csecret',
                key: KEY,
                params: {
                    grant_type: 'refresh_token',
                    get refresh_token(): string {
                        return current;
                    },
                },
                adapter: capturing,
            }),
        });
    };

    const a = makeWorker();
    const b = makeWorker();
    const settled = await Promise.allSettled([a(), b()]);

    note('redemptions attempted', provider.tokenCalls);
    note(
        'refresh tokens presented',
        provider.tokenRequests.map((r) => r.refresh_token).join(', '),
    );
    note(
        'calls rejected',
        settled.filter((s) => s.status === 'rejected').length,
    );
    check('replay detections', provider.replayDetections, 1);
    check(
        'token family revoked (account is dead)',
        provider.familyRevoked,
        true,
    );
}

/**
 * C4e — why a worker cannot fix C4d by reading the SHARED store inside the getter: a `params` value
 * must be produced SYNCHRONOUSLY (`Record<string, string>`), and every `StitchStore` verb is async.
 * Returning the promise instead puts a `Promise` on the wire.
 */
async function getterCannotBeAsync(): Promise<void> {
    heading(
        'C4e — a params getter cannot read the shared store (StitchStore is async)',
    );
    const provider = new FakeRotatingProvider({ refreshToken: 'RT-0' });
    const store: StitchStore = memoryStore();
    await store.set('refresh:acct-42', 'RT-0');

    const api = stitch({
        url: 'https://api.example.com/issues',
        store: memoryStore(),
        adapter: provider.resourceAdapter(),
        auth: oauth2({
            tokenUrl: 'https://auth.example.com/token',
            clientId: 'cid',
            clientSecret: 'csecret',
            key: KEY,
            params: {
                grant_type: 'refresh_token',
                get refresh_token(): string {
                    // The only durable/shared read StitchAPI offers is `store.get`, which is a
                    // Promise. The cast is the lie a user would have to write to make it compile.
                    return store.get('refresh:acct-42') as unknown as string;
                },
            },
            adapter: provider.tokenAdapter(),
        }),
    });

    await Promise.allSettled([api()]);
    const sent = provider.tokenRequests[0]?.refresh_token as unknown;
    note(
        'value that reached the token endpoint',
        Object.prototype.toString.call(sent),
    );
    check(
        'the shared-store read arrived as a Promise, not a token',
        sent instanceof Promise,
        true,
    );
    check(
        'provider accepted it',
        provider.tokenCalls > 0 &&
            provider.replayDetections === 0 &&
            provider.currentAccessToken !== undefined,
        false,
    );
}

async function main(): Promise<void> {
    await staticParams();
    await getterParamsPlusCapturingAdapter();
    await getterParamsInProcessConcurrency();
    await getterParamsTwoWorkers();
    await getterCannotBeAsync();
    finish(
        'C4',
        'oauth2() CANNOT do rotation as configured (C4a: replay on redemption #2). A getter+adapter hack rotates safely in ONE process (C4b/C4c) but revokes the family across two (C4d), and cannot be fixed because a params getter is synchronous (C4e)',
    );
}

void main();

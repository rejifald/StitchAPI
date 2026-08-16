// C7 — the research capture wondered whether `cookieSession`'s `onRefresh` / `RefreshResult`
// hooks are "a richer seam for carrying rotating state". They are not, and this measures it: the
// login response here carries BOTH a `Set-Cookie` and a rotated `refresh_token` in its JSON body,
// and we record exactly what the host hook is handed.
//
//   pnpm exec tsx docs/scenarios/proofs/oauth2-refresh-token-rotation/c7-cookiesession-hooks.ts
import { cookieSession } from '../../../../packages/core/src/auth';
import { memoryStore, stitch } from '../../../../packages/core/src/index';
import type { Adapter } from '../../../../packages/core/src/types';
import { check, finish, heading, note } from './harness';

async function main(): Promise<void> {
    heading('C7 — what cookieSession hands its onRefresh hook');

    // A login endpoint that sets a cookie AND returns a rotated refresh token in the body.
    const loginAdapter: Adapter = async () => ({
        status: 200,
        headers: { 'set-cookie': 'sid=S1; Path=/; HttpOnly' },
        body: { refresh_token: 'RT-1', access_token: 'AT-1', expires_in: 3600 },
    });
    const login = stitch({
        url: 'https://auth.example.com/login',
        method: 'POST',
        adapter: loginAdapter,
    });

    const seen: unknown[] = [];
    const api = stitch({
        url: 'https://api.example.com/issues',
        store: memoryStore(),
        adapter: async () => ({ status: 200, headers: {}, body: { ok: true } }),
        auth: cookieSession({
            login,
            cookie: 'sid',
            tenancy: 'app', // standalone stitch: no principal to bind
            onRefresh: (result) => {
                seen.push(result);
            },
        }),
    });

    await api();

    check('onRefresh fired once', seen.length, 1);
    const result = seen[0] as Record<string, unknown>;
    note('what the hook received', JSON.stringify(result));
    check(
        'fields handed to the host',
        Object.keys(result).sort().join(','),
        'ok,status',
    );
    // The rotated token was IN the login response and reached nothing the host can read.
    check('login body reachable from the hook', 'body' in result, false);
    check('rotated refresh_token reachable', 'refresh_token' in result, false);

    finish(
        'C7',
        'cookieSession reports only {ok, status} — the login RESPONSE BODY is never surfaced, so it cannot carry a rotated token',
    );
}

void main();

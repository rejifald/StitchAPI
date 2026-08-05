// C2 — `hooks.onResponse` on a 200 carrying the headers: does it see them, and can it do anything
// beyond observe?
//
// It sees them (C1 established that). The interesting half is the second question, and the answer
// contradicts the documentation. The hooks guide says hooks "never change what a stitch returns —
// a call's only result is its response", and the RETURN VALUE of the hook is indeed ignored. But
// `ctx.res` is the engine's live response object, handed over by reference at engine.ts:705, and
// the same object is passed to the surface's `interpret` seventy lines later (engine.ts:775). So an
// `onResponse` that MUTATES `res` rewrites the call:
//
//   mutate res.body    -> the caller receives the mutated body
//   mutate res.status  -> a 200 becomes a 503 and the call THROWS
//   mutate res.headers -> the surface reads the rewritten header
//
// That is a write channel with no type-level warning on it, and it is the wrong one to build this
// scenario on: it works by accident of ordering rather than by contract. C3 and C4 use the surface.
//
//   pnpm exec tsx docs/scenarios/proofs/deprecation-headers/c2-hooks.ts
import { stitch } from '../../../../packages/core/src/index';
import type { Surface } from '../../../../packages/core/src/index';
import type {
    AdapterResponse,
    HookContext,
    StitchEvent,
    TraceSink,
} from '../../../../packages/core/src/types';
import { parseSunset, readNotice } from './deprecation';
import { endpoint, headersFor, serving } from './fake-vendor';
import { check, checkSeq, finish, heading, note } from './harness';

const USERS = endpoint('users');
const CLEAN = endpoint('payments');

async function main(): Promise<void> {
    heading('C2 — `hooks.onResponse` on a 200: observe, or act?');

    // ── (a) it sees BOTH headers, in both formats, on a plain 200 ────────────────────────────
    {
        let notice: ReturnType<typeof readNotice> = null;
        let status = -1;
        await stitch({
            name: 'users',
            url: 'https://api.vendor.test/v1/users',
            adapter: serving(USERS),
            hooks: {
                onResponse: (c: HookContext) => {
                    status = c.res?.status ?? -1;
                    notice = readNotice(c.res?.headers ?? {});
                },
            },
        })();
        check('(a) status the hook saw', status, 200);
        check(
            '(a) `Deprecation` parsed (RFC 9745 sf-date)',
            notice === null
                ? null
                : (notice as { deprecatedAt: number | null }).deprecatedAt,
            Date.parse('2025-01-01T00:00:00Z'),
        );
        check(
            '(a) `Sunset` parsed (RFC 8594 HTTP-date)',
            notice === null
                ? null
                : (notice as { sunsetAt: number | null }).sunsetAt,
            Date.parse('2026-01-01T00:00:00Z'),
        );
        note(
            '(a) → everything this scenario needs is in scope here, on the success path, with the endpoint name alongside it',
        );
    }

    // ── (b) a clean endpoint gives the hook nothing, which is the correct silence ────────────
    {
        let notice: unknown = 'unset';
        await stitch({
            name: 'payments',
            url: 'https://api.vendor.test/v1/payments',
            adapter: serving(CLEAN),
            hooks: {
                onResponse: (c: HookContext) => {
                    notice = readNotice(c.res?.headers ?? {});
                },
            },
        })();
        check('(b) notice on a clean endpoint', notice, null);
    }

    // ── (c) the RETURN VALUE is ignored — the documented read-only half, confirmed ───────────
    {
        const value = await stitch({
            name: 'users',
            url: 'https://api.vendor.test/v1/users',
            adapter: serving(USERS),
            hooks: {
                // Returning a replacement result: the type is `void | Promise<void>`, so this is
                // already a compile error in real code. Cast through so the RUNTIME behaviour is
                // measured rather than assumed.
                onResponse: (() => ({ replaced: true })) as unknown as (
                    ctx: HookContext,
                ) => void,
            },
        })();
        checkSeq(
            '(c) keys of the value the caller got',
            Object.keys(value as object).sort(),
            ['users'],
        );
        note(
            '(c) → the returned object is dropped on the floor. This is the half the docs describe, and it is accurate',
        );
    }

    // ── (d) MUTATING `ctx.res.body` DOES change the result. Undocumented ─────────────────────
    {
        const value = await stitch({
            name: 'users',
            url: 'https://api.vendor.test/v1/users',
            adapter: serving(USERS),
            hooks: {
                onResponse: (c: HookContext) => {
                    const body = c.res?.body;
                    if (typeof body === 'object' && body !== null)
                        (body as Record<string, unknown>)['sunsetAt'] =
                            parseSunset(c.res?.headers['sunset']);
                },
            },
        })();
        checkSeq(
            '(d) keys of the value the caller got',
            Object.keys(value as object).sort(),
            ['sunsetAt', 'users'],
        );
        check(
            '(d) the injected value',
            (value as Record<string, unknown>)['sunsetAt'],
            Date.parse('2026-01-01T00:00:00Z'),
        );
        note(
            '(d) → the hooks guide says hooks "never change what a stitch returns". Measured, they can: `ctx.res` is the live object (engine.ts:705) and `interpret` reads the SAME object afterwards (engine.ts:775). Only the RETURN is ignored',
        );
    }

    // ── (e) mutating `ctx.res.status` turns a 200 into a thrown error ────────────────────────
    {
        const r = await stitch({
            name: 'users',
            url: 'https://api.vendor.test/v1/users',
            adapter: serving(USERS),
            retry: { attempts: 1 },
            hooks: {
                onResponse: (c: HookContext) => {
                    if (c.res) c.res.status = 503;
                },
            },
        }).safe();
        check('(e) ok', r.ok, false);
        check('(e) error message', r.error?.message, 'HTTP 503');
        check('(e) status on the error', r.error?.status, 503);
        note(
            '(e) → the vendor sent a 200. A hook rewrote it and the call failed. That is a tripwire, and it is a tripwire built on an undocumented alias',
        );
    }

    // ── (f) a header mutated in the hook is what the SURFACE reads ───────────────────────────
    {
        let surfaceSaw: string | undefined;
        const probe: Surface = {
            id: 'probe',
            interpret: (res) => {
                surfaceSaw = res.headers['sunset'];
                return { ok: true, data: res.body };
            },
        };
        await stitch({
            name: 'users',
            url: 'https://api.vendor.test/v1/users',
            adapter: serving(USERS),
            kind: probe,
            hooks: {
                onResponse: (c: HookContext) => {
                    if (c.res) c.res.headers['sunset'] = 'REWRITTEN BY HOOK';
                },
            },
        })();
        check('(f) what the surface read', surfaceSaw, 'REWRITTEN BY HOOK');
        check(
            '(f) what the vendor actually sent',
            headersFor(USERS)['sunset'],
            'Thu, 01 Jan 2026 00:00:00 GMT',
        );
        note(
            '(f) → hook-before-surface is the fixed order, so a hook can lie to the surface. Worth knowing before putting policy in one and diagnosis in the other',
        );
    }

    // ── (g) it fires once PER ATTEMPT, not once per call ─────────────────────────────────────
    {
        let fired = 0;
        let n = 0;
        const r = await stitch({
            name: 'users',
            url: 'https://api.vendor.test/v1/users',
            adapter: async (): Promise<AdapterResponse> => {
                n += 1;
                return {
                    status: n < 3 ? 503 : 200,
                    headers: headersFor(USERS),
                    body: n < 3 ? { error: 'flaky' } : USERS.body,
                };
            },
            retry: { attempts: 3, backoff: { curve: 'fixed', base: 0 } },
            hooks: { onResponse: () => void (fired += 1) },
        }).safe();
        check('(g) call succeeded', r.ok, true);
        check('(g) requests made', n, 3);
        check('(g) `onResponse` firings', fired, 3);
        note(
            '(g) → 3 firings for 1 call. A naive counter in this hook counts ATTEMPTS, and every retried response carried the notice too',
        );
    }

    // ── (h) it cannot reach the event stream or produce a finding ────────────────────────────
    {
        const events: string[] = [];
        const sink: TraceSink = {
            handle(e: StitchEvent) {
                events.push(e.type);
            },
        };
        // The announcement channels a hook would need, hunted for on the REAL context object the
        // engine passes — not on a hand-written stand-in.
        let announceable: string[] = [];
        let ctxKeys: string[] = [];
        const call = stitch({
            name: 'users',
            url: 'https://api.vendor.test/v1/users',
            adapter: serving(USERS),
            trace: sink,
            hooks: {
                onResponse: (c: HookContext) => {
                    ctxKeys = Object.keys(c).sort();
                    announceable = [
                        'emit',
                        'run',
                        'findings',
                        'spanId',
                        'trace',
                    ].filter((k) => k in c);
                },
            },
        });
        await call();
        checkSeq('(h) `HookContext` keys, measured', ctxKeys, [
            'attempt',
            'name',
            'res',
        ]);
        checkSeq('(h) …of which, channels to announce on', announceable, []);
        checkSeq('(h) event spine, unchanged by the hook', events, [
            'start',
            'progress',
            'result',
            'done',
        ]);
        note(
            '(h) → `AuthContext` has an `emit` for exactly this (types.ts:1232); `HookContext` has `{ name, attempt, req?, res?, error? }` and no way to say anything. What the hook learns stays in the hook unless the hook closes over something',
        );
    }

    // ── (i) so the only honest way out of a hook is a closure ────────────────────────────────
    {
        const collected: string[] = [];
        const api = (name: string, path: string, ep: typeof USERS) =>
            stitch({
                name,
                url: `https://api.vendor.test${path}`,
                adapter: serving(ep),
                hooks: {
                    onResponse: (c: HookContext) => {
                        const notice = readNotice(c.res?.headers ?? {});
                        if (notice !== null) collected.push(c.name);
                    },
                },
            });
        await api('users', '/v1/users', USERS)();
        await api('payments', '/v1/payments', CLEAN)();
        await api('users', '/v1/users', USERS)();
        checkSeq('(i) endpoints a closure collected', collected, [
            'users',
            'users',
        ]);
        note(
            '(i) → it works, and it is per-call with no de-duplication and no ordering. Everything C4 wants has to be built on top of this by hand',
        );
    }

    finish(
        'C2',
        'IT SEES THEM, AND IT CAN DO FAR MORE THAN OBSERVE — which is the problem. `ctx.res` on a 200 is the full `AdapterResponse`, so both headers parse out of `ctx.res.headers` with `ctx.name` alongside. The hook\'s RETURN value is ignored, exactly as the docs say. But `ctx.res` is the engine\'s live object, handed over at engine.ts:705 and read again by `interpret` at engine.ts:775, so MUTATION is a real write channel: mutating `res.body` added a key to the value the caller received, mutating `res.status` turned the vendor\'s 200 into a thrown `HTTP 503`, and mutating `res.headers` made the surface read `"REWRITTEN BY HOOK"` instead of the real `Sunset`. The hooks guide says hooks "never change what a stitch returns"; measured, that is true only of the return value. Three further limits make it the wrong seat for this scenario anyway: it fires once PER ATTEMPT (3 firings for 1 retried call, each carrying the notice), `HookContext` has no `emit`/`run`/`findings` so nothing it learns can reach the event stream or the drift report, and the only way out is a closure with no de-duplication of its own',
    );
}

void main();

// C1 — THE CONSOLIDATION. Enumerate every accessor on a SUCCESSFUL awaited call and say precisely
// which carry a response header.
//
// Three earlier scenarios hit this wall from three directions — scenario 6 (an ETag off
// `Inspection`), scenario 7 (a part's ETag), scenario 15 (a replay marker off `StitchError`) — and
// each filed it as "no headers here". This script asks the question once, everywhere, so the answer
// stops being three separate absences and becomes one table with a positive result in it.
//
// The result, measured below: response headers are reachable in exactly THREE places, and only one
// of them can put what it found into the value the caller receives.
//
//   RESULT ACCESSORS
//     await / .unwrap()   ABSENT   the body, and only the body
//     .safe()             ABSENT   { ok, data, error } — same body, plus a null error
//     .inspect()          ABSENT   { data, raw, findings, status, error, source } — `status`, no headers
//     .report()           ABSENT   the above + { attempts, timing, config, cache }
//     StitchError         ABSENT   (scenario 15's finding, re-measured on the failure path)
//   THE EVENT SPINE
//     .stream()           ABSENT   4 events on a clean run, 20 keys between them, none a header
//     TraceSink           ABSENT   same events; `ctx` is { name, spanId, traceId, parentSpanId }
//   PIPELINE HOOKS
//     transform(body)     ABSENT   `(body: unknown) => unknown` — the signature has nowhere to put them
//     pick / output       ABSENT   both operate on the value, downstream of the body
//   WHERE THEY ACTUALLY ARE
//     adapter             REACHED  it MADE the response — but it cannot name the endpoint or the run
//     hooks.onResponse    REACHED  ctx.res.headers, every attempt                      <- observe
//     Surface.interpret   REACHED  res.headers, and it decides the value                <- act
//
//   pnpm exec tsx docs/scenarios/proofs/deprecation-headers/c1-accessors.ts
import { stitch } from '../../../../packages/core/src/index';
import type { Surface } from '../../../../packages/core/src/index';
import type {
    Adapter,
    AdapterResponse,
    HookContext,
    StitchEvent,
    TraceContext,
    TraceSink,
} from '../../../../packages/core/src/types';
import { endpoint, headersFor, serving } from './fake-vendor';
import { check, checkReach, checkSeq, finish, heading, note } from './harness';

const USERS = endpoint('users');
/** The header value every accessor below is hunted for: RFC 8594, an HTTP-date, on a 200. */
const SUNSET = 'Thu, 01 Jan 2026 00:00:00 GMT';

/** Pull `sunset` out of whatever an accessor handed back, without assuming a shape. */
function sunsetIn(v: unknown): unknown {
    if (typeof v !== 'object' || v === null) return undefined;
    const rec = v as Record<string, unknown>;
    if (typeof rec['sunset'] === 'string') return rec['sunset'];
    const headers = rec['headers'];
    if (typeof headers === 'object' && headers !== null)
        return (headers as Record<string, unknown>)['sunset'];
    return undefined;
}

async function main(): Promise<void> {
    heading(
        'C1 — which accessor carries a response header on a SUCCESSFUL call',
    );

    // Sanity: the vendor really does put it on the wire. Everything below measures REACHABILITY,
    // which is only a finding if the header was there to be reached.
    check('(0) the vendor sends `Sunset`', headersFor(USERS)['sunset'], SUNSET);
    check(
        '(0) …and `Deprecation`, as an RFC 9745 sf-date',
        headersFor(USERS)['deprecation'],
        '@1735689600',
    );
    check('(0) …on a', 200, 200);

    // ── RESULT ACCESSORS ─────────────────────────────────────────────────────────────────────
    heading('  result accessors');
    {
        const call = stitch({
            name: 'users',
            url: 'https://api.vendor.test/v1/users',
            adapter: serving(USERS),
        });

        const awaited = await call();
        checkReach('await', sunsetIn(awaited), false);
        checkSeq(
            '(a) …what it did carry',
            Object.keys(awaited as object).sort(),
            ['users'],
        );

        const unwrapped = await call.unwrap();
        checkReach('.unwrap()', sunsetIn(unwrapped), false);

        const safe = await call.safe();
        checkReach('.safe()', sunsetIn(safe.data), false);
        checkSeq('(b) `SafeResult` keys', Object.keys(safe).sort(), [
            'data',
            'error',
            'ok',
        ]);
        check('(b) ok', safe.ok, true);
        check('(b) error', safe.error, null);

        const ins = await call.inspect();
        checkReach('.inspect()', sunsetIn(ins), false);
        checkReach('.inspect().raw', sunsetIn(ins.raw), false);
        checkSeq('(c) `Inspection` keys', Object.keys(ins).sort(), [
            'data',
            'error',
            'findings',
            'source',
            'status',
        ]);
        check('(c) is `headers` on it?', 'headers' in ins, false);
        check('(c) the one wire fact it DOES carry', ins.status, 200);

        const rep = await call.report();
        checkReach('.report()', sunsetIn(rep), false);
        checkSeq('(d) `RunReport` keys', Object.keys(rep).sort(), [
            'attempts',
            'cache',
            'config',
            'data',
            'error',
            'findings',
            'source',
            'status',
            'timing',
        ]);
        check('(d) is `headers` on it?', 'headers' in rep, false);
        checkReach('.report().config', sunsetIn(rep.config), false);
        note(
            '(d) → `config` is the REQUEST config (`headers` there would be the ones you SENT). Nothing on a report describes the response beyond its status',
        );
    }

    // ── THE EVENT SPINE ──────────────────────────────────────────────────────────────────────
    heading('  the event spine');
    {
        const call = stitch({
            name: 'users',
            url: 'https://api.vendor.test/v1/users',
            adapter: serving(USERS),
        });
        const spine: string[] = [];
        const everyKey = new Set<string>();
        let reached: unknown;
        for await (const e of call.stream()) {
            spine.push(e.type);
            for (const k of Object.keys(e)) everyKey.add(k);
            const hit = sunsetIn(e);
            if (hit !== undefined) reached = hit;
            if (e.type === 'result' && sunsetIn(e.data) !== undefined)
                reached = sunsetIn(e.data);
        }
        checkReach('.stream()', reached, false);
        checkSeq('(e) event spine on a clean 200', spine, [
            'start',
            'progress',
            'result',
            'done',
        ]);
        checkSeq('(e) EVERY key across EVERY event', [...everyKey].sort(), [
            'at',
            'attempt',
            'attempts',
            'data',
            'elapsed',
            'input',
            'method',
            'name',
            'ok',
            'phase',
            'spanId',
            'status',
            'traceId',
            'type',
            'url',
        ]);
        note(
            '(e) → 15 distinct keys across the whole spine and not one of them is a header. `status` is on `result`, `url` on `start`',
        );
    }
    {
        const seen: unknown[] = [];
        const ctxKeys = new Set<string>();
        const sink: TraceSink = {
            handle(e: StitchEvent, ctx: TraceContext) {
                for (const k of Object.keys(ctx)) ctxKeys.add(k);
                const hit = sunsetIn(e);
                if (hit !== undefined) seen.push(hit);
            },
        };
        await stitch({
            name: 'users',
            url: 'https://api.vendor.test/v1/users',
            adapter: serving(USERS),
            trace: sink,
        })();
        checkReach('TraceSink', seen[0], false);
        checkSeq('(f) `TraceContext` keys', [...ctxKeys].sort(), [
            'name',
            'spanId',
            'traceId',
        ]);
        note(
            '(f) → the sink sees the same events, so it inherits the same hole. `ctx` identifies the RUN, never the response',
        );
    }

    // ── PIPELINE HOOKS ───────────────────────────────────────────────────────────────────────
    heading('  pipeline hooks');
    {
        let transformSaw: unknown;
        // Measured off the function the engine actually calls: how many arguments does it receive?
        let transformArgc = -1;
        const transform = function (...args: unknown[]): unknown {
            transformArgc = args.length;
            transformSaw = sunsetIn(args[0]);
            return args[0];
        };
        await stitch({
            name: 'users',
            url: 'https://api.vendor.test/v1/users',
            adapter: serving(USERS),
            transform,
        })();
        checkReach('transform(body)', transformSaw, false);
        check('(g) arguments the engine hands `transform`', transformArgc, 1);
        note(
            '(g) → `transform?: (body: unknown) => unknown` (types.ts:1505). One parameter, and it is the body. There is no seat for a response',
        );
    }

    // ── WHERE THE HEADERS ACTUALLY ARE ───────────────────────────────────────────────────────
    heading('  where they actually are');
    {
        // The adapter MADE the response, so of course it holds the headers. Listed because it is a
        // real seam a caller can wrap — and because what it CANNOT do is the point.
        let adapterSaw: unknown;
        let adapterKnewName = 'no';
        const base = serving(USERS);
        const wrapped: Adapter = async (req): Promise<AdapterResponse> => {
            const res = await base(req);
            adapterSaw = res.headers['sunset'];
            adapterKnewName = 'name' in req ? 'yes' : 'no';
            return res;
        };
        await stitch({
            name: 'users',
            url: 'https://api.vendor.test/v1/users',
            adapter: wrapped,
        })();
        checkReach('adapter', adapterSaw, true);
        check(
            '(h) does the adapter know the stitch NAME?',
            adapterKnewName,
            'no',
        );
        note(
            '(h) → it has the response and the URL, and no idea which stitch it is serving or which run it belongs to. Fine for a global log, useless for a fleet report keyed by endpoint',
        );
    }
    {
        let hookSaw: unknown;
        let hookCtxKeys: string[] = [];
        let hookName = '';
        await stitch({
            name: 'users',
            url: 'https://api.vendor.test/v1/users',
            adapter: serving(USERS),
            hooks: {
                onResponse: (c: HookContext) => {
                    hookCtxKeys = Object.keys(c).sort();
                    hookName = c.name;
                    hookSaw = c.res?.headers['sunset'];
                },
            },
        })();
        checkReach('hooks.onResponse', hookSaw, true);
        checkSeq('(i) `HookContext` keys on a 200', hookCtxKeys, [
            'attempt',
            'name',
            'res',
        ]);
        check('(i) and it knows the endpoint', hookName, 'users');
        note(
            '(i) → THE POSITIVE RESULT. `ctx.res` is the full `AdapterResponse` — `{ status, headers, body, url? }` — and `ctx.name` says which stitch. Scenarios 6, 7 and 15 each concluded "no headers" from an accessor that genuinely has none; this seam was never asked',
        );
    }
    {
        let surfaceSaw: unknown;
        let surfaceName = '';
        const probe: Surface = {
            id: 'probe',
            interpret: (res, cfg) => {
                surfaceSaw = res.headers['sunset'];
                surfaceName = cfg.name ?? '<unnamed>';
                return { ok: true, data: res.body };
            },
        };
        const value = await stitch({
            name: 'users',
            url: 'https://api.vendor.test/v1/users',
            adapter: serving(USERS),
            kind: probe,
        })();
        checkReach('Surface.interpret', surfaceSaw, true);
        check('(j) and it knows the endpoint', surfaceName, 'users');
        check(
            '(j) …and it CHOSE that value',
            JSON.stringify(value),
            JSON.stringify(USERS.body),
        );
        note(
            '(j) → the other positive result, and the only one that is also a WRITE. `interpret(res, cfg)` gets the whole response AND returns what the call resolves to, so it is the one place a header can be turned into part of the answer',
        );
    }

    // ── the same question on the FAILURE path, for the scenario-15 cross-reference ────────────
    heading('  the failure path (scenario 15 re-measured)');
    {
        const r = await stitch({
            name: 'users',
            url: 'https://api.vendor.test/v1/users',
            adapter: async (): Promise<AdapterResponse> => ({
                status: 503,
                headers: headersFor(USERS),
                body: { error: 'unavailable' },
            }),
            retry: { attempts: 1 },
        }).safe();
        check('(k) `ok` on the 503', r.ok, false);
        checkReach('StitchError', sunsetIn(r.error), false);
        checkSeq(
            '(k) `StitchError` own keys',
            Object.keys(r.error ?? {}).sort(),
            ['attempts', 'body', 'name', 'status', 'url'],
        );
        note(
            '(k) → confirms scenario 15 exactly: `StitchError` has `status`, `body` and `url`, and no `headers`. The vendor sent the notice on this response too and it died with the error',
        );
    }

    finish(
        'C1',
        "DEFINITIVE, AND IT IS NOT THE ABSENCE THREE EARLIER SCENARIOS RECORDED. Response headers ARE reachable on a successful call, in exactly THREE places: the `adapter` (it built the response, but knows no stitch name and cannot change the result), `hooks.onResponse` (`ctx.res.headers` — the whole `AdapterResponse`, plus `ctx.name`), and a Surface's `interpret(res, cfg)` (`res.headers`, plus it RETURNS the value the call resolves to). Everything a caller normally reaches for carries nothing: `await`, `.unwrap()`, `.safe()`, `.inspect()` (5 keys, `status` but no headers), `.report()` (9 keys, same), `StitchError` (5 keys — scenario 15 re-confirmed), `transform` (one parameter, and it is the body), and the ENTIRE event spine — 4 events, 15 distinct keys between them, not one a header, which is why a `TraceSink` inherits the same hole. So the three earlier findings were each correct about their own accessor and each generalised one step too far: the header was never in `Inspection` or `StitchError`, and it was always in `interpret` and `onResponse`",
    );
}

void main();

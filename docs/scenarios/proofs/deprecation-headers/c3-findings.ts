// C3 — can a header-derived warning become a FINDING in the same channel as drift: levelled,
// non-fatal, naming the endpoint? Or does it need a parallel mechanism?
//
// The answer is YES, through one narrow door, and the door costs something. A surface can fold the
// notice into the value; an `output` contract that does not declare it then reports it as an
// `undeclared` soft-drift finding, on the ordinary drift channel, non-fatal, at `info` — and
// `severity: { undeclared: 'warn' }` re-levels it. So it reports where everything else reports.
//
// Three things it is NOT:
//   • the finding does not carry the header VALUE — `detail` is `undeclared field (object)`, so it
//     says "there is a notice here", never "the sunset is 1 Jan"
//   • the finding does not name the ENDPOINT — `DriftFinding` is `{ level, path, change, detail,
//     sample }`; the endpoint is `ctx.name`, and only a sink has that
//   • re-levelling is per-KIND, not per-path, so raising the notice to `warn` raises every other
//     undeclared field with it
//
// And there is no API at all for minting a finding directly: `drift()` takes a schema, a `Validator`
// returns `{ ok, value }` or `{ ok, issues }`, and issues are HARD (fatal) findings. A levelled
// non-fatal finding of your own design is not expressible.
//
//   pnpm exec tsx docs/scenarios/proofs/deprecation-headers/c3-findings.ts
import { drift, stitch } from '../../../../packages/core/src/index';
import type { Validator } from '../../../../packages/core/src/index';
import type {
    DriftFinding,
    StitchEvent,
    TraceContext,
    TraceSink,
} from '../../../../packages/core/src/types';
import { deprecationSurface, readNotice } from './deprecation';
import { endpoint, headersFor, serving } from './fake-vendor';
import { check, checkSeq, finish, heading, note } from './harness';

const USERS = endpoint('users');
const CLEAN = endpoint('payments');

/** One finding, flattened to a line — level, kind, path, detail. */
const fmt = (f: DriftFinding): string =>
    `${f.level}|${f.change}|${f.path}|${f.detail ?? '<none>'}`;

/** A permissive `output` that declares only `users` — everything else is undeclared drift. */
const declaresUsersOnly: Validator<{ users: unknown }> = {
    validate: async (v: unknown) => ({
        ok: true as const,
        value: { users: (v as Record<string, unknown>)['users'] },
    }),
};

async function main(): Promise<void> {
    heading('C3 — can a header-derived warning join the drift channel?');

    // ── (a) it can. Fold in the surface, and the contract reports it as drift ────────────────
    {
        const sinkFindings: string[] = [];
        const sink: TraceSink = {
            handle(e: StitchEvent, ctx: TraceContext) {
                if (e.type === 'drift')
                    sinkFindings.push(`${ctx.name} ${fmt(e.finding)}`);
            },
        };
        const call = stitch({
            name: 'users',
            url: 'https://api.vendor.test/v1/users',
            adapter: serving(USERS),
            kind: deprecationSurface({ fold: true }),
            output: drift(declaresUsersOnly),
            trace: sink,
        });
        const r = await call.safe();
        check('(a) the call still succeeded', r.ok, true);
        check('(a) …and did not throw', r.error, null);
        checkSeq('(a) the finding, at the sink', sinkFindings, [
            'users info|undeclared|_deprecation|undeclared field (object)',
        ]);
        note(
            '(a) → a real drift finding, on the ordinary channel, from a RESPONSE HEADER. Non-fatal: `ok: true`, `error: null`, and the value flowed',
        );
    }

    // ── (b) a clean endpoint produces no finding — the silence has to be real ────────────────
    {
        const found: string[] = [];
        const sink: TraceSink = {
            handle(e: StitchEvent) {
                if (e.type === 'drift') found.push(fmt(e.finding));
            },
        };
        await stitch({
            name: 'payments',
            url: 'https://api.vendor.test/v1/payments',
            adapter: serving(CLEAN),
            kind: deprecationSurface({ fold: true }),
            output: drift({
                validate: async (v: unknown) => ({
                    ok: true as const,
                    value: {
                        balance: (v as Record<string, unknown>)['balance'],
                    },
                }),
            } satisfies Validator<{ balance: unknown }>),
            trace: sink,
        }).safe();
        checkSeq('(b) findings on a clean endpoint', found, []);
        check(
            '(b) …because the vendor sent no notice',
            readNotice(headersFor(CLEAN)),
            null,
        );
    }

    // ── (c) the level is settable — but per KIND, not per path ───────────────────────────────
    {
        const levels: string[] = [];
        const sink: TraceSink = {
            handle(e: StitchEvent) {
                if (e.type === 'drift') levels.push(fmt(e.finding));
            },
        };
        await stitch({
            name: 'users',
            url: 'https://api.vendor.test/v1/users',
            adapter: serving(USERS),
            kind: deprecationSurface({ fold: true }),
            output: drift(declaresUsersOnly, {
                severity: { undeclared: 'warn' },
            }),
            trace: sink,
        }).safe();
        checkSeq('(c) re-levelled to `warn`', levels, [
            'warn|undeclared|_deprecation|undeclared field (object)',
        ]);
        note(
            '(c) → `severity: { undeclared: "warn" }` works. It is a map of CHANGE KIND to level (types.ts:112-115), so there is no way to raise this one path without raising every undeclared field the vendor ever adds',
        );
    }
    {
        // The collateral, measured: a vendor that adds an unrelated field gets the same `warn`.
        const levels: string[] = [];
        const sink: TraceSink = {
            handle(e: StitchEvent) {
                if (e.type === 'drift') levels.push(fmt(e.finding));
            },
        };
        await stitch({
            name: 'users',
            url: 'https://api.vendor.test/v1/users',
            adapter: async () => ({
                status: 200,
                headers: headersFor(USERS),
                // The vendor ships a harmless new field on the same response.
                body: { users: [], experimental_ranking: true },
            }),
            kind: deprecationSurface({ fold: true }),
            output: drift(declaresUsersOnly, {
                severity: { undeclared: 'warn' },
            }),
            trace: sink,
        }).safe();
        checkSeq('(c) …and what it dragged up with it', levels.sort(), [
            'warn|undeclared|_deprecation|undeclared field (object)',
            'warn|undeclared|experimental_ranking|undeclared field (boolean)',
        ]);
        note(
            '(c) → a new vendor field is now a `warn` because a deprecation notice needed to be one. Re-levelling is a blunt instrument here',
        );
    }

    // ── (d) what the finding does NOT carry ──────────────────────────────────────────────────
    {
        const call = stitch({
            name: 'users',
            url: 'https://api.vendor.test/v1/users',
            adapter: serving(USERS),
            kind: deprecationSurface({ fold: true }),
            output: drift(declaresUsersOnly),
        });
        const ins = await call.inspect();
        const f = ins.findings[0];
        checkSeq('(d) `DriftFinding` keys', Object.keys(f ?? {}).sort(), [
            'change',
            'detail',
            'level',
            'path',
        ]);
        check(
            '(d) does `detail` carry the sunset date?',
            f?.detail,
            'undeclared field (object)',
        );
        check(
            '(d) does the finding name the endpoint?',
            'endpoint' in (f ?? {}) || 'name' in (f ?? {}),
            false,
        );
        note(
            '(d) → the finding says a notice EXISTS and where in the payload it sits. It cannot say when the sunset is, and it cannot say which endpoint — `ctx.name` at a sink is the only thing that can',
        );
    }

    // ── (e) …unless you smuggle the value into the PATH, which works and is horrible ─────────
    {
        const found: string[] = [];
        const sink: TraceSink = {
            handle(e: StitchEvent) {
                if (e.type === 'drift') found.push(fmt(e.finding));
            },
        };
        await stitch({
            name: 'users',
            url: 'https://api.vendor.test/v1/users',
            adapter: serving(USERS),
            kind: {
                id: 'smuggle',
                interpret: (res) => {
                    const n = readNotice(res.headers);
                    const key =
                        n?.sunsetAt == null
                            ? '_ok'
                            : `_sunset_${new Date(n.sunsetAt).toISOString().slice(0, 10)}`;
                    return {
                        ok: true,
                        data: { ...(res.body as object), [key]: true },
                    };
                },
            },
            output: drift(declaresUsersOnly),
            trace: sink,
        }).safe();
        checkSeq('(e) the date, carried in the finding path', found, [
            'info|undeclared|_sunset_2026-01-01|undeclared field (boolean)',
        ]);
        note(
            '(e) → the date IS now in the finding, because the path is the only free-form string a finding has. It also means every distinct sunset date is a distinct finding path, which no drift report is designed for',
        );
    }

    // ── (f) minting a finding directly: there is no API ──────────────────────────────────────
    {
        // A `Validator` may only return a value or ISSUES, and issues are HARD findings that FAIL
        // the call. Measured, so "you could just emit a warning from the validator" is closed off.
        const found: string[] = [];
        const sink: TraceSink = {
            handle(e: StitchEvent) {
                if (e.type === 'drift') found.push(fmt(e.finding));
            },
        };
        const r = await stitch({
            name: 'users',
            url: 'https://api.vendor.test/v1/users',
            adapter: serving(USERS),
            kind: deprecationSurface({ fold: true }),
            output: drift({
                validate: async () => ({
                    ok: false as const,
                    issues: [
                        {
                            path: ['_deprecation', 'sunsetAt'],
                            message: 'endpoint is deprecated',
                        },
                    ],
                }),
            } satisfies Validator<unknown>),
            trace: sink,
        }).safe();
        check('(f) a validator-issued finding is FATAL', r.ok, false);
        check(
            '(f) …and this is what the caller sees',
            r.error?.message,
            'contract violation (drift)',
        );
        checkSeq('(f) the finding it produced', found, [
            'error|invalid|_deprecation.sunsetAt|endpoint is deprecated',
        ]);
        note(
            '(f) → the only finding user code can author directly is an `error|invalid`, and it kills the call. `ValidationResult` is `{ ok, value } | { ok, issues }` (validator.ts:11-12) — there is no third arm for a warning',
        );
    }

    // ── (g) which accessors carry the header-derived finding ─────────────────────────────────
    {
        const streamed: string[] = [];
        const sunk: string[] = [];
        const sink: TraceSink = {
            handle(e: StitchEvent) {
                if (e.type === 'drift') sunk.push(fmt(e.finding));
            },
        };
        const call = stitch({
            name: 'users',
            url: 'https://api.vendor.test/v1/users',
            adapter: serving(USERS),
            kind: deprecationSurface({ fold: true }),
            output: drift(declaresUsersOnly),
            trace: sink,
        });
        for await (const e of call.stream())
            if (e.type === 'drift') streamed.push(fmt(e.finding));
        const safe = await call.safe();
        const ins = await call.inspect();
        const rep = await call.report();

        checkSeq('(g) `.stream()`', streamed, [
            'info|undeclared|_deprecation|undeclared field (object)',
        ]);
        checkSeq('(g) `.inspect().findings`', ins.findings.map(fmt), [
            'info|undeclared|_deprecation|undeclared field (object)',
        ]);
        checkSeq('(g) `.report().findings`', rep.findings.map(fmt), [
            'info|undeclared|_deprecation|undeclared field (object)',
        ]);
        checkSeq(
            '(g) trace sink (4 runs)',
            [...new Set(sunk)],
            ['info|undeclared|_deprecation|undeclared field (object)'],
        );
        checkSeq('(g) `.safe()` — anything?', Object.keys(safe).sort(), [
            'data',
            'error',
            'ok',
        ]);
        check('(g) `findings` on `SafeResult`?', 'findings' in safe, false);
        note(
            '(g) → four accessors carry it and the awaited path carries none of it, which is exactly the drift table from scenario 12. The notice now has the same reporting reach as every other finding — and the same blind spot',
        );
    }

    finish(
        'C3',
        'YES, THROUGH ONE NARROW DOOR, AND IT COSTS SOMETHING. A surface folds the notice into the value and an `output` contract that does not declare it reports `info|undeclared|_deprecation|undeclared field (object)` — a genuine drift finding on the ordinary channel, non-fatal (`ok: true`, `error: null`, value delivered), visible on `.stream()`, `.inspect().findings`, `.report().findings` and a `TraceSink`, invisible on `.safe()`. `severity: { undeclared: "warn" }` re-levels it. Three limits, all measured: the finding does NOT carry the header value (`detail` is `undeclared field (object)`, so it says a notice exists and never says the sunset is 1 Jan) — unless you smuggle the date into the PATH, which works (`_sunset_2026-01-01`) and makes every date its own finding path; the finding does NOT name the endpoint (`DriftFinding` is `{ level, path, change, detail }`; only `ctx.name` at a sink knows); and re-levelling is per-KIND, so raising the notice to `warn` also raised an unrelated new vendor field to `warn` in the same run. There is no API for minting a finding: a `Validator` returns a value or ISSUES, and an issue is an `error|invalid` that FAILS the call with `contract violation (drift)`',
    );
}

void main();

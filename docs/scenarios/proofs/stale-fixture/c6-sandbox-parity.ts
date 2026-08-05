// C6 — sandbox parity. Can one stitch be pointed at sandbox AND prod so the difference is visible?
// And is there a spelling for "run this against the real API weekly"?
//
// Two questions with two different answers, and the split is the finding.
//
//   Targeting:  YES, and cleanly. `extends` swaps `baseUrl` and `adapter` wholesale, so ONE endpoint
//               definition can be aimed at a fixture, a sandbox and prod with a one-line fragment.
//               `.with()` cannot — it is `Partial<StitchInput>` and a `baseUrl` there is a compile
//               error, which is the right answer to the wrong question.
//   Scheduling: NO. There is no `env`/`sandbox`/`profile` key (an unknown key is a compile error),
//               no CLI verb that runs a verification, and nothing that records when a check last ran.
//               The comparison is 100% yours to write and yours to remember to run.
//
//   pnpm exec tsx docs/scenarios/proofs/stale-fixture/c6-sandbox-parity.ts
import { seam, stitch } from '../../../../packages/core/src/index';
import type { Stitch, StitchConfig } from '../../../../packages/core/src/types';
import { check, checkSeq, finish, heading, note } from './harness';
import { RECORDED_2026_02_04, VENDOR_TODAY, vendorAdapter } from './vendor';
import { z } from './zod';

import { readFileSync } from 'node:fs';

const SANDBOX = 'https://sandbox.billing.test';
const PROD = 'https://api.billing.test';

const Invoice = z.object({
    id: z.string(),
    amount_cents: z.number(),
    currency: z.string(),
    paid: z.boolean(),
    customer_email: z.string(),
    legacy_ref: z.string(),
});

/** The endpoint, defined ONCE. Everything environment-shaped is left to a fragment. */
const ENDPOINT = {
    name: 'getInvoice',
    path: '/v1/invoices/{id}',
    output: Invoice,
} satisfies Partial<StitchConfig>;

async function main(): Promise<void> {
    heading('C6 (a) — `extends`: one endpoint, three targets');
    {
        const fixture = vendorAdapter(RECORDED_2026_02_04);
        const sandbox = vendorAdapter(RECORDED_2026_02_04);
        const prod = vendorAdapter(VENDOR_TODAY);

        const against = (baseUrl: string, adapter: typeof fixture): Stitch =>
            stitch({
                ...ENDPOINT,
                extends: { baseUrl, adapter },
            } as never) as unknown as Stitch;

        const a = against(PROD, fixture);
        const b = against(SANDBOX, sandbox);
        const c = against(PROD, prod);
        const ra = await a.safe({ params: { id: 'inv_9f2' } });
        const rb = await b.safe({ params: { id: 'inv_9f2' } });
        const rc = await c.safe({ params: { id: 'inv_9f2' } });

        checkSeq(
            'the three URLs the transports saw',
            [fixture.seen[0]?.url, sandbox.seen[0]?.url, prod.seen[0]?.url],
            [
                `${PROD}/v1/invoices/inv_9f2`,
                `${SANDBOX}/v1/invoices/inv_9f2`,
                `${PROD}/v1/invoices/inv_9f2`,
            ],
        );
        checkSeq(
            'and the three verdicts',
            [ra.ok, rb.ok, rc.ok],
            [true, true, false],
        );
        note(
            '(a) → one `ENDPOINT` object, three `extends: { baseUrl, adapter }` fragments. The fixture and the sandbox agree; PROD fails the same `output` schema. THAT is the difference being visible',
            '',
        );
    }

    heading('C6 (b) — a seam does the same for a whole client');
    {
        const prod = vendorAdapter(VENDOR_TODAY);
        const fixture = vendorAdapter(RECORDED_2026_02_04);
        const live = seam({ baseUrl: PROD, adapter: prod });
        const fake = seam({ baseUrl: SANDBOX, adapter: fixture });
        const liveCall = live.stitch(ENDPOINT as never) as unknown as Stitch;
        const fakeCall = fake.stitch(ENDPOINT as never) as unknown as Stitch;
        const rl = await liveCall.safe({ params: { id: 'inv_9f2' } });
        const rf = await fakeCall.safe({ params: { id: 'inv_9f2' } });
        check('live seam failed', rl.ok, false);
        check('fixture seam passed', rf.ok, true);
        checkSeq(
            'urls',
            [prod.seen[0]?.url, fixture.seen[0]?.url],
            [`${PROD}/v1/invoices/inv_9f2`, `${SANDBOX}/v1/invoices/inv_9f2`],
        );
        note(
            '(b) → the seam carries `baseUrl` + `adapter` for every member at once, and a member may still override either. This is the idiomatic environment switch, and it is composition rather than configuration',
            '',
        );
    }

    heading('C6 (c) — `.with()` CANNOT retarget, and that is by design');
    {
        const call = stitch({
            ...ENDPOINT,
            baseUrl: PROD,
            adapter: vendorAdapter(RECORDED_2026_02_04),
        } as never) as unknown as Stitch;
        // @ts-expect-error — `.with()` takes Partial<StitchInput>; `baseUrl` is not an input slot
        const _bad = call.with({ baseUrl: SANDBOX });
        void _bad;
        check(
            '`.with({ baseUrl })` is a compile error (see the @ts-expect-error above)',
            true,
            true,
        );
        note(
            '(c) → `.with()` is `<P extends Partial<TIn>>(partial: P)` (types.ts:1994-1996) and `StitchInput` is `{params,query,body,headers,variables,signal,onProgress}`. It binds INPUT, never config — so it is not the environment seam, and the type says so',
            '',
        );
    }

    heading(
        'C6 (d) — the `baseUrl` thunk: the only per-call environment hatch',
    );
    {
        let target = SANDBOX;
        const wire = vendorAdapter(RECORDED_2026_02_04);
        const call = stitch({
            ...ENDPOINT,
            baseUrl: () => target,
            adapter: wire,
        } as never) as unknown as Stitch;
        await call.safe({ params: { id: 'a' } });
        target = PROD;
        await call.safe({ params: { id: 'b' } });
        checkSeq(
            'one stitch, two targets, resolved at call time',
            wire.seen.map((r) => r.url),
            [`${SANDBOX}/v1/invoices/a`, `${PROD}/v1/invoices/b`],
        );
        note(
            '(d) → `baseUrl?: string | (() => string)` (types.ts:1570). A thunk is the ONE place the library lets an environment change between calls without rebuilding the stitch',
            '',
        );
    }

    heading('C6 (e) — is there a NAMED environment concept?');
    {
        // Any unknown key is a compile error (`NoUnknownConfigKeys`, types.ts:338-342), so there is
        // no informal extension point either.
        const _reject = () =>
            stitch({
                url: PROD,
                // @ts-expect-error — no `env` slot exists on StitchConfig, and unknown keys are rejected
                env: 'sandbox',
                adapter: vendorAdapter({}),
            });
        void _reject;
        check(
            'an `env:` key is a compile error (see the @ts-expect-error above)',
            true,
            true,
        );

        const types = readFileSync(
            new URL('../../../../packages/core/src/types.ts', import.meta.url),
            'utf8',
        );
        const configBlock = types.slice(
            types.indexOf('export interface StitchConfig'),
            types.indexOf('export interface InputSchemas'),
        );
        const envish = [
            'env',
            'sandbox',
            'environment',
            'profile',
            'variant',
            'stage',
            'mode',
        ].filter((k) => new RegExp(`^\\s{4}${k}\\?:`, 'm').test(configBlock));
        checkSeq('environment-shaped slots on StitchConfig', envish, []);
        note(
            '(e) → zero. The environment is expressed by WHICH seam/fragment you built, never by a value you can read back off the config',
            '',
        );
    }

    heading(
        'C6 (f) — is there a spelling for "verify against the real API weekly"?',
    );
    {
        const cli = readFileSync(
            new URL('../../../../packages/core/src/cli.ts', import.meta.url),
            'utf8',
        );
        const help = cli.slice(
            cli.indexOf('const HELP'),
            cli.indexOf('const HELP') + 1800,
        );
        const verbs = [
            ...new Set(
                [...help.matchAll(/^\s+stitch\s+([a-z-]+)/gm)].map(
                    (m) => m[1] as string,
                ),
            ),
        ].sort();
        checkSeq('CLI subcommands', verbs, [
            'diagram',
            'export',
            'from-curl',
            'init',
            'mcp',
            'run',
            'serve',
            'trace',
        ]);
        const scheduling = [
            'verify',
            'check',
            'canary',
            'schedule',
            'watch',
            'smoke',
        ].filter((v) => verbs.includes(v));
        checkSeq('…of which any run a verification', scheduling, []);

        const testing = readFileSync(
            new URL(
                '../../../../packages/core/src/testing.ts',
                import.meta.url,
            ),
            'utf8',
        );
        const verifiers = [
            ...new Set(
                [
                    ...testing.matchAll(
                        /export (?:async )?function (verify\w+)/g,
                    ),
                ].map((m) => m[1] as string),
            ),
        ].sort();
        checkSeq('the `verify*` family', verifiers, [
            'verifyAdapterContract',
            'verifyFingerprintContract',
            'verifySinkContract',
            'verifyStoreContract',
        ]);
        check(
            'any of them verifies a VENDOR rather than a plugin',
            verifiers.some((v) => /vendor|endpoint|api|live|upstream/i.test(v)),
            false,
        );
        note(
            "(f) → all four verifiers take an implementation of one of StitchAPI's OWN seams (Adapter / StitchStore / TraceSink / fingerprint) and check it against a fixed contract. They are for people writing plugins. There is no runner, no schedule, and no vendor-facing mode — exactly the split the capture predicted",
            '',
        );
    }

    heading('C6 (g) — so what does a parity check actually cost you?');
    {
        // The whole thing, written out: run the SAME endpoint against two targets and diff the
        // verdicts. It is short — because `extends` did the hard part — but every line is yours.
        const parity = async (
            live: Stitch,
            fake: Stitch,
            input: Record<string, unknown>,
        ): Promise<string> => {
            const [a, b] = await Promise.all([
                live.safe(input as never),
                fake.safe(input as never),
            ]);
            if (a.ok === b.ok) return 'AGREE';
            return `DISAGREE live=${a.ok ? 'ok' : (a.error?.message ?? 'err')} fake=${b.ok ? 'ok' : (b.error?.message ?? 'err')}`;
        };
        const live = stitch({
            ...ENDPOINT,
            extends: { baseUrl: PROD, adapter: vendorAdapter(VENDOR_TODAY) },
        } as never) as unknown as Stitch;
        const fake = stitch({
            ...ENDPOINT,
            extends: {
                baseUrl: PROD,
                adapter: vendorAdapter(RECORDED_2026_02_04),
            },
        } as never) as unknown as Stitch;
        const verdict = await parity(live, fake, { params: { id: 'inv_9f2' } });
        check(
            'the parity check catches the stale fixture',
            verdict,
            'DISAGREE live=contract violation (drift) fake=ok',
        );
        note(
            '(g) → 8 executable lines, and it is the ONLY thing in this whole scenario that detects the drift in C1(e). It needs a real call, so it cannot run in the offline suite — which is precisely why the missing half is the SCHEDULE, not the comparison',
            '',
        );
    }

    finish(
        'C6',
        'TARGETING YES, SCHEDULING NO. One endpoint object aimed at three targets via `extends: { baseUrl, adapter }` produced exactly the three URLs expected and three verdicts — fixture ok, sandbox ok, PROD `contract violation (drift)` — so the difference between environments IS visible, through the same `output` schema. A `seam` does the same for a whole client and a member may still override either slot; a `baseUrl` THUNK (`string | (() => string)`) is the one hatch that retargets between calls without rebuilding. `.with()` deliberately cannot: it is `Partial<StitchInput>` and `.with({ baseUrl })` is a compile error. What does NOT exist: any named environment concept — zero env/sandbox/environment/profile/variant/stage/mode slots on `StitchConfig`, and an unknown key is a compile error, so there is no informal extension either; and any scheduling or live-verification spelling — the 8 CLI subcommands are run/trace/serve/mcp/diagram/export/from-curl/init and none verifies anything, while the four `verify*Contract` functions all take an implementation of one of StitchAPI\'s OWN seams, not a vendor. The parity check that WOULD catch C1(e) is 8 executable lines and catches it exactly ("DISAGREE live=contract violation (drift) fake=ok") — but it needs a real call, so the missing piece is the schedule, not the comparison',
    );
}

void main();

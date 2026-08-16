// C8 — assemble the best available answer for "primary with a backup, classified correctly, one
// call on the happy path", run it, and price it against the same behaviour with no library.
//
// The construction is in `failover.ts`. Its shape is the finding: everything PER PROVIDER stays
// declared on the stitch (origin, path, auth, `retry` with its own `on`, `circuit`, `timeout`,
// `pick`) and costs nothing, while the ROUTING — try in order, classify before moving on, name the
// winner — is 30 counted lines of user code that no combinator contributes to.
//
// Two measurements make the trade concrete: the same behaviour hand-rolled against the same fake
// providers is 104 counted lines, so the library is carrying ~71% of it; and the 30 lines cannot be
// given back to the library, because a `Composable` is not user-authorable — `makeComposable` is
// unexported and the `__runWith` protocol is not on the public type. (e) measures a hand-branded
// node satisfying the TYPE gate and then crashing at runtime.
//
//   pnpm exec tsx docs/scenarios/proofs/provider-failover/c8-assembled.ts
import { type Composable, all, any } from '../../../../packages/core/src/pipe';
import type {
    StitchError,
    StitchInput,
} from '../../../../packages/core/src/types';
import { type Leg, failover } from './failover';
import { hits, outcomeOf } from './fake-provider';
import { handRolled } from './hand-rolled';
import { check, checkSeq, finish, heading, note } from './harness';
import { rig } from './providers';
import { recordingSink } from './trace-probe';
import { accepted, probeSpellings, rejected } from './type-probe';

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Count the CODE lines between the `<count:begin>` / `<count:end>` markers of a file. */
function countedLines(file: string): number {
    const src = readFileSync(join(HERE, file), 'utf8').split('\n');
    const from = src.findIndex((l) => l.includes('<count:begin>'));
    const to = src.findIndex((l) => l.includes('<count:end>'));
    return src
        .slice(from + 1, to)
        .filter(
            (l) =>
                l.trim() !== '' &&
                !l.trim().startsWith('//') &&
                !l.trim().startsWith('*') &&
                !l.trim().startsWith('/*'),
        ).length;
}

/** The assembled construction: per-provider config declared, routing supplied by `failover`. */
function assembled(trace?: ReturnType<typeof recordingSink>) {
    const r = rig({
        ...(trace ? { trace } : {}),
        each: {
            retry: { attempts: 2, on: [429, 503], backoff: { base: 100 } },
            circuit: { failures: 3, cooldown: '30s' },
            timeout: { each: '5s' },
        },
        onPrimary: { pick: 'choices.0.text' },
        onBackup: { pick: 'output' },
    });
    const legs: Leg<unknown>[] = [
        { name: 'primary', call: r.primary },
        { name: 'backup', call: r.backup },
    ];
    return { ...r, legs };
}

async function main(): Promise<void> {
    heading('C8 — the assembled answer, and what it costs');

    // ── (a) the happy path is ONE request, and it is attributed ────────────────────────────────
    {
        const { p, legs } = assembled();
        const served: string[] = [];
        for (let i = 0; i < 10; i++) {
            const r = await failover(legs, { body: { prompt: 'q' } });
            served.push(r.provider);
        }
        checkSeq('(a) 10 happy calls → [primary, backup]', hits(p), [10, 0]);
        checkSeq('(a) providers credited', [...new Set(served)], ['primary']);
        note(
            '(a) → against `any`’s [10, 10] on identical providers (C1a)',
            'the entire backup vendor bill is the difference between the two constructions',
        );
    }

    // ── (b) a 400 stops the chain with the actionable error ────────────────────────────────────
    {
        const { p, legs } = assembled();
        p.primary.respond(400);
        const err = (await failover(legs, { body: { prompt: null } }).then(
            () => undefined,
            (e: unknown) => e as StitchError,
        ))!;
        checkSeq('(b) 400 → [primary, backup]', hits(p), [1, 0]);
        check('(b) error name', err.name, 'StitchError');
        check('(b) error status', err.status, 400);
        check(
            '(b) error body.error.code',
            (err.body as { error: { code: string } }).error.code,
            'invalid_request',
        );
        check('(b) attempts (a 400 is not retried)', err.attempts, 1);
    }

    // ── (c) a 503 retries the primary, then fails over, and stays one trace ────────────────────
    // `retry.backoff.base` is 100 virtual ms, so the injected clock has to be driven.
    {
        const trace = recordingSink();
        const { clock, p, legs } = assembled(trace);
        p.primary.respond(503);
        const call = failover(legs, { body: { prompt: 'q' } });
        await clock.advance(1000);
        const r = await call;

        checkSeq('(c) 503 → [primary, backup]', hits(p), [2, 1]);
        check('(c) who served it', r.provider, 'backup');
        check('(c) normalised value', r.value, 'answer from backup');
        check('(c) distinct traceIds', trace.traceIds().length, 1);
        checkSeq('(c) trace spine', trace.spine(), [
            'primary<-<root>',
            'backup<-primary',
        ]);
        note(
            '(c) → the primary’s own `retry` ran first (2 requests), then the chain moved on',
            'per-member resilience and cross-member routing compose without either knowing about the other',
        );
    }

    // ── (d) both providers down: the LAST real error, not an aggregate ─────────────────────────
    {
        const { clock, p, legs } = assembled();
        p.primary.respond(500);
        p.backup.respond(503);
        const call = failover(legs, { body: {} });
        const settled = call.then(
            () => undefined,
            (e: unknown) => e as StitchError,
        );
        await clock.advance(2000);
        const err = (await settled)!;
        check('(d) error name', err.name, 'StitchError');
        check('(d) error status', err.status, 503);
        check(
            '(d) error body names the provider',
            (err.body as { provider: string }).provider,
            'backup',
        );
        note(
            '(d) → against `any`’s AggregateError with `status: undefined` (C3b)',
            'the caller keeps a routable status and the failing provider’s own body',
        );
    }

    // ── (e) the 30 lines cannot be given back to the library ───────────────────────────────────
    // A `Composable` is not user-authorable: `makeComposable` is unexported and `__runWith` is not
    // on the public type. Hand-branding satisfies the TYPE gate and then crashes at runtime.
    {
        const { primary } = rig();
        const fake = Object.assign(
            async (_input?: StitchInput) => 'hand-made',
            { __composable: true as const },
        ) as unknown as Composable<string>;
        const crash = await outcomeOf(() => all(primary, fake)({ body: {} }));
        check('(e) hand-branded node in `all` → outcome', crash, 'TypeError');

        const results = probeSpellings([
            {
                label: 'all(a, asyncFn)  — a plain function as a member',
                code: 'void pipe.all(a, async () => 1);',
            },
            {
                label: 'all(a, brandedFn) — hand-branded __composable',
                code: 'void pipe.all(a, Object.assign(async () => 1, { __composable: true as const }));',
            },
            {
                label: 'any(a, b) as a member of all',
                code: 'void pipe.all(a, pipe.any(a, b));',
            },
        ]);
        checkSeq('(e) spellings that COMPILE', accepted(results), [
            'all(a, brandedFn) — hand-branded __composable',
            'any(a, b) as a member of all',
        ]);
        check('(e) refused', rejected(results).length, 1);
        note(
            '(e) → the brand gate is `Member = { __stitch } | { __composable }` (pipe.ts:188-189)',
            'it checks the BRAND and not the `__runWith` protocol, so a hand-authored node type-checks and then throws — the composition vocabulary is closed, and a user-written failover node cannot join it',
        );
    }

    // ── (f) the price, in counted lines ────────────────────────────────────────────────────────
    {
        const assembledLines = countedLines('failover.ts');
        const handRolledLines = countedLines('hand-rolled.ts');
        check('(f) assembled: counted lines of ROUTING', assembledLines, 30);
        check(
            '(f) hand-rolled: counted lines, same features',
            handRolledLines,
            104,
        );
        check(
            '(f) share of the implementation the library carries (%)',
            Math.round((1 - assembledLines / handRolledLines) * 100),
            71,
        );

        // …and the two produce the same measured behaviour on the same fake providers.
        const hand = (() => {
            const r = rig();
            const call = handRolled(
                [
                    {
                        name: 'primary',
                        url: `${r.p.primary.origin}${r.p.primary.path}`,
                        method: 'POST',
                        headers: { authorization: 'Bearer pk-primary' },
                        adapter: r.p.primary.adapter(),
                        pick: (b) =>
                            (b as { choices: { text: string }[] }).choices[0]
                                ?.text,
                    },
                    {
                        name: 'backup',
                        url: `${r.p.backup.origin}${r.p.backup.path}`,
                        method: 'POST',
                        headers: { 'x-api-key': 'sk-backup' },
                        adapter: r.p.backup.adapter(),
                        pick: (b) => (b as { output: string }).output,
                    },
                ],
                {
                    clock: r.clock,
                    attempts: 2,
                    retryOn: [429, 503],
                    backoff: 100,
                    circuit: { failures: 3, cooldown: 30_000 },
                },
            );
            return { r, call };
        })();

        const happy = await hand.call({ prompt: 'q' });
        checkSeq(
            '(f) hand-rolled happy → [primary, backup]',
            hits(hand.r.p),
            [1, 0],
        );
        check('(f) hand-rolled happy: provider', happy.provider, 'primary');

        hand.r.p.primary.respond(503);
        const failing = hand.call({ prompt: 'q' });
        await hand.r.clock.advance(1000);
        const over = await failing;
        checkSeq(
            '(f) hand-rolled 503 → [primary, backup]',
            hits(hand.r.p),
            [3, 1],
        );
        check('(f) hand-rolled 503: provider', over.provider, 'backup');
        check('(f) hand-rolled 503: value', over.value, 'answer from backup');
        note(
            '(f) → identical routing behaviour, 30 lines against 104',
            'the library’s contribution is entirely PER MEMBER — auth, retry, breaker, timeout, normalisation, trace identity — and entirely absent from the routing between members',
        );
    }

    // ── (g) what the assembled answer still does not do ────────────────────────────────────────
    {
        const trace = recordingSink();
        const { legs } = assembled(trace);
        await failover(legs, { body: {} });
        check(
            '(g) events emitted by the failover itself',
            trace.records.filter(
                (r) => r.name !== 'primary' && r.name !== 'backup',
            ).length,
            0,
        );
        const { primary, backup } = rig();
        const node = any(primary, backup);
        check('(g) `any` is a node you can nest', node.__composable, true);
        note(
            '(g) → three gaps remain, all of them the same gap',
            'the failover is not a NODE: no span of its own, not nestable in a combinator, not introspectable via `__config`, and not exportable to OpenAPI — the routing lives outside the object graph the library reasons about',
        );
    }

    finish(
        'C8',
        'ACHIEVABLE WITH 30 LINES OF USER CODE AT ONE SEAM. The assembled answer (`failover.ts`) leaves everything PER PROVIDER declared on the stitch — origin, path, auth strategy, `retry: { attempts: 2, on: [429, 503] }`, `circuit: [3, "30s"]`, `timeout.each`, `pick` — and supplies only the ROUTING over `linked`. Measured: 10 successful calls sent [10, 0], every one credited to the primary, against `any`’s [10, 10] on identical providers; a 400 stopped the chain at [1, 0] with a real `StitchError` status 400, `attempts: 1`, and the provider’s `invalid_request` body intact; a 503 retried the primary twice and then failed over, [2, 1], returning `{ provider: "backup", value: "answer from backup" }` — per-member resilience and cross-member routing composing without either knowing about the other — in ONE trace tree with the spine primary<-<root>, backup<-primary; and with both providers down the caller got the LAST real error (`StitchError` 503, body naming `backup`) rather than an `AggregateError` with `status: undefined`. The price is 30 counted lines against 104 for the same feature set hand-rolled on the same fake providers — the library carries ~71% (74 of the 104 lines), and all of it is PER MEMBER (auth, retry, breaker, timeout, normalisation, trace identity); its contribution to the routing BETWEEN members is zero. AND THE 30 LINES CANNOT BE GIVEN BACK: a `Composable` is not user-authorable, because `makeComposable` is unexported and `__runWith` is not on the public type, while the member gate `Member = { __stitch } | { __composable }` (pipe.ts:188-189) checks only the BRAND — so a hand-branded node COMPILES and then throws `TypeError` at runtime, measured. The failover is therefore not a node: no span of its own (0 events from the group), not nestable in a combinator, not introspectable, not exportable',
    );
}

void main();

// C7 — the best answer the public API supports, written, run, and compared against the hand-rolled
// `while` loop it replaces. The seam is `Surface.interpret` + `hooks.onRequest` (see
// `batch-retry-surface.ts`); the comparison is not "is it prettier" but "does it keep
// `timeout.total`, the circuit breaker and the trace that the hand-rolled loop loses" — measured,
// not assumed.
//
//   pnpm exec tsx docs/scenarios/proofs/batch-partial-failure/c7-assembled-solution.ts
import { stitch, systemClock } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import type {
    StitchEvent,
    TraceSink,
} from '../../../../packages/core/src/types';
import type { BatchLedger } from './batch-retry-surface';
import { batchRetry } from './batch-retry-surface';
import type { BatchItem } from './fake-batch';
import {
    FakeDynamo,
    dynamoBody,
    processedOf,
    unprocessedOf,
} from './fake-batch';
import { check, checkAtMost, finish, heading, note } from './harness';

import { readFileSync } from 'node:fs';

const ENDPOINT = 'https://dynamodb.us-east-1.amazonaws.com/batch';
const SIX = ['a', 'b', 'c', 'd', 'e', 'f'];
const ids = (items: BatchItem[]): string => items.map((i) => i.id).join('');

/** The three readers the loop needs for a DynamoDB-shaped response. */
const dynamoReaders = {
    residueOf: unprocessedOf,
    landedOf: processedOf,
    bodyOf: (items: BatchItem[]) => ({ RequestItems: items }),
};

/** Count real lines of code in a file (or a `#region`), ignoring blanks and comment-only lines. */
function codeLines(file: string, region?: string): number {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    let lines = src.split('\n');
    if (region) {
        const from = lines.findIndex((l) => l.includes(`#region ${region}`));
        const to = lines.findIndex((l) => l.includes(`#endregion ${region}`));
        lines = lines.slice(from + 1, to);
    }
    return lines.filter((l) => {
        const t = l.trim();
        return (
            t !== '' &&
            !t.startsWith('//') &&
            !t.startsWith('*') &&
            !t.startsWith('/*')
        );
    }).length;
}

async function main(): Promise<void> {
    heading(
        'C7 — the assembled solution, measured against the hand-rolled loop',
    );

    // ── (a) it lands every item, once, with a wait that grows ─────────────────────────────────
    // The table is a real write-capacity bucket (2 units at t=0, refilling 1/s) — the case where
    // the wait IS the fix.
    {
        const clock = manualClock();
        const db = new FakeDynamo({ clock, writeUnitsPerSec: 1, burst: 2 });
        const batch = batchRetry<BatchItem>({
            ...dynamoReaders,
            rounds: 6,
            backoff: (round) => 1000 * 2 ** (round - 1),
        });
        const call = stitch({
            url: ENDPOINT,
            method: 'POST',
            kind: batch.kind,
            hooks: batch.hooks,
            adapter: db.adapter(),
            clock,
            retry: { attempts: 6 },
        });
        const p = call.safe({ body: dynamoBody(SIX) });
        await clock.advance(600_000);
        const r = await p;
        const out = r.data as BatchLedger<BatchItem>;

        check('(a) rounds fired', db.requests.length, 4);
        check(
            '(a) what each round SENT',
            db.requests.map((q) => q.ids.join('')).join(' → '),
            'abcdef → cdef → def → f',
        );
        check(
            '(a) arrival times (ms)',
            db.requests.map((q) => q.at).join(','),
            '0,1000,3000,7000',
        );
        check('(a) DUPLICATE WRITES', db.duplicateWrites, 0);
        check('(a) every item landed', db.landed.join(''), 'abcdef');
        check('(a) call ok', r.ok, true);
        check('(a) ledger.landed', ids(out.landed), 'abcdef');
        check('(a) ledger.residue', ids(out.residue), '');
        check('(a) ledger.gaveUp', out.gaveUp, false);
    }

    // ── (a2) it survives a round that lands NOTHING — the case `paginate` cannot ───────────────
    // Same table, a curve that starts below the refill period. Rounds 2-4 land zero items; the
    // loop keeps going instead of terminating successfully with the batch half-written (C2d).
    {
        const clock = manualClock();
        const db = new FakeDynamo({ clock, writeUnitsPerSec: 1, burst: 2 });
        const batch = batchRetry<BatchItem>({
            ...dynamoReaders,
            rounds: 8,
            backoff: (round) => 100 * 2 ** (round - 1),
        });
        const call = stitch({
            url: ENDPOINT,
            method: 'POST',
            kind: batch.kind,
            hooks: batch.hooks,
            adapter: db.adapter(),
            clock,
            retry: { attempts: 8 },
        });
        const p = call.safe({ body: dynamoBody(SIX) });
        await clock.advance(600_000);
        const r = await p;
        const out = r.data as BatchLedger<BatchItem>;
        check(
            '(a2) rounds that landed nothing',
            db.requests.filter((q) => q.accepted.length === 0).length,
            3,
        );
        check('(a2) every item still landed', db.landed.join(''), 'abcdef');
        check('(a2) DUPLICATE WRITES', db.duplicateWrites, 0);
        check('(a2) ledger.gaveUp', out.gaveUp, false);
    }

    // ── (b) when it runs out of rounds, the RESIDUE IS THE RESULT ─────────────────────────────
    // The answer to C6 on this seam: the caller gets the items that never landed, in the payload,
    // without holding a closure of their own.
    {
        const clock = manualClock();
        const db = new FakeDynamo({ clock, accepts: 1 });
        const batch = batchRetry<BatchItem>({
            ...dynamoReaders,
            rounds: 3,
            backoff: () => 1000,
        });
        const call = stitch({
            url: ENDPOINT,
            method: 'POST',
            kind: batch.kind,
            hooks: batch.hooks,
            adapter: db.adapter(),
            clock,
            retry: { attempts: 3 },
        });
        const p = call.safe({ body: dynamoBody(SIX) });
        await clock.advance(600_000);
        const r = await p;
        const out = r.data as BatchLedger<BatchItem>;

        check('(b) rounds fired', db.requests.length, 3);
        check('(b) call ok', r.ok, true);
        check('(b) ledger.landed', ids(out.landed), 'abc');
        check(
            '(b) ledger.residue — THE ITEMS THAT NEVER LANDED',
            ids(out.residue),
            'def',
        );
        check('(b) ledger.gaveUp', out.gaveUp, true);
        check(
            '(b) it matches what the provider never saw',
            ids(out.residue),
            SIX.filter((id) => db.writeCount(id) === 0).join(''),
        );
    }

    // ── (c) what the engine still sees: attempts, retry events, trace ─────────────────────────
    {
        const clock = manualClock();
        const db = new FakeDynamo({ clock, accepts: 2 });
        const traced: StitchEvent[] = [];
        const sink: TraceSink = {
            handle: (e) => {
                traced.push(e);
            },
        };
        const batch = batchRetry<BatchItem>({
            ...dynamoReaders,
            rounds: 4,
            backoff: () => 500,
        });
        const call = stitch({
            url: ENDPOINT,
            method: 'POST',
            kind: batch.kind,
            hooks: batch.hooks,
            adapter: db.adapter(),
            clock,
            trace: sink,
            retry: { attempts: 4 },
        });
        const evts: StitchEvent[] = [];
        const consume = (async (): Promise<void> => {
            for await (const e of call.stream({ body: dynamoBody(SIX) }))
                evts.push(e);
        })();
        await clock.advance(600_000);
        await consume;

        const result = evts.find((e) => e.type === 'result');
        check('(c) rounds fired', db.requests.length, 3);
        check(
            '(c) `start` events (one logical call)',
            evts.filter((e) => e.type === 'start').length,
            1,
        );
        check(
            '(c) attempts on the result',
            result && 'attempts' in result ? result.attempts : undefined,
            3,
        );
        check(
            '(c) `retry` progress events',
            evts.filter((e) => e.type === 'progress' && e.phase === 'retry')
                .length,
            2,
        );
        check('(c) trace saw the same run', traced.length, evts.length);
        note(
            '(c) retry details in the trace',
            evts
                .filter((e) => e.type === 'progress' && e.phase === 'retry')
                .map((e) => ('detail' in e ? e.detail : ''))
                .join(' | '),
        );
    }

    // ── (c2) the circuit breaker still sees a broken host ──────────────────────────────────────
    // `interpret` composes `verdictOf` first, so a 500 is a transport failure, not a batch
    // envelope: two failed calls open the breaker and the third never reaches the network.
    {
        const clock = manualClock();
        let hits = 0;
        const batch = batchRetry<BatchItem>({
            ...dynamoReaders,
            rounds: 1,
            backoff: () => 0,
        });
        const call = stitch({
            url: ENDPOINT,
            method: 'POST',
            kind: batch.kind,
            hooks: batch.hooks,
            adapter: async () => {
                hits++;
                return { status: 500, headers: {}, body: { message: 'boom' } };
            },
            clock,
            circuit: { failures: 2, cooldown: 30_000 },
        });
        const a = await call.safe({ body: dynamoBody(SIX) });
        const b = await call.safe({ body: dynamoBody(SIX) });
        const c = await call.safe({ body: dynamoBody(SIX) });
        check('(c2) requests that reached the host', hits, 2);
        check(
            '(c2) first two failures',
            `${a.error?.message}/${b.error?.message}`,
            'HTTP 500/HTTP 500',
        );
        check(
            '(c2) third call short-circuited',
            c.error?.message,
            'circuit open',
        );
    }

    // ── (d) `timeout.total` — the ONE wall-clock measurement in this suite ─────────────────────
    // `timeout.total` is deliberately not driven by the injected clock (engine.ts:482), so this
    // runs on real timers. Bounds are 4× clear of the real numbers.
    {
        const slowAdapter = (perRound: number) => {
            const db = new FakeDynamo({ clock: systemClock, accepts: 1 });
            const inner = db.adapter();
            return {
                db,
                adapter: async (req: Parameters<typeof inner>[0]) => {
                    await new Promise((r) => setTimeout(r, perRound));
                    return inner(req);
                },
            };
        };

        // The assembled solution: one logical call, so `timeout.total` bounds the WHOLE loop.
        const s = slowAdapter(40);
        const batch = batchRetry<BatchItem>({
            ...dynamoReaders,
            rounds: 6,
            backoff: () => 10,
        });
        const call = stitch({
            url: ENDPOINT,
            method: 'POST',
            kind: batch.kind,
            hooks: batch.hooks,
            adapter: s.adapter,
            timeout: { total: 100 },
            retry: { attempts: 6 },
        });
        const t0 = Date.now();
        const r = await call.safe({ body: dynamoBody(SIX) });
        const elapsed = Date.now() - t0;
        check('(d) call ok', r.ok, false);
        checkAtMost(
            '(d) rounds it managed before the deadline (6 needed)',
            s.db.requests.length,
            4,
        );
        checkAtMost('(d) elapsed ms (budget was 100)', elapsed, 400);
        note('(d) error', r.error?.message);
    }

    // ── (e) the hand-rolled `while` loop, for comparison ───────────────────────────────────────
    {
        // #region handrolled
        const runHandRolled = async (
            call: ReturnType<typeof stitch>,
            body: { RequestItems: BatchItem[] },
            rounds: number,
            wait: (round: number) => Promise<void>,
        ): Promise<BatchLedger<BatchItem>> => {
            const ledger: BatchLedger<BatchItem> = {
                landed: [],
                residue: body.RequestItems,
                terminal: [],
                rounds: 0,
                gaveUp: false,
            };
            while (ledger.residue.length > 0) {
                if (ledger.rounds > 0) await wait(ledger.rounds);
                const res = await call({
                    body: { RequestItems: ledger.residue },
                });
                ledger.rounds += 1;
                ledger.landed.push(...processedOf(res));
                ledger.residue = unprocessedOf(res);
                if (ledger.residue.length > 0 && ledger.rounds >= rounds) {
                    ledger.gaveUp = true;
                    break;
                }
            }
            return ledger;
        };
        // #endregion handrolled

        const clock = manualClock();
        const db = new FakeDynamo({ clock, accepts: 2 });
        const traced: StitchEvent[] = [];
        const call = stitch({
            url: ENDPOINT,
            method: 'POST',
            adapter: db.adapter(),
            clock,
            timeout: { total: 100 },
            trace: {
                handle: (e) => {
                    traced.push(e);
                },
            },
        });
        const p = runHandRolled(call, dynamoBody(SIX), 6, (round) =>
            clock.sleep(1000 * round),
        );
        await clock.advance(600_000);
        const out = await p;

        check('(e) rounds fired', db.requests.length, 3);
        check('(e) DUPLICATE WRITES', db.duplicateWrites, 0);
        check('(e) every item landed', ids(out.landed), 'abcdef');
        check('(e) residue', ids(out.residue), '');
        // What it loses: the engine sees three unrelated calls, not one operation that retried.
        check(
            '(e) `start` events (one per round, not one per operation)',
            traced.filter((e) => e.type === 'start').length,
            3,
        );
        check(
            '(e) `retry` progress events',
            traced.filter((e) => e.type === 'progress' && e.phase === 'retry')
                .length,
            0,
        );
        check(
            '(e) attempts each call reported',
            traced.filter((e) => e.type === 'result' && e.attempts === 1)
                .length,
            3,
        );
        check(
            '(e) the 3s spent waiting between rounds, as the engine saw it',
            traced.filter(
                (e) => e.type === 'progress' && e.phase === 'throttled',
            ).length,
            0,
        );
        note(
            '(e) `timeout: { total: 100 }` bounds each ROUND here, never the loop',
            '',
        );
    }

    // ── (f) the cost of the ledger: it is per-STITCH, so concurrent calls corrupt it ──────────
    // The footgun that comes with this design, and it is the worst kind: two batches through one
    // stitch, both resolve SUCCESSFULLY, and two rows are never written by anybody.
    {
        const clock = manualClock();
        const db = new FakeDynamo({ clock, accepts: 1 });
        const batch = batchRetry<BatchItem>({
            ...dynamoReaders,
            rounds: 6,
            backoff: () => 100,
        });
        const call = stitch({
            url: ENDPOINT,
            method: 'POST',
            kind: batch.kind,
            hooks: batch.hooks,
            adapter: db.adapter(),
            clock,
            retry: { attempts: 6 },
        });
        const p = Promise.all([
            call.safe({ body: dynamoBody(['a', 'b', 'c']) }),
            call.safe({ body: dynamoBody(['x', 'y', 'z']) }),
        ]);
        await clock.advance(600_000);
        const [first, second] = await p;
        const l1 = first?.data as BatchLedger<BatchItem>;
        const l2 = second?.data as BatchLedger<BatchItem>;
        check(
            '(f) both calls resolved ok',
            `${first?.ok}/${second?.ok}`,
            'true/true',
        );
        check(
            '(f) neither reports giving up',
            `${l1.gaveUp}/${l2.gaveUp}`,
            'false/false',
        );
        check(
            '(f) neither reports a residue',
            `${ids(l1.residue)}/${ids(l2.residue)}`,
            '/',
        );
        check(
            '(f) items the two ledgers claim landed',
            `${ids(l1.landed)}/${ids(l2.landed)}`,
            'axyz/axyz',
        );
        check(
            '(f) items the provider really wrote',
            db.landed.sort().join(''),
            'axyz',
        );
        check(
            '(f) items SILENTLY LOST',
            ['a', 'b', 'c', 'x', 'y', 'z']
                .filter((id) => db.writeCount(id) === 0)
                .join(''),
            'bc',
        );
        note(
            '(f) what the shared ledger actually sent',
            db.requests.map((q) => q.ids.join('')).join(' → '),
        );
        note(
            '(f) → both callers were handed the OTHER batch’s items and told everything landed',
            '',
        );
    }

    // ── (g) size of each answer, in real lines of code ────────────────────────────────────────
    {
        const surfaceLines = codeLines('./batch-retry-surface.ts');
        const loopLines = codeLines('./batch-retry-surface.ts', 'loop');
        const handRolledLines = codeLines(
            './c7-assembled-solution.ts',
            'handrolled',
        );
        note('(g) the assembled solution, whole file', `${surfaceLines} lines`);
        note(
            '(g) …its loop alone, types and options excluded',
            `${loopLines} lines`,
        );
        note('(g) the hand-rolled while loop', `${handRolledLines} lines`);
        check(
            '(g) is the StitchAPI version smaller?',
            loopLines < handRolledLines,
            false,
        );
    }

    finish(
        'C7',
        'the loop IS assemblable on `Surface.interpret` + `hooks.onRequest` — 4 rounds, zero duplicate writes, an exponential wait, the residue handed back as DATA, and `attempts`/`retry` events/circuit/`timeout.total` all still working — but it is MORE user code than the hand-rolled `while` loop it replaces, and its ledger makes the stitch single-call-at-a-time',
    );
}

void main();

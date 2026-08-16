// C6 — DECIDING CLAIM. When the loop gives up — the `pages` cap is hit, or a round lands nothing —
// can the caller obtain THE RESIDUE: the actual items that never landed? Every channel the public
// API offers is asked in turn: the return value, the thrown error, `.inspect()`, `.report()`, the
// event stream, a trace sink, the `paginate.next` closure and the `hooks.onResponse` closure.
//
// This is the Logstash failure mode (elastic/logstash#1631, "rejected docs … silently lost").
//
//   pnpm exec tsx docs/scenarios/proofs/batch-partial-failure/c6-residue-reachability.ts
import { stitch } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import type {
    StitchEvent,
    TraceSink,
} from '../../../../packages/core/src/types';
import type { BatchItem } from './fake-batch';
import {
    FakeDynamo,
    dynamoBody,
    processedOf,
    unprocessedOf,
} from './fake-batch';
import { check, finish, heading, note } from './harness';

const URL = 'https://dynamodb.us-east-1.amazonaws.com/batch';
const SIX = ['a', 'b', 'c', 'd', 'e', 'f'];
const ids = (items: { id: string }[]): string =>
    items.map((i) => i.id).join('');

/**
 * One place all of C6's runs come from: a table that lands ONE item per request, a 3-page cap, and
 * every observation channel wired at once. After 3 rounds `d,e,f` have never been written —
 * that string is the answer every channel below is checked against.
 */
function cappedRun(): {
    call: ReturnType<typeof stitch>;
    db: FakeDynamo;
    clock: ReturnType<typeof manualClock>;
    seenByNext: BatchItem[][];
    seenByHook: BatchItem[][];
    traced: StitchEvent[];
} {
    const clock = manualClock();
    const db = new FakeDynamo({ clock, accepts: 1 });
    const seenByNext: BatchItem[][] = [];
    const seenByHook: BatchItem[][] = [];
    const traced: StitchEvent[] = [];
    const sink: TraceSink = {
        handle: (event) => {
            traced.push(event);
        },
    };
    const call = stitch({
        url: URL,
        method: 'POST',
        adapter: db.adapter(),
        clock,
        trace: sink,
        hooks: {
            onResponse: (ctx) => {
                seenByHook.push(unprocessedOf(ctx.res?.body));
            },
        },
        paginate: {
            next: (prevBody) => {
                const residue = unprocessedOf(prevBody);
                seenByNext.push(residue);
                return residue.length > 0
                    ? { body: { RequestItems: residue } }
                    : undefined;
            },
            items: (value) => processedOf(value),
            pages: 3,
        },
    });
    return { call, db, clock, seenByNext, seenByHook, traced };
}

async function main(): Promise<void> {
    heading('C6 — when the loop gives up, where is the residue?');

    // ── (a) the RETURN VALUE: a success, carrying only what landed ─────────────────────────────
    // `paginated` breaks out of the loop on `page >= max` and falls straight through to the
    // `result` event (engine.ts:984-1010). There is no "we stopped early" signal of any kind.
    // Each observation gets its OWN run: the ledgers below count invocations, and sharing one
    // stitch across probes would count them twice.
    {
        const { call, db } = cappedRun();
        const r = await call.safe({ body: dynamoBody(SIX) });

        check('(a) rounds fired (cap was 3)', db.requests.length, 3);
        check('(a) items that landed', db.landed.join(''), 'abc');
        check(
            '(a) items that never landed',
            SIX.filter((id) => db.writeCount(id) === 0).join(''),
            'def',
        );
        check('(a) call ok', r.ok, true);
        check('(a) error', r.error, null);
        check(
            '(a) data — the aggregated successes',
            ids(r.data as BatchItem[]),
            'abc',
        );
        check(
            '(a) does the result contain the residue anywhere?',
            JSON.stringify(r.data).includes('"d"'),
            false,
        );
    }

    // ── (b) the THROWN error: there is none — the bare call resolves ───────────────────────────
    {
        const { call } = cappedRun();
        const thrown = await call({ body: dynamoBody(SIX) }).then(
            () => 'resolved',
            (e: unknown) => `threw ${String(e)}`,
        );
        check('(b) awaiting the stitch directly', thrown, 'resolved');
    }

    // ── (e) the EVENT STREAM, and (f) a TRACE SINK fed by the same events ─────────────────────
    {
        const { call, traced } = cappedRun();
        const evts: StitchEvent[] = [];
        for await (const e of call.stream({ body: dynamoBody(SIX) }))
            evts.push(e);
        const paginateEvts = evts.filter(
            (e) => e.type === 'progress' && e.phase === 'paginate',
        );
        check('(e) `paginate` progress events', paginateEvts.length, 3);
        note(
            '(e) what the last one says',
            paginateEvts[2] && 'detail' in paginateEvts[2]
                ? paginateEvts[2].detail
                : '',
        );
        check(
            '(e) any event carrying an unprocessed item',
            evts.some((e) => JSON.stringify(e).includes('UnprocessedItems')),
            false,
        );
        check(
            '(e) the run ended with a `done` event that says ok',
            evts.some((e) => e.type === 'done' && e.ok),
            true,
        );
        check('(f) trace events captured', traced.length > 0, true);
        check(
            '(f) any traced event carrying the residue',
            traced.some((e) => JSON.stringify(e).includes('UnprocessedItems')),
            false,
        );
    }

    // ── (g) the `paginate.next` closure: it is STALE BY ONE ROUND ──────────────────────────────
    // `next` is called only when the loop is going to continue (engine.ts:984-986), so on the round
    // that hits the cap it never runs. A residue ledger built there is not merely incomplete — it
    // names `c`, which DID land.
    // ── (h) `hooks.onResponse` fires on every response, including the last ─────────────────────
    {
        const { call, db, seenByNext, seenByHook } = cappedRun();
        await call.safe({ body: dynamoBody(SIX) });
        const lastSeen = seenByNext[seenByNext.length - 1] ?? [];
        check('(g) times `next` ran for 3 rounds', seenByNext.length, 2);
        check(
            '(g) residue the `next` ledger would report',
            ids(lastSeen),
            'cdef',
        );
        check(
            '(g) …the TRUE residue',
            SIX.filter((id) => db.writeCount(id) === 0).join(''),
            'def',
        );
        check(
            '(g) items it wrongly reports as lost',
            ids(lastSeen.filter((i) => db.writeCount(i.id) > 0)),
            'c',
        );

        const lastHook = seenByHook[seenByHook.length - 1] ?? [];
        check('(h) times `onResponse` ran', seenByHook.length, 3);
        check('(h) residue the hook ledger reports', ids(lastHook), 'def');
    }

    // ── (c) `.inspect()` — the pre-validation body is the AGGREGATE, not the residue ───────────
    {
        const { call } = cappedRun();
        const seen = await call.inspect({ body: dynamoBody(SIX) });
        check('(c) inspect error', String(seen.error), 'null');
        check('(c) inspect raw', ids(seen.raw as BatchItem[]), 'abc');
        check(
            '(c) does `raw` carry the residue?',
            JSON.stringify(seen.raw).includes('"d"'),
            false,
        );
    }

    // ── (d) `.report()` — the run report, for a run that lost half the batch ───────────────────
    {
        const { call } = cappedRun();
        const rep = await call.report({ body: dynamoBody(SIX) });
        check('(d) report says the run failed?', rep.error !== null, false);
        check('(d) attempts reported', rep.attempts, 1);
        check(
            '(d) report mentions the residue',
            JSON.stringify(rep).includes('UnprocessedItems'),
            false,
        );
        note('(d) status on the report', rep.status);
    }

    // ── (i) `verdict.flag` cannot express "the residue must be empty" ──────────────────────────
    // `flag` fails a 200 whose flag is PRESENT and FALSY (surface.ts:174-191). `UnprocessedItems`
    // is an array: `[]` and `[{…}]` are both truthy, so the flag is inert either way.
    {
        const clock = manualClock();
        const db = new FakeDynamo({ clock, accepts: 1 });
        const call = stitch({
            url: URL,
            method: 'POST',
            adapter: db.adapter(),
            clock,
            verdict: { flag: 'UnprocessedItems' },
        });
        const r = await call.safe({ body: dynamoBody(SIX) });
        check(
            '(i) call with a non-empty residue and `verdict.flag`',
            r.ok,
            true,
        );
        check('(i) requests made', db.requests.length, 1);
    }

    // ── (j) the one channel that needs no closure: RECONSTRUCT it from the successes ───────────
    // The caller knows what it sent, and `items` hands back what landed. The set difference IS the
    // residue — as long as the items are identifiable and nothing reshaped the aggregate. It is a
    // recovery, not a report: the call still resolved successfully, so nothing prompts the check.
    {
        const { call, db } = cappedRun();
        const sent = SIX;
        const r = await call.safe({ body: dynamoBody(sent) });
        const landedIds = new Set((r.data as BatchItem[]).map((i) => i.id));
        const residue = sent.filter((id) => !landedIds.has(id));
        check(
            '(j) residue reconstructed by set difference',
            residue.join(''),
            'def',
        );
        check(
            '(j) …and it matches what the provider never saw',
            residue.join(''),
            SIX.filter((id) => db.writeCount(id) === 0).join(''),
        );
    }

    // ── (k) the one built-in that can at least make the loss LOUD: an `output` contract ────────
    // A contract on the aggregate — "I sent 6, I expect 6 back" — fails the call when the loop
    // stopped short. It reports THAT items were lost, never WHICH: the error carries the
    // aggregated successes, and the residue is still nowhere.
    {
        const clock = manualClock();
        const db = new FakeDynamo({ clock, accepts: 1 });
        const call = stitch({
            url: URL,
            method: 'POST',
            adapter: db.adapter(),
            clock,
            output: (v: unknown) => Array.isArray(v) && v.length === SIX.length,
            paginate: {
                next: (prevBody) => {
                    const residue = unprocessedOf(prevBody);
                    return residue.length > 0
                        ? { body: { RequestItems: residue } }
                        : undefined;
                },
                items: (value) => processedOf(value),
                pages: 3,
            },
        });
        const r = await call.safe({ body: dynamoBody(SIX) });
        check('(k) the call now FAILS', r.ok, false);
        check('(k) message', r.error?.message, 'contract violation (drift)');
        check(
            '(k) does the error carry the residue?',
            JSON.stringify(r.error?.body ?? null).includes('"d"'),
            false,
        );
        note(
            '(k) → loud, but it needs the caller to know the expected count up front',
            '',
        );
    }

    finish(
        'C6',
        'the residue is UNREACHABLE from every channel the engine owns: the call resolves ok with only the successes, there is no error, `.inspect()`/`.report()`/the event stream/a trace sink never carry it, and the `paginate.next` ledger is stale by one round (it reports `cdef` when the true residue is `def`). Only a user-held `hooks.onResponse` closure — or reconstructing the difference from the successes — recovers it; an `output` contract can make the loss loud but still cannot name the items',
    );
}

void main();

// C4 — can `paginate` express the poll loop? The research capture predicted it would fail
// immediately, because scenario 3 measured the loop breaking at `items.length === 0`
// (engine.ts:984) and a job-status body has no items array at all.
//
// That prediction is WRONG, and the way it is wrong is worse than a clean failure: with the default
// `items` a non-array body is wrapped as `[value]` (engine.ts:967-971), so `length` is 1 every
// round and the loop runs. It just cannot WAIT — and the natural `items` spelling makes it end the
// run SUCCESSFULLY, with an empty array, while the job is still running.
//
//   pnpm exec tsx docs/scenarios/proofs/async-job-polling/c4-paginate.ts
import { stitch } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import type { Clock, StitchEvent } from '../../../../packages/core/src/types';
import { FakeJobApi, resultUrlOf, stateOf } from './fake-jobs';
import { check, finish, heading, note } from './harness';

async function submitJob(api: FakeJobApi, clock: Clock): Promise<string> {
    const submit = stitch({
        url: FakeJobApi.submitUrl,
        method: 'POST',
        adapter: api.adapter(),
        clock,
    });
    await submit.safe({ body: {} });
    return api.jobIds.at(-1)!;
}

async function main(): Promise<void> {
    heading('C4 — can `paginate` express the poll loop?');

    // ── (a) it LOOPS — the capture's prediction is refuted ────────────────────────────────────
    // `next` returning `{}` re-requests the same URL; returning `undefined` stops. The default
    // `items` wraps the non-array status body as one item, so the `length === 0` break never fires.
    {
        const clock = manualClock();
        const api = new FakeJobApi({ clock, inProgressPolls: 3 });
        const id = await submitJob(api, clock);
        const poll = stitch({
            url: FakeJobApi.statusUrl(id),
            adapter: api.adapter(),
            clock,
            paginate: {
                next: (prev) =>
                    stateOf(prev) === 'InProgress' ? {} : undefined,
            },
        });
        const p = poll.safe();
        await clock.advance(3_600_000);
        const r = await p;

        check('(a) the call succeeded', r.ok, true);
        check('(a) polls made', api.polls(id).length, 4);
        check(
            '(a) the loop terminated on the terminal state',
            stateOf((r.data as unknown[])?.at(-1)),
            'JobComplete' as const,
        );
    }

    // ── (b) …at ZERO spacing. There is no wait knob on `paginate` at all ──────────────────────
    // Every poll lands at the same virtual instant: a job that takes an hour is hammered as fast as
    // the event loop allows. `delay` / `backoff` are not fields — the `@ts-expect-error`s are the
    // machine-checked half of the claim (a non-error there fails `tsc`).
    {
        const clock = manualClock();
        const api = new FakeJobApi({ clock, inProgressPolls: 3 });
        const id = await submitJob(api, clock);
        const poll = stitch({
            url: FakeJobApi.statusUrl(id),
            adapter: api.adapter(),
            clock,
            paginate: {
                next: (prev) =>
                    stateOf(prev) === 'InProgress' ? {} : undefined,
            },
        });
        const p = poll.safe();
        await clock.advance(3_600_000);
        await p;
        check('(b) gaps between polls (ms)', api.gaps(id).join(','), '0,0,0');

        stitch({
            url: FakeJobApi.statusUrl(id),
            adapter: api.adapter(),
            clock,
            paginate: {
                next: () => undefined,
                // @ts-expect-error — `PaginateOptions` is `{ next, items?, pages? }` (types.ts:1412).
                delay: 1000,
            },
        });
        stitch({
            url: FakeJobApi.statusUrl(id),
            adapter: api.adapter(),
            clock,
            paginate: {
                next: () => undefined,
                // @ts-expect-error — no backoff field either.
                backoff: { curve: 'expo' },
            },
        });
        note(
            '(b) `PaginateOptions`',
            '{ next, items?, pages? } — no delay, no backoff',
        );
    }

    // ── (b2) `throttle` is the only pacing the paginated path passes through ──────────────────
    // And it is a FIXED minimum spacing before each request, not a growing backoff: four polls
    // 30s apart, forever, whatever the job is doing.
    {
        const clock = manualClock();
        const api = new FakeJobApi({ clock, inProgressPolls: 3 });
        const id = await submitJob(api, clock);
        const paced = stitch({
            url: FakeJobApi.statusUrl(id),
            adapter: api.adapter(),
            clock,
            throttle: { rate: '1/30s' },
            paginate: {
                next: (prev) =>
                    stateOf(prev) === 'InProgress' ? {} : undefined,
            },
        });
        const p = paced.safe();
        await clock.advance(3_600_000);
        await p;
        check('(b2) polls made', api.polls(id).length, 4);
        check(
            '(b2) gaps under `throttle: "1/30s"` (ms)',
            api.gaps(id).join(','),
            '30000,30000,30000',
        );
    }

    // ── (c) the RESULT is every poll response, not the terminal one ───────────────────────────
    // `paginated` aggregates (engine.ts:1000-1010), so the value is an array of statuses and the
    // caller digs the last element out. `pick` cannot help — it runs per page, before aggregation.
    {
        const clock = manualClock();
        const api = new FakeJobApi({ clock, inProgressPolls: 2 });
        const id = await submitJob(api, clock);
        const poll = stitch({
            url: FakeJobApi.statusUrl(id),
            adapter: api.adapter(),
            clock,
            paginate: {
                next: (prev) =>
                    stateOf(prev) === 'InProgress' ? {} : undefined,
            },
        });
        const p = poll.safe();
        await clock.advance(3_600_000);
        const r = await p;
        check('(c) values aggregated', (r.data as unknown[]).length, 3);
        check(
            '(c) states in the value',
            (r.data as unknown[]).map((v) => stateOf(v)).join(','),
            'InProgress,InProgress,JobComplete',
        );
    }

    // ── (d) THE TRAP: the natural `items` spelling ends the run OK, with nothing ──────────────
    // A caller who wants the result rows writes `items` to pull them. An `InProgress` body has
    // none — so page 1 yields zero items, `paginated` breaks at engine.ts:984 BEFORE calling
    // `next`, and falls straight through to the `result` event. Success, empty array, one poll,
    // and the job is still running on the server.
    {
        const clock = manualClock();
        const api = new FakeJobApi({ clock, inProgressPolls: 3 });
        const id = await submitJob(api, clock);
        const poll = stitch({
            url: FakeJobApi.statusUrl(id),
            adapter: api.adapter(),
            clock,
            paginate: {
                items: (v) => {
                    const url = resultUrlOf(v);
                    return url === undefined ? [] : [url];
                },
                next: (prev) =>
                    stateOf(prev) === 'InProgress' ? {} : undefined,
            },
        });
        const evts: StitchEvent[] = [];
        const consume = (async (): Promise<void> => {
            for await (const e of poll.stream()) evts.push(e);
        })();
        await clock.advance(3_600_000);
        await consume;

        check('(d) polls made', api.polls(id).length, 1);
        check(
            '(d) the run ended ok',
            evts.find((e) => e.type === 'done')?.ok,
            true,
        );
        const result = evts.find((e) => e.type === 'result');
        check(
            '(d) the value handed back',
            JSON.stringify(
                result && 'data' in result ? result.data : undefined,
            ),
            '[]',
        );
        check(
            '(d) error events',
            evts.filter((e) => e.type === 'error').length,
            0,
        );
        check(
            '(d) drift findings',
            evts.filter((e) => e.type === 'drift').length,
            0,
        );
        check(
            '(d) times `next` was consulted',
            evts.filter((e) => e.type === 'progress' && e.phase === 'paginate')
                .length,
            1,
        );
        note(
            '(d) → the caller sees a successful call with an empty result; the job runs to completion unread',
            '',
        );
    }

    // ── (e) `next` cannot see the terminal FAILURE either ─────────────────────────────────────
    // It is handed the body, so `state: 'Failed'` is reachable — but the only thing it can do with
    // it is stop. A paginated run cannot turn an in-band failure into a failed call; the `Failed`
    // body is aggregated as a value and the run reports success.
    {
        const clock = manualClock();
        const api = new FakeJobApi({
            clock,
            inProgressPolls: 1,
            terminal: 'Failed',
        });
        const id = await submitJob(api, clock);
        const poll = stitch({
            url: FakeJobApi.statusUrl(id),
            adapter: api.adapter(),
            clock,
            paginate: {
                next: (prev) =>
                    stateOf(prev) === 'InProgress' ? {} : undefined,
            },
        });
        const p = poll.safe();
        await clock.advance(3_600_000);
        const r = await p;
        check('(e) the job FAILED, and the call reports', r.ok, true);
        check(
            '(e) …with the failure as a value',
            stateOf((r.data as unknown[]).at(-1)),
            'Failed' as const,
        );
    }

    finish(
        'C4',
        'REFUTED, and the refutation is worse than the prediction. `paginate` DOES loop over a job-status body — the default `items` wraps a non-array value as one item, so the `length === 0` break never fires and `next → undefined` terminates cleanly (4 polls). What it cannot do is WAIT: measured gaps 0,0,0, with no `delay`/`backoff` field on `PaginateOptions` and only `throttle`’s FIXED spacing available. And the natural `items` spelling — pull the result rows — makes page 1 yield zero items, breaking at engine.ts:984 BEFORE `next` is consulted: the run ends `ok`, `data: []`, ONE poll, no error and no drift, while the job is still running. `Failed` is aggregated as a value too, so a paginated poll cannot fail',
    );
}

void main();

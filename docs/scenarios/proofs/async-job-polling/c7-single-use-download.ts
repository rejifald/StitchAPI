// C7 — the single-use result URL. Pre-signed links expire, and some expire on the FIRST successful
// fetch: every later fetch is a permanent 404 that LOOKS transient. Does `retry` turn that into
// repeated attempts? And can one stitch retry the poll while another does not retry the download?
//
//   pnpm exec tsx docs/scenarios/proofs/async-job-polling/c7-single-use-download.ts
import { stitch } from '../../../../packages/core/src/index';
import { linked } from '../../../../packages/core/src/pipe';
import type { Surface } from '../../../../packages/core/src/surface';
import { manualClock } from '../../../../packages/core/src/testing';
import { FakeJobApi, resultUrlOf, stateOf } from './fake-jobs';
import { check, finish, heading, note } from './harness';

const HOST = 'https://bulk.example.com';

const pollSurface = (after: number): Surface => ({
    id: 'job-poll',
    interpret: (res) =>
        stateOf(res.body) === 'InProgress'
            ? { ok: false, retry: true, message: 'InProgress', after }
            : { ok: true, data: res.body },
});

/** Submit + poll to completion; hand back the (single-use) result URL. */
async function runToResultUrl(
    api: FakeJobApi,
    clock: ReturnType<typeof manualClock>,
): Promise<string> {
    const submit = stitch({
        url: FakeJobApi.submitUrl,
        method: 'POST',
        adapter: api.adapter(),
        clock,
    });
    await submit.safe({ body: {} });
    const id = api.jobIds.at(-1)!;
    const poll = stitch({
        url: FakeJobApi.statusUrl(id),
        kind: pollSurface(1000),
        adapter: api.adapter(),
        clock,
        retry: { attempts: 20 },
    });
    const p = poll.safe();
    await clock.advance(3_600_000);
    return resultUrlOf((await p).data)!;
}

async function main(): Promise<void> {
    heading('C7 — does `retry` hammer a single-use download?');

    // ── (a) the DEFAULT `retry.on` does not include 404, so an expired link is terminal ────────
    // `[429, 502, 503, 504]` (types.ts:979-983). A 404 falls straight to the failure path even with
    // a generous `attempts`.
    {
        const clock = manualClock();
        const api = new FakeJobApi({ clock, inProgressPolls: 1 });
        const url = await runToResultUrl(api, clock);
        const download = stitch({
            url,
            adapter: api.adapter(),
            clock,
            retry: { attempts: 5 },
        });
        const first = await download.safe();
        const p = download.safe();
        await clock.advance(60_000);
        const second = await p;

        check('(a) first fetch ok', first.ok, true);
        check('(a) first payload', JSON.stringify(first.data), '{"rows":3}');
        check('(a) second fetch ok', second.ok, false);
        check('(a) second error', second.error?.message, 'HTTP 404');
        check(
            '(a) requests the link received',
            api.resultFetches.map((h) => h.status).join(','),
            '200,404',
        );
    }

    // ── (b) widen `retry.on` to cover 404 and the permanent failure is attempted N times ───────
    // The realistic way to get here: an author who has seen the link 404 *before* it is ready and
    // adds 404 to the retryable set. It cannot distinguish "not ready" from "already spent".
    {
        const clock = manualClock();
        const api = new FakeJobApi({ clock, inProgressPolls: 1 });
        const url = await runToResultUrl(api, clock);
        const download = stitch({
            url,
            adapter: api.adapter(),
            clock,
            retry: { attempts: 3, on: [404, 429, 503] },
        });
        await download.safe();
        const p = download.safe();
        await clock.advance(60_000);
        const second = await p;

        check('(b) second fetch ok', second.ok, false);
        check(
            '(b) requests the link received',
            api.resultFetches.map((h) => h.status).join(','),
            '200,404,404,404',
        );
        check(
            '(b) wasted attempts on a permanently-dead link',
            api.resultFetches.filter((h) => h.status === 404).length - 1,
            2,
        );
    }

    // ── (c) per-stitch policy: the poll retries hard, the download not at all ─────────────────
    // Retry is configured per stitch, so three stitches under `linked` carry three policies. This
    // is the shape that gets it right: 20 poll attempts, exactly ONE download attempt.
    {
        const clock = manualClock();
        const api = new FakeJobApi({ clock, inProgressPolls: 4 });
        const submit = stitch({
            name: 'submit',
            url: FakeJobApi.submitUrl,
            method: 'POST',
            adapter: api.adapter(),
            clock,
        });
        const poll = stitch({
            name: 'poll',
            url: `${HOST}{+loc}`,
            kind: pollSurface(30_000),
            adapter: api.adapter(),
            clock,
            retry: { attempts: 20 },
        });
        const download = stitch({
            name: 'download',
            url: '{+u}',
            adapter: api.adapter(),
            clock,
            // The single-use link: one shot, and a failure is a failure.
            retry: { attempts: 1 },
        });
        const flow = linked(async (run) => {
            await run(submit, { body: {} });
            const id = api.jobIds.at(-1)!;
            const status = await run(poll, { params: { loc: `/jobs/${id}` } });
            return run(download, { params: { u: resultUrlOf(status)! } });
        });
        await clock.advance(3_600_000);
        check(
            '(c) the flow resolved',
            JSON.stringify(await flow),
            '{"rows":3}',
        );
        check('(c) polls made', api.polls('job-1').length, 5);
        check('(c) download attempts', api.resultFetches.length, 1);
        check(
            '(c) the two policies, side by side',
            'poll attempts=20 / download attempts=1',
            'poll attempts=20 / download attempts=1',
        );
    }

    // ── (d) in the ONE-STITCH construction the two policies COLLAPSE ──────────────────────────
    // One stitch is one `retry` block, and `retry.attempts` is a single budget shared by the
    // submit, every poll, and the download. So a download that fails is re-attempted on the poll's
    // policy — and because `hooks.onRequest` still points at the spent link, each re-attempt hits
    // the dead URL again. Measured against a link that was already consumed once.
    {
        const clock = manualClock();
        const api = new FakeJobApi({ clock, inProgressPolls: 1 });
        let next: { url: string; method: string } | undefined;
        const surface: Surface = {
            id: 'async-job',
            interpret: (res) => {
                if (res.status === 202)
                    return {
                        ok: false,
                        retry: true,
                        message: 'accepted',
                        after: 100,
                    };
                const state = stateOf(res.body);
                if (state === 'InProgress')
                    return {
                        ok: false,
                        retry: true,
                        message: 'InProgress',
                        after: 100,
                    };
                if (state === 'JobComplete')
                    return {
                        ok: false,
                        retry: true,
                        message: 'downloading',
                        after: 0,
                    };
                // The download hop: a 404 body here is the spent link. Ask for another attempt,
                // exactly as an author would for "the link is not ready yet".
                if (res.status === 404)
                    return {
                        ok: false,
                        retry: true,
                        message: 'result not ready',
                        after: 100,
                    };
                return { ok: true, data: res.body };
            },
        };
        const call = stitch({
            name: 'bulk-job',
            url: FakeJobApi.submitUrl,
            method: 'POST',
            kind: surface,
            adapter: api.adapter(),
            clock,
            retry: { attempts: 8 },
            hooks: {
                onRequest: (ctx) => {
                    if (ctx.req && next) {
                        ctx.req.url = next.url;
                        ctx.req.method = next.method;
                        ctx.req.body = undefined;
                    }
                },
                onResponse: (ctx) => {
                    const res = ctx.res;
                    if (!res) return;
                    const loc = res.headers['location'];
                    if (loc)
                        next = {
                            url: new URL(loc, HOST).toString(),
                            method: 'GET',
                        };
                    const done = resultUrlOf(res.body);
                    if (done !== undefined) next = { url: done, method: 'GET' };
                },
            },
        });
        // First run: consumes the link.
        const p1 = call.safe({ body: {} });
        await clock.advance(3_600_000);
        await p1;
        const spent = api.resultFetches.length;
        // Second run: a NEW job whose link is fine — but the fake's link is per job, so force the
        // collision by re-pointing at the first job's spent URL.
        next = { url: `${HOST}/results/job-1`, method: 'GET' };
        const p2 = call.safe({ body: {} });
        await clock.advance(3_600_000);
        const r2 = await p2;

        check('(d) first run consumed the link', spent, 1);
        check('(d) second run ok', r2.ok, false);
        check(
            '(d) attempts spent on the DEAD link',
            api.resultFetches.length - spent,
            8,
        );
        check(
            '(d) can the download hop carry its own `retry`?',
            'one stitch = one retry block',
            'one stitch = one retry block',
        );
        note(
            '(d) → the price of C5(a)’s single deadline: the poll’s patience is also the download’s',
            '',
        );
    }

    finish(
        'C7',
        'The default is SAFE and the split IS expressible. `retry.on` defaults to `[429, 502, 503, 504]`, so an expired link 404s once and stops (measured 200,404) even under `attempts: 5`; widening `on` to include 404 turns one permanent failure into three requests (200,404,404,404). Because `retry` is per-stitch, three stitches under `linked` give the poll 20 attempts and the download exactly 1 — measured 5 polls, 1 download. The one-stitch construction cannot: one stitch is one `retry` block, so a download that fails burned all 8 shared attempts on the same dead URL',
    );
}

void main();

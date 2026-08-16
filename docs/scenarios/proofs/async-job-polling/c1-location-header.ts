// C1 — can the `Location` header on the `202` become the NEXT call's URL through a documented
// seam, or must the caller parse it by hand outside the library?
//
// The `202` body is empty by design (the fake mirrors Salesforce/Shopify here): the job id exists
// in exactly one place on the wire — a RESPONSE HEADER. So this walks every seam that could carry a
// header forward and measures which ones can even SEE it.
//
//   pnpm exec tsx docs/scenarios/proofs/async-job-polling/c1-location-header.ts
import { stitch } from '../../../../packages/core/src/index';
import type { Surface } from '../../../../packages/core/src/surface';
import { manualClock } from '../../../../packages/core/src/testing';
import type { AdapterResponse } from '../../../../packages/core/src/types';
import { FakeJobApi, stateOf } from './fake-jobs';
import { check, finish, heading, note } from './harness';

const HOST = 'https://bulk.example.com';

async function main(): Promise<void> {
    heading('C1 — can the `Location` header become the next call’s URL?');

    // ── (a) the 202 resolves SUCCESSFULLY, and the value carries nothing ───────────────────────
    // `classifyStatus` passes anything < 400 (surface.ts:143-149), so no `verdict.accept` is
    // needed — and the caller is handed `{}`. Neither `.inspect().raw` nor `.report()` exposes
    // response headers, so from the awaited API the job id does not exist.
    {
        const clock = manualClock();
        const api = new FakeJobApi({ clock });
        const submit = stitch({
            url: FakeJobApi.submitUrl,
            method: 'POST',
            adapter: api.adapter(),
            clock,
        });
        const r = await submit.safe({ body: { q: 'SELECT Id FROM Account' } });
        check('(a) a 202 resolves ok', r.ok, true);
        check('(a) the value handed back', JSON.stringify(r.data), '{}');
        const insp = await submit.inspect({ body: {} });
        check('(a) `.inspect().raw`', JSON.stringify(insp.raw), '{}');
        const rep = await submit.report({ body: {} });
        check(
            '(a) does any public result surface expose headers?',
            [...Object.keys(rep), ...Object.keys(insp)].some((k) =>
                k.toLowerCase().includes('header'),
            ),
            false,
        );
        note('(a) `.report()` keys', Object.keys(rep).join(', '));
        // Three, because `.inspect()` and `.report()` are FRESH network probes (types.ts:1841,
        // 1856) — each one submitted another job. On this endpoint a diagnostic probe is a write.
        check('(a) jobs the server minted', api.jobIds.length, 3);
        note(
            '(a) → the id is on the wire and unreachable from `data` / `raw` / `report`',
            '',
        );
    }

    // ── (b) `paginate.next` is handed the BODY, never the response ────────────────────────────
    // `(prevBody, pagesFetched)` — types.ts:1417. The loop that looks most like "follow the next
    // URL" is structurally blind to headers.
    {
        const clock = manualClock();
        const api = new FakeJobApi({ clock });
        stitch({
            url: FakeJobApi.submitUrl,
            method: 'POST',
            adapter: api.adapter(),
            clock,
            paginate: {
                // @ts-expect-error — `next` takes (prevBody, pagesFetched); there is no response
                // (and so no headers) argument.
                next: (_prev: unknown, _pages: number, _res: AdapterResponse) =>
                    undefined,
            },
        });
        note('(b) `PaginateOptions.next`', '(prevBody, pagesFetched) => input');
    }

    // ── (c) `transform` is handed the BODY too ────────────────────────────────────────────────
    {
        const clock = manualClock();
        const api = new FakeJobApi({ clock });
        stitch({
            url: FakeJobApi.submitUrl,
            method: 'POST',
            adapter: api.adapter(),
            clock,
            // @ts-expect-error — `transform` takes (body); there is no response argument.
            transform: (body: unknown, _res: AdapterResponse) => body,
        });
        note('(c) `StitchConfig.transform`', '(body) => unknown');
    }

    // ── (d) `Surface.interpret` DOES see the whole response ───────────────────────────────────
    // `(res, cfg)` — surface.ts:61-64 — and `res.headers` is a plain record. So a surface can lift
    // `Location` into the VALUE, which is the first half of the hop.
    {
        const clock = manualClock();
        const api = new FakeJobApi({ clock });
        const lifting: Surface = {
            id: 'submit',
            interpret: (res) => ({
                ok: true,
                data: { location: res.headers['location'] },
            }),
        };
        const submit = stitch({
            url: FakeJobApi.submitUrl,
            method: 'POST',
            kind: lifting,
            adapter: api.adapter(),
            clock,
        });
        const r = await submit.safe({ body: {} });
        check(
            '(d) the value a lifting surface hands back',
            JSON.stringify(r.data),
            '{"location":"/jobs/job-1"}',
        );
    }

    // ── (e) `hooks` complete the hop INSIDE one stitch ────────────────────────────────────────
    // `onResponse` reads `res.headers.location` (engine.ts:703); `onRequest` runs on the
    // per-attempt clone before the transport (engine.ts:646-654), so assigning `ctx.req.url` and
    // `ctx.req.method` there redirects the NEXT attempt. Paired with a body-aware surface, one
    // stitch walks `POST /jobs` → `GET /jobs/{id}` with no user code between calls.
    {
        const clock = manualClock();
        const api = new FakeJobApi({ clock, inProgressPolls: 2 });
        let next: { url: string; method: string } | undefined;
        const hopping: Surface = {
            id: 'async-job',
            interpret: (res) =>
                res.status === 202 || stateOf(res.body) === 'InProgress'
                    ? {
                          ok: false,
                          retry: true,
                          message: 'not done',
                          after: 1000,
                      }
                    : { ok: true, data: res.body },
        };
        const call = stitch({
            url: FakeJobApi.submitUrl,
            method: 'POST',
            kind: hopping,
            adapter: api.adapter(),
            clock,
            retry: { attempts: 6 },
            hooks: {
                onRequest: (ctx) => {
                    if (ctx.req && next) {
                        ctx.req.url = next.url;
                        ctx.req.method = next.method;
                        ctx.req.body = undefined;
                    }
                },
                onResponse: (ctx) => {
                    const loc = ctx.res?.headers['location'];
                    if (loc)
                        next = {
                            url: new URL(loc, HOST).toString(),
                            method: 'GET',
                        };
                },
            },
        });
        const p = call.safe({ body: { q: 'SELECT Id' } });
        await clock.advance(3_600_000);
        const r = await p;

        check('(e) the call succeeded', r.ok, true);
        check(
            '(e) state reached',
            stateOf(r.data as unknown),
            'JobComplete' as const,
        );
        check(
            '(e) what the client actually requested',
            api.hits.map((h) => `${h.method} ${h.path}`).join(' → '),
            'POST /jobs → GET /jobs/job-1 → GET /jobs/job-1 → GET /jobs/job-1',
        );
        check('(e) SUBMITS (1 = the hop replaced the re-POST)', api.submits, 1);
    }

    // ── (f) across TWO stitches: the RFC 6570 `+` operator makes a path a URL ──────────────────
    // `url` is templated (util.ts `expandPath`), and `{+var}` is reserved expansion — slashes pass
    // through unencoded. So a `Location` carried in a plain variable becomes the poll stitch's URL
    // with no string concatenation.
    {
        const clock = manualClock();
        const api = new FakeJobApi({ clock, inProgressPolls: 0 });
        let location = '';
        const submit = stitch({
            url: FakeJobApi.submitUrl,
            method: 'POST',
            adapter: api.adapter(),
            clock,
            hooks: {
                onResponse: (ctx) => {
                    location = ctx.res?.headers['location'] ?? '';
                },
            },
        });
        const poll = stitch({
            url: `${HOST}{+loc}`,
            adapter: api.adapter(),
            clock,
        });
        await submit.safe({ body: {} });
        const r = await poll.safe({ params: { loc: location } });
        check('(f) the header value carried', location, '/jobs/job-1');
        check('(f) the poll hit', api.hits.at(-1)?.path, '/jobs/job-1');
        check('(f) it succeeded', r.ok, true);
        // Without `+`, the default operator percent-encodes the slashes into one path segment.
        const naive = stitch({
            url: `${HOST}/{loc}`,
            adapter: api.adapter(),
            clock,
        });
        await naive.safe({ params: { loc: location } });
        check(
            '(f) the SAME value under the default operator `{loc}`',
            api.hits.at(-1)?.path,
            '/%2Fjobs%2Fjob-1',
        );
        check('(f) …and that request 404s', api.hits.at(-1)?.status, 404);
    }

    // ── (g) the cost of (e): hook state lives on the STITCH, not the call ─────────────────────
    // `HookContext` is `{ name, attempt, req?, res?, error? }` (types.ts:1278-1284) — no run id, no
    // per-call slot. So the carried `Location` has to be a closure variable on the stitch, and two
    // concurrent calls through one stitch overwrite each other's.
    {
        const clock = manualClock();
        const api = new FakeJobApi({ clock, inProgressPolls: 2 });
        let next: { url: string; method: string } | undefined;
        const hopping: Surface = {
            id: 'async-job',
            interpret: (res) =>
                res.status === 202 || stateOf(res.body) === 'InProgress'
                    ? {
                          ok: false,
                          retry: true,
                          message: 'not done',
                          after: 1000,
                      }
                    : { ok: true, data: res.body },
        };
        const call = stitch({
            url: FakeJobApi.submitUrl,
            method: 'POST',
            kind: hopping,
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
                    const loc = ctx.res?.headers['location'];
                    if (loc)
                        next = {
                            url: new URL(loc, HOST).toString(),
                            method: 'GET',
                        };
                },
            },
        });
        const a = call.safe({ body: { q: 'A' } });
        const b = call.safe({ body: { q: 'B' } });
        await clock.advance(3_600_000);
        const [ra, rb] = await Promise.all([a, b]);

        check('(g) jobs submitted', api.submits, 2);
        check('(g) polls of job-1', api.polls('job-1').length, 0);
        check('(g) polls of job-2', api.polls('job-2').length, 4);
        check('(g) caller A resolved ok', ra.ok, true);
        check('(g) caller B resolved ok', rb.ok, true);
        check(
            '(g) both callers were handed the SAME job',
            (ra.data as { id?: string } | null)?.id ===
                (rb.data as { id?: string } | null)?.id,
            true,
        );
        note(
            '(g) → job-1 was submitted and never polled: it runs to completion server-side, unread',
            '',
        );
    }

    finish(
        'C1',
        'the `Location` header IS reachable — `Surface.interpret` and `hooks.onResponse` both receive the full `AdapterResponse`, and assigning `ctx.req.url`/`ctx.req.method` in `hooks.onRequest` makes the 202→poll hop happen inside ONE stitch (measured: POST /jobs → 3× GET /jobs/job-1, 1 submit). Nothing built-in follows it: `paginate.next` and `transform` are handed the BODY only, and no public result surface (`data`, `.inspect().raw`, `.report()`) exposes response headers. The hook seam costs concurrency safety — two calls through one stitch orphaned job-1 (0 polls) and both polled job-2',
    );
}

void main();

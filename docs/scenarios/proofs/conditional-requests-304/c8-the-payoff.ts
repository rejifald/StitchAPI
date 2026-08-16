// C8 — the payoff, measured rather than argued. Ten polls, three strategies, two worlds.
//
// The metric is `billed`: responses that would count against a rate limit. GitHub's rule is that a
// 304 answered from a correctly-authorized conditional request costs nothing against the primary
// limit, so `billed` counts every non-304 and nothing else. The second metric is STALENESS: how many
// of the ten polls handed the caller a version the server had already superseded — because a TTL
// cache buys its request savings with exactly that, and a table that reports only requests is
// flattering it.
//
// Two worlds, because one number hides the trade:
//   • QUIET  — nothing changes across the ten polls. This is what a polling loop does 99% of the time.
//   • CHANGE — the resource changes once, just before poll 6. This is the 1% the loop exists for.
//
// `cache.ttl` needs `clockStore(clock)`: the default `memoryStore` reads `Date.now()` and ignores the
// injected clock entirely (C5 case e), so a virtual hour expires nothing.
//
//   pnpm exec tsx docs/scenarios/proofs/conditional-requests-304/c8-the-payoff.ts
import { stitch } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import { clockStore } from './clock-store';
import { FakeEtagApi } from './fake-etag-api';
import { check, checkSeq, finish, heading, note } from './harness';
import { revalidating } from './revalidate';

const POLLS = 10;
/** The poll the resource changes on, in the CHANGE world. Polls are 1-indexed. */
const CHANGES_BEFORE = 6;
/** Virtual seconds between polls. */
const INTERVAL_MS = 60_000;

interface RunResult {
    /** Responses that would count against a rate limit. */
    billed: number;
    /** Requests that left the process. */
    requests: number;
    /** The version each of the ten polls handed the caller. */
    versions: (number | null)[];
    /** Polls that served a version the server had already superseded. */
    stale: number;
}

type Strategy = 'none' | 'ttl' | 'revalidate';

async function run(strategy: Strategy, changes: boolean): Promise<RunResult> {
    const clock = manualClock();
    const api = new FakeEtagApi({ clock });
    const issues =
        strategy === 'none'
            ? stitch({ url: api.url, adapter: api.adapter(), clock })
            : strategy === 'ttl'
              ? stitch({
                    url: api.url,
                    adapter: api.adapter(),
                    clock,
                    store: clockStore(clock),
                    // Long enough to cover the whole run — the configuration a team reaches for
                    // when the goal is "stop hammering the API".
                    cache: { ttl: '30m', tenancy: 'app' },
                })
              : stitch({
                    url: api.url,
                    kind: revalidating({ transport: api.adapter() }),
                    clock,
                });

    const versions: (number | null)[] = [];
    let stale = 0;
    for (let poll = 1; poll <= POLLS; poll++) {
        if (changes && poll === CHANGES_BEFORE) api.mutate();
        const r = await issues.safe({});
        const got =
            (r.data as { version?: number } | undefined)?.version ?? null;
        versions.push(got);
        // `api.body(...).version` is the server's CURRENT truth at this instant.
        if (got !== api.body('(none)').version) stale++;
        await clock.advance(INTERVAL_MS);
    }
    return { billed: api.billed, requests: api.requests, versions, stale };
}

const row = (label: string, r: RunResult): void => {
    note(
        `  ${label.padEnd(24)}`,
        `billed ${String(r.billed).padStart(2)}/${String(POLLS)}   requests ${String(r.requests).padStart(2)}   stale ${String(r.stale)}   versions ${JSON.stringify(r.versions)}`,
    );
};

async function main(): Promise<void> {
    heading('C8 — ten polls, three strategies, two worlds');

    // ── the QUIET world: nothing changes ──────────────────────────────────────────────────────
    heading('  QUIET — the resource never changes (the 99% case)');
    const quietNone = await run('none', false);
    const quietTtl = await run('ttl', false);
    const quietRev = await run('revalidate', false);
    row('no caching', quietNone);
    row('TTL cache (30m)', quietTtl);
    row('revalidation', quietRev);

    check('QUIET no-caching billed', quietNone.billed, 10);
    check('QUIET TTL billed', quietTtl.billed, 1);
    check('QUIET revalidation billed', quietRev.billed, 1);
    check('QUIET revalidation requests', quietRev.requests, 10);
    check('QUIET revalidation stale polls', quietRev.stale, 0);
    check('QUIET TTL stale polls', quietTtl.stale, 0);
    note(
        '  → in the quiet world TTL and revalidation cost the SAME',
        'both bill 1; the difference is that revalidation still asked, 9 times, for free',
    );

    // ── the CHANGE world: the resource moves once, before poll 6 ──────────────────────────────
    heading(
        '  CHANGE — the resource changes once, before poll 6 (the 1% the loop exists for)',
    );
    const changeNone = await run('none', true);
    const changeTtl = await run('ttl', true);
    const changeRev = await run('revalidate', true);
    row('no caching', changeNone);
    row('TTL cache (30m)', changeTtl);
    row('revalidation', changeRev);

    check('CHANGE no-caching billed', changeNone.billed, 10);
    check('CHANGE no-caching stale polls', changeNone.stale, 0);
    check('CHANGE TTL billed', changeTtl.billed, 1);
    check('CHANGE TTL stale polls', changeTtl.stale, 5);
    checkSeq(
        'CHANGE TTL versions',
        changeTtl.versions,
        [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    );
    check('CHANGE revalidation billed', changeRev.billed, 2);
    check('CHANGE revalidation stale polls', changeRev.stale, 0);
    checkSeq(
        'CHANGE revalidation versions',
        changeRev.versions,
        [1, 1, 1, 1, 1, 2, 2, 2, 2, 2],
    );
    note(
        '  → this is what a TTL cache costs',
        'the same 1 billed response, and it NEVER SAW the change: 5 of 10 polls served version 1',
    );

    // ── the SAVING, stated the way a rate-limit budget states it ──────────────────────────────
    {
        const saved = changeNone.billed - changeRev.billed;
        check('rate-limit responses saved by revalidation', saved, 8);
        note(
            '  → 8 of 10 polls became free, with zero staleness',
            'at GitHub’s 5,000/hour primary limit, a 1-minute poll of 50 resources goes from 3,000/h to 600/h',
        );
    }

    // ── the LOAD-BALANCER INODE CASE: revalidation that silently does nothing ─────────────────
    // Apache's default `FileETag` embeds the inode, so two servers behind a balancer mint different
    // validators for byte-identical content and `If-None-Match` never matches. The client is correct,
    // the config is correct, and the feature is worth exactly nothing — with no error to notice.
    {
        const clock = manualClock();
        const api = new FakeEtagApi({ clock, inodeEtags: true });
        const kind = revalidating({ transport: api.adapter() });
        const issues = stitch({ url: api.url, kind, clock });
        for (let i = 0; i < POLLS; i++) {
            await issues.safe({});
            await clock.advance(INTERVAL_MS);
        }
        check('INODE billed', api.billed, 10);
        check('INODE requests', api.requests, 10);
        check('INODE 304s', api.notModified, 0);
        check(
            'INODE revalidated (the surface’s own counter)',
            kind.stats.revalidated,
            0,
        );
        check('INODE stored', kind.stats.stored, 10);
        note(
            '  → 10 validators sent, 10 full responses back, no error anywhere',
            '`stats.revalidated === 0` while `stats.stored === 10` is the shape of this failure — assert on it',
        );
    }

    // ── the SERVER WITH NO ETAG AT ALL — the other silent nothing ─────────────────────────────
    {
        const clock = manualClock();
        const api = new FakeEtagApi({ clock });
        const noEtag = async (
            req: Parameters<ReturnType<FakeEtagApi['adapter']>>[0],
        ): ReturnType<ReturnType<FakeEtagApi['adapter']>> => {
            const res = await api.adapter()(req);
            const { etag: _dropped, ...rest } = res.headers;
            return { ...res, headers: rest };
        };
        const kind = revalidating({ transport: noEtag });
        const issues = stitch({ url: api.url, kind, clock });
        for (let i = 0; i < 3; i++) await issues.safe({});
        check('NO-ETAG billed', api.billed, 3);
        check('NO-ETAG stored', kind.stats.stored, 0);
        check('NO-ETAG unvalidatable', kind.stats.unvalidatable, 3);
        note(
            '  → distinguishable from the inode case, and from working',
            '`stats.unvalidatable` counts 200s the server refused to give a validator for',
        );
    }

    finish(
        'C8',
        'MEASURED, and the TTL row is the one worth reading twice. Ten polls at one-minute virtual intervals. QUIET world (nothing changes): no caching bills 10/10; a 30-minute TTL cache bills 1/10; revalidation bills 1/10 while still making all 10 requests — so in the case a poller spends 99% of its time in, TTL and revalidation cost the SAME. CHANGE world (the resource moves once, before poll 6): no caching bills 10/10 and is never stale; revalidation bills 2/10 and is never stale, versions `[1,1,1,1,1,2,2,2,2,2]` — the change picked up on the very poll it happened; the TTL cache bills 1/10 and NEVER SEES THE CHANGE — versions `[1,1,1,1,1,1,1,1,1,1]`, 5 of 10 polls serving a superseded version. That is what the extra billed response buys, and it is the whole argument: 8 of 10 polls became free with ZERO staleness. Two silent-failure modes are measured alongside, because both look exactly like success: the load-balancer INODE case (a server minting a fresh validator per response) polls 10 times, bills 10, gets 0 304s and raises nothing — detectable only as `stats.revalidated === 0` while `stats.stored === 10`; and a server that sends no `ETag` at all bills 3/3 with `stats.stored === 0` and `stats.unvalidatable === 3`. Both are worth an assertion in a real deployment, because neither will ever produce an error',
    );
}

void main();

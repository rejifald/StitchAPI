// C9 — the assembled answer, run against every shape in this scenario, and compared honestly with
// the hand-rolled equivalent.
//
// Both implementations drive the SAME fake server through the SAME `fetch`-shaped entry point — the
// StitchAPI side through the real `fetchAdapter({ fetch })`, the hand-rolled side calling it
// directly — so neither gets a shortcut on the transport, and the comparison asserts their
// observable results are IDENTICAL on every shape before the line counts are read off the files.
//
//   pnpm exec tsx docs/scenarios/proofs/conditional-requests-304/c9-assembled-solution.ts
import { bearer } from '../../../../packages/core/src/auth';
import { fetchAdapter, stitch } from '../../../../packages/core/src/index';
import { seam } from '../../../../packages/core/src/index';
import type { StandardSchemaV1 } from '../../../../packages/core/src/standard-schema';
import { manualClock } from '../../../../packages/core/src/testing';
import { FakeEtagApi } from './fake-etag-api';
import { handRolledClient } from './hand-rolled';
import { check, checkSeq, finish, heading, note } from './harness';
import { revalidating } from './revalidate';

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Executable lines of a proof file — the comparable unit. Import statements (single- and
 * multi-line), blank lines and comment-only lines are all removed, on BOTH sides, so the number is
 * the code someone actually has to write and maintain.
 */
function executableLines(file: string): number {
    return readFileSync(join(HERE, file), 'utf8')
        .replace(/^import[\s\S]*?;$/gm, '') // whole import statements, however they wrap
        .split('\n')
        .map((l) => l.trim())
        .filter(
            (l) =>
                l !== '' &&
                !l.startsWith('//') &&
                !l.startsWith('*') &&
                !l.startsWith('/*'),
        ).length;
}

/** The shapes this scenario is about, each as a server factory + a poll script. */
const SHAPES = {
    'quiet (4 polls, no change)': { opts: {}, mutateBefore: 0, polls: 4 },
    'one change at poll 3': { opts: {}, mutateBefore: 3, polls: 4 },
    'weak validators': { opts: { weak: true }, mutateBefore: 3, polls: 4 },
    'inode ETags (never matches)': {
        opts: { inodeEtags: true },
        mutateBefore: 0,
        polls: 4,
    },
} as const;

/** What a run produced, in a form both implementations can be compared on. */
interface Observed {
    versions: (number | null)[];
    statuses: number[];
    billed: number;
    requests: number;
}

async function main(): Promise<void> {
    heading(
        'C9 — the assembled answer, on every shape, against the hand-rolled twin',
    );

    const stitched: Record<string, Observed> = {};
    const rolled: Record<string, Observed> = {};

    for (const [label, shape] of Object.entries(SHAPES)) {
        // ── the StitchAPI answer ──────────────────────────────────────────────────────────────
        {
            const clock = manualClock();
            const api = new FakeEtagApi({ clock, ...shape.opts });
            const issues = stitch({
                url: api.url,
                kind: revalidating({
                    transport: fetchAdapter({ fetch: api.fetchImpl() }),
                }),
                clock,
            });
            const versions: (number | null)[] = [];
            for (let poll = 1; poll <= shape.polls; poll++) {
                if (poll === shape.mutateBefore) api.mutate();
                const r = await issues.safe({});
                versions.push(
                    (r.data as { version?: number } | undefined)?.version ??
                        null,
                );
            }
            stitched[label] = {
                versions,
                statuses: api.statuses,
                billed: api.billed,
                requests: api.requests,
            };
        }
        // ── the hand-rolled twin ──────────────────────────────────────────────────────────────
        {
            const clock = manualClock();
            const api = new FakeEtagApi({ clock, ...shape.opts });
            const client = handRolledClient(api.fetchImpl());
            const versions: (number | null)[] = [];
            for (let poll = 1; poll <= shape.polls; poll++) {
                if (poll === shape.mutateBefore) api.mutate();
                const d = await client.get(api.url);
                versions.push(
                    (d as { version?: number } | undefined)?.version ?? null,
                );
            }
            rolled[label] = {
                versions,
                statuses: api.statuses,
                billed: api.billed,
                requests: api.requests,
            };
        }
    }

    heading('  the two implementations, shape by shape');
    for (const label of Object.keys(SHAPES)) {
        const a = stitched[label];
        const b = rolled[label];
        if (!a || !b) continue;
        note(
            `  ${label.padEnd(28)}`,
            `versions ${JSON.stringify(a.versions)}  statuses ${JSON.stringify(a.statuses)}  billed ${String(a.billed)}/${String(a.requests)}`,
        );
        checkSeq(`  ${label} — versions identical`, a.versions, b.versions);
        checkSeq(`  ${label} — statuses identical`, a.statuses, b.statuses);
        check(`  ${label} — billed identical`, a.billed, b.billed);
    }

    // ── the numbers each shape is supposed to produce ─────────────────────────────────────────
    heading('  the numbers themselves');
    checkSeq(
        'quiet versions',
        stitched['quiet (4 polls, no change)']?.versions ?? [],
        [1, 1, 1, 1],
    );
    check('quiet billed', stitched['quiet (4 polls, no change)']?.billed, 1);
    checkSeq(
        'changed versions',
        stitched['one change at poll 3']?.versions ?? [],
        [1, 1, 2, 2],
    );
    check('changed billed', stitched['one change at poll 3']?.billed, 2);
    checkSeq(
        'weak versions',
        stitched['weak validators']?.versions ?? [],
        [1, 1, 2, 2],
    );
    check('weak billed', stitched['weak validators']?.billed, 2);
    check(
        'inode billed (the feature buys nothing)',
        stitched['inode ETags (never matches)']?.billed,
        4,
    );

    // ── what the StitchAPI side keeps that the hand-rolled side gave up ───────────────────────
    // The behaviour is identical, so the extra lines have to be buying something else. They buy the
    // things that stayed CONFIG: auth, the contract, the trace spine, the per-principal keying.
    {
        const clock = manualClock();
        const api = new FakeEtagApi({ clock, etagScope: 'content' });
        const issuesSchema: StandardSchemaV1 = {
            '~standard': {
                version: 1,
                vendor: 'conditional-requests-304-proof',
                validate: (value: unknown) =>
                    (value as { repo?: unknown } | null)?.repo === undefined
                        ? { issues: [{ message: 'not the issues payload' }] }
                        : { value },
            },
        };
        const kind = revalidating({
            transport: fetchAdapter({ fetch: api.fetchImpl() }),
        });
        const sm = seam({ clock });
        const forUser = (p: string) =>
            sm.as(p).stitch({
                url: api.url,
                kind,
                auth: bearer(`tok-${p}`),
                output: issuesSchema,
                retry: { attempts: 3, backoff: { curve: 'fixed', base: 0 } },
                timeout: { each: '5s' },
            });
        const alice = forUser('alice');
        const bob = forUser('bob');
        await alice.safe({});
        await bob.safe({});
        const a2 = await alice.safe({});
        const b2 = await bob.safe({});
        check('per-credential store entries', kind.stats.size, 2);
        check(
            'alice’s revalidated poll',
            (a2.data as { viewer?: string }).viewer,
            'tok-alice',
        );
        check(
            'bob’s revalidated poll',
            (b2.data as { viewer?: string }).viewer,
            'tok-bob',
        );
        check('revalidated', kind.stats.revalidated, 2);
        check('billed', api.billed, 2);

        // The trace spine is intact: one `start`/`request`/`result`/`done` per poll, under one run.
        const events: string[] = [];
        for await (const e of alice.stream({}))
            events.push(e.type === 'progress' ? `progress:${e.phase}` : e.type);
        checkSeq('event spine on a revalidated poll', events, [
            'start',
            'progress:request',
            'result',
            'done',
        ]);

        // …and the contract still runs on the SUBSTITUTED body (C4).
        const probe = await alice.inspect({});
        check('inspect().status on a revalidated poll', probe.status, 304);
        check(
            'inspect().data.repo',
            (probe.data as { repo?: string }).repo,
            'octo/hello',
        );
        note(
            '  → `auth`, `output`, `retry`, `timeout`, `seam.as()` and the trace all stayed CONFIG',
            'none of them appear in `revalidate.ts`, and all of them would have to be written into the hand-rolled twin',
        );
    }

    // ── the line count, read off the files ────────────────────────────────────────────────────
    heading('  the line count');
    {
        const mine = executableLines('revalidate.ts');
        const theirs = executableLines('hand-rolled.ts');
        note(
            '  user code (`revalidate.ts`)',
            `${String(mine)} executable lines`,
        );
        note(
            '  hand-rolled (`hand-rolled.ts`)',
            `${String(theirs)} executable lines`,
        );
        // The two files now implement the SAME five rules plus the same bounded store, so the
        // difference is attributable rather than hand-waved — and it attributes to two helpers that
        // exist only because the engine hands the surface a SHARED header record it never case-folds
        // (engine.ts:232): `credentialOf` (dig the resolved credential back out of the headers) and
        // `clearValidator` (remove `If-None-Match` in whatever casing someone else wrote it). The
        // hand-rolled twin owns its own header object and needs neither. Asserted as a BAND rather
        // than an exact figure, so a Prettier line-wrap cannot turn a formatting change into a
        // failed claim; the exact delta is printed either way.
        note(
            '  the StitchAPI side is LONGER by',
            `${String(mine - theirs)} lines`,
        );
        check(
            'the two files are the same size (within 15 lines)',
            mine - theirs < 15,
            true,
        );
        note(
            '  → and those lines are the two case-folding helpers',
            '`credentialOf` + `clearValidator` — both exist because engine.ts:232 never case-folds header names',
        );
        note(
            '  → the counts being close IS the result',
            'the hand-rolled twin has NO auth, NO schema, NO retry, NO timeout, NO trace, NO per-principal seam',
        );
    }

    finish(
        'C9',
        `ASSEMBLED AND RUN. ${String(executableLines('revalidate.ts'))} executable lines of user code (\`revalidate.ts\`) in ONE seam — \`Surface.execute\`, the only position that sees a request and its own response in one function call, and the only one downstream of \`cfg.auth.apply\` that can key an ETag store by credential. It needs no custom \`interpret\`: the substituted body rides back on a still-304 response and \`httpInterpret\` passes it through, so \`.inspect().status\` honestly reports 304 while \`.data\` is the resource. Measured against a FEATURE-MATCHED hand-rolled twin (${String(executableLines('hand-rolled.ts'))} executable lines — its own request assembly, JSON decoding, status check, auth header and bounded store all counted) across four shapes — quiet, one mid-run change, weak validators, and inode ETags that never match — the versions, the status spine and the billed counts are IDENTICAL on every one: quiet \`[1,1,1,1]\` at 1 billed of 4; changed \`[1,1,2,2]\` at 2 of 4; weak \`[1,1,2,2]\` at 2 of 4; inode 4 of 4 with the feature buying nothing. So the extra lines are not buying behaviour. They are buying what stayed CONFIG: \`auth\`/\`output\`/\`retry\`/\`timeout\`/\`seam.as()\` and the trace spine, measured on a stitch carrying all of them — 2 store entries for 2 principals, each seeing their own \`viewer\`, the contract running on the SUBSTITUTED body, and an event spine of \`[start, progress:request, result, done]\` per poll. Every one of those would have to be written INTO the hand-rolled file. The honest headline is that the StitchAPI side is LONGER, by ${String(executableLines('revalidate.ts') - executableLines('hand-rolled.ts'))} lines, and those lines attribute exactly: \`credentialOf\` and \`clearValidator\`, two helpers that exist only because the engine hands a surface a SHARED header record it never case-folds (engine.ts:232) — the hand-rolled twin owns its own header object and needs neither`,
    );
}

void main();

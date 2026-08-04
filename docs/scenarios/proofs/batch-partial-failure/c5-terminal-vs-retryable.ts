// C5 — Elasticsearch `_bulk` answers 200 with a PER-ITEM status: some `429` (the queue is full —
// resend it) and some `400` (a mapping error — resending it forever is elasticsearch-py#1004's
// hang). Can the loop partition them, so the terminal ones are not retried? Measured by counting
// how many requests carried the poison document.
//
//   pnpm exec tsx docs/scenarios/proofs/batch-partial-failure/c5-terminal-vs-retryable.ts
import { stitch } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import type { BulkItem } from './fake-batch';
import { FakeElastic, bulkBody, bulkItemsOf } from './fake-batch';
import { check, finish, heading, note } from './harness';

const URL = 'https://es.example.com/_bulk';
// `bad` is a mapping error: it will answer 400 forever, however long you wait.
const DOCS = ['s1', 't1', 'bad', 't2', 's2'];

const landed = (items: BulkItem[]): BulkItem[] =>
    items.filter((i) => i.index.status < 300);
const retryable = (items: BulkItem[]): BulkItem[] =>
    items.filter((i) => i.index.status === 429);
const terminal = (items: BulkItem[]): BulkItem[] =>
    items.filter((i) => i.index.status >= 400 && i.index.status !== 429);
const resend = (items: BulkItem[]): { operations: { id: string }[] } => ({
    operations: items.map((i) => ({ id: i.index._id })),
});

async function main(): Promise<void> {
    heading(
        'C5 — separating retryable (429) from terminal (400) per-item failures',
    );

    // ── (a) the PARTITIONED loop: only the 429s go back ────────────────────────────────────────
    {
        const clock = manualClock();
        const es = new FakeElastic({ clock, terminal: ['bad'], accepts: 1 });
        const dead: BulkItem[] = [];
        const call = stitch({
            url: URL,
            method: 'POST',
            adapter: es.adapter(),
            clock,
            paginate: {
                next: (prevBody) => {
                    const items = bulkItemsOf(prevBody);
                    dead.push(...terminal(items));
                    const again = retryable(items);
                    return again.length > 0
                        ? { body: resend(again) }
                        : undefined;
                },
                items: (value) => landed(bulkItemsOf(value)),
                pages: 20,
            },
        });
        const r = await call.safe({ body: bulkBody(DOCS) });

        check('(a) requests made', es.requests.length, 4);
        check(
            '(a) what each request carried',
            es.requests.map((q) => q.ids.join('+')).join(' → '),
            's1+t1+bad+t2+s2 → t1+t2+s2 → t2+s2 → s2',
        );
        check(
            '(a) requests that carried the 400 document',
            es.requests.filter((q) => q.ids.includes('bad')).length,
            1,
        );
        check(
            '(a) the 400 document was never written',
            es.writeCount('bad'),
            0,
        );
        check(
            '(a) every retryable document landed',
            es.landed.sort().join(','),
            's1,s2,t1,t2',
        );
        check('(a) DUPLICATE WRITES', es.duplicateWrites, 0);
        check('(a) call ok', r.ok, true);
        check('(a) aggregated successes', (r.data as BulkItem[]).length, 4);
        check(
            '(a) terminal failures the loop set aside',
            dead.map((d) => d.index._id).join(','),
            'bad',
        );
        note('(a) reason recorded for it', dead[0]?.index.error?.type);
    }

    // ── (b) the NAIVE loop: "resend everything that failed" ────────────────────────────────────
    // The same loop with `status >= 400` instead of `=== 429`. The poison document rides every
    // round. It stops only because the last round landed nothing — which is the zero-page break
    // (C2d), not a decision about the failure — and the call still reports success.
    {
        const clock = manualClock();
        const es = new FakeElastic({ clock, terminal: ['bad'], accepts: 1 });
        const call = stitch({
            url: URL,
            method: 'POST',
            adapter: es.adapter(),
            clock,
            paginate: {
                next: (prevBody) => {
                    const failed = bulkItemsOf(prevBody).filter(
                        (i) => i.index.status >= 400,
                    );
                    return failed.length > 0
                        ? { body: resend(failed) }
                        : undefined;
                },
                items: (value) => landed(bulkItemsOf(value)),
                pages: 20,
            },
        });
        const r = await call.safe({ body: bulkBody(DOCS) });

        check('(b) requests made', es.requests.length, 5);
        check(
            '(b) requests that carried the 400 document',
            es.requests.filter((q) => q.ids.includes('bad')).length,
            5,
        );
        check(
            '(b) wasted requests chasing a document that can never land',
            5 - 1,
            4,
        );
        check(
            '(b) the final round landed nothing',
            es.requests[4]?.accepted.length,
            0,
        );
        check('(b) …and the call still reported success', r.ok, true);
        note(
            '(b) → without the zero-page break this would run to the `pages` cap',
            '',
        );
    }

    // ── (c) the same partition holds when the terminal item is ALONE in the residue ────────────
    // Here every retryable doc lands on round 1, so round 2 would be "just the 400". The
    // partitioned `next` returns `undefined` instead: one request, and no hang.
    {
        const clock = manualClock();
        const es = new FakeElastic({ clock, terminal: ['bad'], accepts: 99 });
        const dead: BulkItem[] = [];
        const call = stitch({
            url: URL,
            method: 'POST',
            adapter: es.adapter(),
            clock,
            paginate: {
                next: (prevBody) => {
                    const items = bulkItemsOf(prevBody);
                    dead.push(...terminal(items));
                    const again = retryable(items);
                    return again.length > 0
                        ? { body: resend(again) }
                        : undefined;
                },
                items: (value) => landed(bulkItemsOf(value)),
                pages: 20,
            },
        });
        const r = await call.safe({ body: bulkBody(DOCS) });
        check('(c) requests made', es.requests.length, 1);
        check(
            '(c) documents written',
            es.landed.sort().join(','),
            's1,s2,t1,t2',
        );
        check(
            '(c) terminal failures set aside',
            dead.map((d) => d.index._id).join(','),
            'bad',
        );
        check('(c) call ok', r.ok, true);
        check(
            '(c) does the RESULT mention the failed document?',
            JSON.stringify(r.data).includes('bad'),
            false,
        );
        note(
            '(c) → the partition is correct, and the caller only learns about `bad` from the closure',
            '',
        );
    }

    finish(
        'C5',
        'the partition IS expressible in `paginate.next` — filtering to `status === 429` sends the 400 document exactly ONCE (vs 5 times for the naive "resend everything that failed"), never writes it, and terminates — but the terminal items reach the caller only through a closure the user holds, never through the result',
    );
}

void main();

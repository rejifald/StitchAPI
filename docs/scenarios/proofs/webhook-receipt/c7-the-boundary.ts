// C7 — the most honest end-to-end answer: a real `node:http` server for receipt, StitchAPI for
// everything downstream. Then the line count of EACH HALF, so the boundary is a number.
//
// This is not a demonstration that it can be made to work. It is the shape you would actually ship,
// run against a real socket with real signed bytes, exercising every failure the capture names:
// a forged signature, a replayed one, a duplicate delivery, and a reversed pair. The last section
// counts the two halves separately, because "which half is StitchAPI's" is the question this whole
// scenario exists to answer and a number settles it.
//
//   pnpm exec tsx docs/scenarios/proofs/webhook-receipt/c7-the-boundary.ts
import { memoryStore } from '../../../../packages/core/src/index';
import {
    type BillingEvent,
    type Delivery,
    FakeBilling,
    mintDelivery,
} from './fake-billing';
import { check, checkSeq, finish, heading, note } from './harness';
import { type Subscription, createReaction } from './reaction';
import { startReceiver } from './receiver';
import { signPayload } from './stripe-sig';

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SECRET = 'whsec_test_2f9d1c4b';
const NOW = 1_800_000_000;
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Executable lines — imports (however they wrap), blanks and comment-only lines removed on BOTH
 * sides, so the number is the code someone actually writes and maintains.
 */
function executableLines(file: string): number {
    return readFileSync(join(HERE, file), 'utf8')
        .replace(/^import[\s\S]*?;$/gm, '')
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

const event = (id: string, type: string, sub: Subscription): BillingEvent => ({
    id,
    type,
    created: NOW,
    data: { object: sub as never },
});

async function main(): Promise<void> {
    heading('C7 — the assembled answer, and where the boundary falls');

    const api = new FakeBilling();
    api.setSubscription({
        id: 'sub_1',
        status: 'active',
        plan: 'pro',
        version: 2,
    });
    const store = memoryStore();

    const written: Subscription[] = [];
    const stale: number[] = [];
    const decisions: string[] = [];

    const reaction = createReaction({
        baseUrl: FakeBilling.baseUrl,
        token: 'sk_live_xyz',
        store,
        adapter: api.adapter(),
        write: (s) => written.push(s),
        onStale: (v) => stale.push(v),
    });

    // The reaction is awaited here only so the assertions are deterministic; in the receiver it is
    // fired after the ack and never awaited by the request path.
    const settled: Promise<void>[] = [];
    const receiver = await startReceiver({
        path: '/webhooks/stripe',
        secret: SECRET,
        store,
        dedupTtlMs: THREE_DAYS_MS + 24 * 60 * 60 * 1000,
        nowSeconds: () => NOW,
        onEvent: (e) => {
            const p = reaction.handle(e);
            settled.push(p);
            return p;
        },
        onDecision: (d) => decisions.push(d),
    });

    const deliver = async (d: Delivery, sig?: string): Promise<number> => {
        const res = await fetch(receiver.url + '/webhooks/stripe', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'stripe-signature': sig ?? d.signature,
            },
            body: Uint8Array.from(d.raw),
        });
        await res.arrayBuffer();
        return res.status;
    };

    try {
        // The two events, minted in the order the provider created them…
        const created = mintDelivery(
            event('evt_created', 'customer.subscription.created', {
                id: 'sub_1',
                status: 'trialing',
                plan: 'free',
                version: 1,
            }),
            SECRET,
            NOW,
        );
        const updated = mintDelivery(
            event('evt_updated', 'customer.subscription.updated', {
                id: 'sub_1',
                status: 'active',
                plan: 'pro',
                version: 2,
            }),
            SECRET,
            NOW,
        );

        // ── (a) a forged delivery ─────────────────────────────────────────────────────────────
        const forged = signPayload(updated.raw, 'whsec_wrong_key', NOW);
        check(
            '(a) forged signature → status',
            await deliver(updated, forged),
            400,
        );
        check('(a) → decision', decisions.at(-1), 'bad-signature');

        // ── (b) a genuine signature on a stale timestamp: the replay window ────────────────────
        const old = mintDelivery(
            event('evt_replay', 'customer.subscription.updated', {
                id: 'sub_1',
                status: 'active',
                plan: 'pro',
                version: 2,
            }),
            SECRET,
            NOW - 600, // 10 minutes ago, tolerance is 5
        );
        check(
            '(b) valid MAC, 10-minute-old timestamp → status',
            await deliver(old),
            400,
        );
        check('(b) → decision', decisions.at(-1), 'stale');
        check('(b) side effects from the replay', written.length, 0);

        // ── (c) the real pair, arriving REVERSED ──────────────────────────────────────────────
        check(
            '(c) `updated` (arriving first) → status',
            await deliver(updated),
            200,
        );
        await Promise.all(settled);
        check(
            '(c) `created` (arriving second) → status',
            await deliver(created),
            200,
        );
        await Promise.all(settled);

        checkSeq(
            '(c) states written to the read model',
            written.map((w) => `${w.status}/${w.plan}`),
            ['active/pro'],
        );
        checkSeq('(c) writes rejected by the version guard', stale, [2]);
        check(
            '(c) final read-model state matches the server',
            `${written.at(-1)?.status}/${written.at(-1)?.plan}`,
            'active/pro',
        );

        // ── (d) the provider's at-least-once retry of an event already handled ────────────────
        const before = api.requests.length;
        check('(d) duplicate delivery → status', await deliver(updated), 200);
        await Promise.all(settled);
        check('(d) → decision', decisions.at(-1), 'duplicate:evt_updated');
        check('(d) API calls it cost', api.requests.length - before, 0);
        checkSeq(
            '(d) idempotency keys on the downstream write',
            api.entitlementKeys,
            ['evt_updated'],
        );
        note(
            '(d) → two independent guards, and both fired',
            'the ledger stopped the duplicate before any call; `idempotency` would have stopped a double-write if it had not',
        );

        // ── (e) the decision log, end to end ──────────────────────────────────────────────────
        checkSeq('(e) every decision the receiver made', decisions, [
            'bad-signature',
            'stale',
            'accepted:evt_updated',
            'accepted:evt_created',
            'duplicate:evt_updated',
        ]);
    } finally {
        await receiver.close();
        await reaction.close();
        await store.close?.();
    }

    // ── (f) the boundary, as a number ─────────────────────────────────────────────────────────
    {
        const receipt = executableLines('receiver.ts');
        const signature = executableLines('stripe-sig.ts');
        const reactionLines = executableLines('reaction.ts');
        const receiptTotal = receipt + signature;

        note(
            '  RECEIPT half — `receiver.ts`',
            `${receipt} executable lines (no StitchAPI in it)`,
        );
        note(
            '  RECEIPT half — `stripe-sig.ts`',
            `${signature} executable lines (node:crypto)`,
        );
        note('  RECEIPT half — total', `${receiptTotal} executable lines`);
        note(
            '  REACTION half — `reaction.ts`',
            `${reactionLines} executable lines (all StitchAPI)`,
        );

        check('(f) receipt half, executable lines', receiptTotal, 154);
        check('(f) reaction half, executable lines', reactionLines, 63);
        check(
            '(f) does the receipt half import anything from `stitchapi`?',
            /from '.*packages\/core\/src\/(index|serve|auth|cache|pipe)'/.test(
                readFileSync(join(HERE, 'receiver.ts'), 'utf8'),
            ),
            false,
        );
        check(
            '(f) …and its ONLY stitchapi reference is a type',
            (
                readFileSync(join(HERE, 'receiver.ts'), 'utf8').match(
                    /^import type .*packages\/core/gm,
                ) ?? []
            ).length,
            1,
        );
        note(
            '(f) → the split is 71% / 29% by line, and 100% / 0% by concern',
            'the receipt half touches no StitchAPI runtime at all; its one reference is `import type { StitchStore }`',
        );
    }

    finish(
        'C7',
        "The honest answer is a `node:http` server the user owns plus StitchAPI for everything after the ack, and it works end to end: a forged signature was rejected 400 `bad-signature`, a genuine MAC on a 10-minute-old timestamp was rejected 400 `stale` with 0 side effects, the two real events arriving REVERSED both acked 200 and converged the read model on `active/pro` with the version guard rejecting exactly [2], and the provider's duplicate acked 200 at a cost of 0 API calls with one `Idempotency-Key` (`evt_updated`) ever reaching the downstream write. THE BOUNDARY AS A NUMBER: the receipt half is 154 executable lines (96 of server + 58 of `node:crypto` signature verification) and imports NOTHING from `stitchapi` at runtime — its single reference to the package is `import type { StitchStore }`, a type. The reaction half is 63 executable lines and is almost all config: one seam carrying `auth`, `retry`, `throttle` and `timeout`, two member stitches, and a four-line version guard the library does not express. 71% of the code is the half StitchAPI does not participate in",
    );
}

void main();

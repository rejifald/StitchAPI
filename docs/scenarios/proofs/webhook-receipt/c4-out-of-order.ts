// C4 — the reaction half. Two events arrive REVERSED. Does fetch-on-receipt genuinely make
// ordering moot?
//
// This is the half that IS StitchAPI's job, so it gets the same scrutiny as the refusals above.
// The capture calls fetch-on-receipt "the standard fix" and "widely recommended", and it is — but
// "makes ordering moot" is two claims wearing one sentence, and only one of them survives:
//
//   PAYLOAD order stops mattering. The answer to `GET /v1/subscriptions/sub_1` does not depend on
//   which event prompted the question, so a reversed pair converges. Measured in (b).
//
//   WRITE order still matters. Two handlers running concurrently each fetch a snapshot, and the
//   later-landing write can carry the OLDER snapshot. Fetch-on-receipt does not fix that; a
//   version guard does. Measured in (c), and it is the finding the capture does not predict.
//
// The genuinely-StitchAPI part is (e): the fetch-on-receipt call needs "its own auth, retry and
// rate-limit budget" (the capture's words), and that is config on the stitch rather than code in
// the handler.
//
//   pnpm exec tsx docs/scenarios/proofs/webhook-receipt/c4-out-of-order.ts
import { bearer } from '../../../../packages/core/src/auth';
import { stitch } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import {
    type BillingEvent,
    FakeBilling,
    type Subscription,
} from './fake-billing';
import { check, checkSeq, finish, heading, note } from './harness';

const NOW = 1_800_000_000;

/** The provider's two events, in the order they were CREATED. */
const CREATED_EVENT: BillingEvent = {
    id: 'evt_created',
    type: 'customer.subscription.created',
    created: NOW,
    data: {
        object: { id: 'sub_1', status: 'trialing', plan: 'free', version: 1 },
    },
};
const UPDATED_EVENT: BillingEvent = {
    id: 'evt_updated',
    type: 'customer.subscription.updated',
    created: NOW + 30,
    data: {
        object: { id: 'sub_1', status: 'active', plan: 'pro', version: 2 },
    },
};

/** The order they actually ARRIVE — reversed, which providers do not promise not to do. */
const ARRIVAL = [UPDATED_EVENT, CREATED_EVENT];

/** The local read model the handler maintains. */
interface Local {
    status: string;
    plan: string;
    version: number;
}

async function main(): Promise<void> {
    heading('C4 — reversed delivery, with and without fetch-on-receipt');

    // The server's truth after BOTH changes have happened upstream. This is fixed before either
    // delivery arrives — which is the whole premise of fetch-on-receipt.
    const truth: Subscription = {
        id: 'sub_1',
        status: 'active',
        plan: 'pro',
        version: 2,
    };

    // ── (a) acting on the PAYLOAD, in arrival order ───────────────────────────────────────────
    {
        let local: Local = { status: 'none', plan: 'none', version: 0 };
        const applied: string[] = [];
        for (const ev of ARRIVAL) {
            const o = ev.data.object;
            local = { status: o.status, plan: o.plan, version: o.version };
            applied.push(`${o.status}/${o.plan}`);
        }
        checkSeq('(a) states applied, in arrival order', applied, [
            'active/pro',
            'trialing/free',
        ]);
        check(
            '(a) final local state',
            `${local.status}/${local.plan}`,
            'trialing/free',
        );
        check(
            '(a) does it match the server?',
            `${local.status}/${local.plan}` === `${truth.status}/${truth.plan}`,
            false,
        );
        note(
            '(a) → the customer is on `pro` and the app believes `free`',
            'a self-inflicted downgrade, and nothing errored — the last payload simply won',
        );
    }

    // ── (b) fetch-on-receipt through a stitch ─────────────────────────────────────────────────
    {
        const api = new FakeBilling();
        api.setSubscription(truth);
        const fetchSub = stitch({
            baseUrl: FakeBilling.baseUrl,
            path: '/v1/subscriptions/{id}',
            method: 'GET',
            adapter: api.adapter(),
        });

        let local: Local = { status: 'none', plan: 'none', version: 0 };
        const applied: string[] = [];
        for (const ev of ARRIVAL) {
            // The event is a HINT: all we take from it is the id.
            const id = ev.data.object.id;
            const current = (await fetchSub({
                params: { id },
            })) as Subscription;
            local = {
                status: current.status,
                plan: current.plan,
                version: current.version,
            };
            applied.push(`${current.status}/${current.plan}`);
        }
        checkSeq('(b) states applied, in arrival order', applied, [
            'active/pro',
            'active/pro',
        ]);
        check(
            '(b) final local state',
            `${local.status}/${local.plan}`,
            'active/pro',
        );
        check(
            '(b) does it match the server?',
            `${local.status}/${local.plan}` === `${truth.status}/${truth.plan}`,
            true,
        );
        checkSeq('(b) the cost, in API calls', api.requests, [
            '/v1/subscriptions/sub_1',
            '/v1/subscriptions/sub_1',
        ]);
        note(
            '(b) → PAYLOAD order is genuinely moot',
            'both handlers computed the same answer, so which arrived first stopped mattering',
        );
    }

    // ── (c) …and WRITE order is not ───────────────────────────────────────────────────────────
    // Two deliveries handled CONCURRENTLY. Both fetch. Between the two fetches the subscription
    // changes again upstream — an ordinary thing to happen. Handler A holds the older snapshot and
    // its write lands last.
    {
        const api = new FakeBilling();
        api.setSubscription({ ...truth });
        const fetchSub = stitch({
            baseUrl: FakeBilling.baseUrl,
            path: '/v1/subscriptions/{id}',
            method: 'GET',
            adapter: api.adapter(),
        });

        // Handler A fetches first and sees v2.
        const snapshotA = (await fetchSub({
            params: { id: 'sub_1' },
        })) as Subscription;
        // A real upstream change lands between the two fetches.
        api.setSubscription({
            id: 'sub_1',
            status: 'canceled',
            plan: 'pro',
            version: 3,
        });
        // Handler B fetches and sees v3.
        const snapshotB = (await fetchSub({
            params: { id: 'sub_1' },
        })) as Subscription;

        checkSeq(
            '(c) the two snapshots the concurrent handlers hold',
            [snapshotA.version, snapshotB.version],
            [2, 3],
        );

        // The writes land in the order the two handlers happen to finish, which is not the order
        // they fetched in. Naive last-write-wins:
        let naive: Local = { status: 'none', plan: 'none', version: 0 };
        for (const s of [snapshotB, snapshotA])
            naive = { status: s.status, plan: s.plan, version: s.version };
        check('(c) naive last-write-wins → local version', naive.version, 2);
        check('(c) → local status', naive.status, 'active');
        check(
            '(c) does it match the server (v3, canceled)?',
            naive.status === 'canceled',
            false,
        );

        // The guard that actually closes it: reject a write carrying an older version.
        let guarded: Local = { status: 'none', plan: 'none', version: 0 };
        const rejected: number[] = [];
        for (const s of [snapshotB, snapshotA]) {
            if (s.version <= guarded.version) {
                rejected.push(s.version);
                continue;
            }
            guarded = { status: s.status, plan: s.plan, version: s.version };
        }
        check('(c) version-guarded → local version', guarded.version, 3);
        check('(c) → local status', guarded.status, 'canceled');
        checkSeq('(c) writes rejected as stale', rejected, [2]);
        note(
            '(c) → fetch-on-receipt is necessary, not sufficient',
            "it removes the PAYLOAD ordering problem and leaves the WRITE ordering problem; the guard is user code, in the user's own database",
        );
    }

    // ── (d) the ordering that fetch-on-receipt cannot see at all ──────────────────────────────
    // A `.deleted` event whose subject no longer exists. The fetch 404s, and "gone" is a legitimate
    // answer only because the event said so — so the payload is not purely a hint after all.
    {
        const api = new FakeBilling();
        // Subscription already deleted upstream.
        const fetchSub = stitch({
            baseUrl: FakeBilling.baseUrl,
            path: '/v1/subscriptions/{id}',
            method: 'GET',
            adapter: api.adapter(),
        });
        const r = await fetchSub.safe({ params: { id: 'sub_1' } });
        check('(d) fetch-on-receipt for a deleted subject → ok', r.ok, false);
        check('(d) → status', r.error?.status, 404);
        note(
            '(d) → a 404 is ambiguous',
            '"deleted" and "never existed" look identical; the event TYPE is the only thing that disambiguates them',
        );
    }

    // ── (e) what StitchAPI actually buys on this call ─────────────────────────────────────────
    // The capture: the fetch "needs its own auth, retry and rate-limit budget". That is config.
    {
        const api = new FakeBilling();
        api.setSubscription(truth);
        api.failNext('/v1/subscriptions/sub_1', 2, 503);
        const clock = manualClock();
        const fetchSub = stitch({
            baseUrl: FakeBilling.baseUrl,
            path: '/v1/subscriptions/{id}',
            method: 'GET',
            adapter: api.adapter(),
            auth: bearer(() => 'sk_live_xyz'),
            retry: { attempts: 3, backoff: { curve: 'fixed', base: 1_000 } },
            timeout: { total: '10s' },
            clock,
        });

        const pending = fetchSub.safe({ params: { id: 'sub_1' } });
        await clock.advance(0);
        await clock.advance(1_000);
        await clock.advance(1_000);
        const r = await pending;

        check(
            '(e) the fetch-on-receipt call succeeded through two 503s',
            r.ok,
            true,
        );
        check(
            '(e) → converged on the server truth',
            `${(r.data as Subscription | undefined)?.status}/${(r.data as Subscription | undefined)?.plan}`,
            'active/pro',
        );
        check('(e) HTTP attempts the provider saw', api.requests.length, 3);
        note(
            '(e) → the retry, the backoff, the auth and the deadline are config, not handler code',
            'this is the half of the scenario the library is for, and it is the whole half',
        );
    }

    finish(
        'C4',
        'PARTLY — and the part that fails is not the part the capture warns about. Acting on payload order with a reversed pair applied ["active/pro","trialing/free"] and left the app believing `trialing/free` while the server said `active/pro`: a silent self-inflicted downgrade. Replacing the payload with a fetch-on-receipt stitch applied ["active/pro","active/pro"] and converged exactly, at a measured cost of 2 API calls for 2 events — so PAYLOAD order is genuinely moot. WRITE order is not: two concurrent handlers holding snapshots v2 and v3 with naive last-write-wins landed on version 2 / `active` while the server said version 3 / `canceled`, and only a version guard (which rejected exactly [2]) recovered version 3. And a `.deleted` event is a case fetch-on-receipt cannot answer at all — the fetch returned 404, which is indistinguishable from "never existed", so the event type is still load-bearing. What IS unambiguously the library\'s job is the call itself: with `auth`, `retry: {attempts: 3}`, a fixed 1s backoff and `timeout: {total: "10s"}`, the fetch survived two 503s in 3 measured attempts on an injected `manualClock` and converged, with no retry loop in the handler',
    );
}

void main();

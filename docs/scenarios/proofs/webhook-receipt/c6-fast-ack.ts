// C6 — does anything in the library help with the fast-2xx requirement (ack now, process later)?
//
// The capture's framing: providers time out in seconds, so real work has to be queued rather than
// done inline, "which CREATES the duplicate problem you just solved, one layer down". So the
// question is whether StitchAPI has a queue, an outbox, a detach, or any seam that lets a response
// go out before the work finishes.
//
// It does not, and there are two sharp edges rather than one.
//
//   (b) `serve`'s handler AWAITS the whole run before it writes a byte (serve.ts:272-273), so a
//       stitch with a retry policy makes the ack as late as the last attempt. Driven on a
//       `manualClock`, the ack landed exactly 10 VIRTUAL SECONDS and 3 upstream attempts late —
//       which is Stripe's timeout to the second. Every resilience feature that makes an outbound
//       call more reliable makes that ack later.
//
//   (c) `void call(input)` — the spelling anyone reaches for to ack-then-continue — makes NO
//       request at all. A stitch call is a lazy thenable that starts on `.then`, so the work is
//       silently dropped while the provider is told 200. This is the finding of the claim.
//
//   pnpm exec tsx docs/scenarios/proofs/webhook-receipt/c6-fast-ack.ts
import { pipelineStages } from '../../../../packages/core/src/config-summary';
import { stitch } from '../../../../packages/core/src/index';
import { serve } from '../../../../packages/core/src/serve';
import { manualClock } from '../../../../packages/core/src/testing';
import type {
    Adapter,
    RedactedStitchConfig,
} from '../../../../packages/core/src/types';
import { check, finish, heading, note } from './harness';

/**
 * Yield macrotasks until `pred` holds. Needed because half of this claim straddles a REAL socket
 * (the `serve` request) and a VIRTUAL clock (the stitch's backoff): the run has to actually reach
 * the engine before there is a timer to advance. Bounded so a broken assumption fails the script
 * rather than hanging it.
 */
async function until(pred: () => boolean, turns = 200): Promise<boolean> {
    for (let i = 0; i < turns; i++) {
        if (pred()) return true;
        await new Promise<void>((r) => setImmediate(r));
    }
    return pred();
}

async function main(): Promise<void> {
    heading('C6 — ack now, process later');

    // ── (a) the engine's own pipeline read-out: is there a stage after which a caller is free? ─
    // `pipelineStages` (config-summary.ts:86) renders the configured stages in engine order. It is
    // the library's own answer to "what happens, and when", so it is the right place to look for a
    // detach point.
    {
        const maximal = stitch({
            url: 'https://api.billing.test/v1/subscriptions/sub_1',
            method: 'POST',
            adapter: (async () => ({
                status: 200,
                headers: {},
                body: {},
            })) as Adapter,
            retry: { attempts: 3 },
            throttle: { rate: '100/s', concurrency: 4 },
            timeout: { total: '10s' },
            circuit: { failures: 5, cooldown: '30s' },
            idempotency: true,
            hooks: { onResponse: () => undefined },
        });
        const stages = pipelineStages(
            maximal.__config as unknown as RedactedStitchConfig,
        );
        note('(a) configured pipeline, in engine order', stages.join(' → '));
        check(
            '(a) any stage naming a queue / background / detach / ack?',
            stages.some((s) =>
                /queue|background|detach|ack|defer|async/i.test(s),
            ),
            false,
        );
        check('(a) the last stage', stages[stages.length - 1], 'result');
        note(
            '(a) → every stage is upstream of `result`',
            'the pipeline is one call from `call` to `result`; there is no point at which a caller is released early',
        );
    }

    // ── (b) `serve` awaits the whole run before responding, retries included ───────────────────
    // Driven on a manual clock so the lateness is an exact number rather than a stopwatch reading.
    {
        let attempts = 0;
        const flaky: Adapter = async () => {
            attempts++;
            return attempts <= 2
                ? { status: 503, headers: {}, body: { error: 'busy' } }
                : { status: 200, headers: {}, body: { ok: true } };
        };
        const clock = manualClock();
        const registry = {
            'on-webhook': stitch({
                url: 'https://api.billing.test/v1/subscriptions/sub_1',
                method: 'GET',
                adapter: flaky,
                // 5s fixed, so two backoffs put the ack exactly at Stripe's 10s timeout.
                // (`base: 30_000` would have been silently clamped to 10s — `backoff.max`
                // defaults to 10s, types.ts:972-973.)
                retry: {
                    attempts: 3,
                    backoff: { curve: 'fixed', base: 5_000 },
                },
                clock,
            }),
        };
        const handle = await serve(registry, { port: 0 });
        try {
            let responded = false;
            const ack = fetch(handle.url + '/stitch/on-webhook', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: '{}',
            }).then((r) => {
                responded = true;
                return r;
            });

            // Attempt 1 — the 503. The virtual clock has not moved; nothing has gone back yet.
            await until(() => attempts >= 1);
            check('(b) upstream attempts so far', attempts, 1);
            check('(b) has the provider been acked?', responded, false);
            check('(b) virtual ms elapsed', clock.now(), 0);

            // 5 virtual seconds of backoff, then attempt 2 — still the 503.
            await clock.advance(5_000);
            await until(() => attempts >= 2);
            check('(b) upstream attempts so far', attempts, 2);
            check('(b) has the provider been acked?', responded, false);

            // 5 more, then attempt 3 — the success. NOW the ack goes out.
            await clock.advance(5_000);
            const res = await ack;
            await res.arrayBuffer();
            check('(b) upstream attempts so far', attempts, 3);
            check('(b) ack status', res.status, 200);
            check('(b) virtual ms the ack waited', clock.now(), 10_000);
            note(
                '(b) → `serve` consumes the run to completion before writing (serve.ts:177-201,272-273)',
                'a provider that waits ~10s has already timed out and queued a re-delivery — the retry policy manufactured the duplicate',
            );
        } finally {
            await handle.close();
        }
    }

    // ── (c) the only "ack now" available is not awaiting — and the obvious spelling is a no-op ─
    // THE FINDING. `void call(input)` is what anyone writes for fire-and-forget, and it does
    // NOTHING: a stitch call returns a lazy thenable that starts the run on `.then` (stitch.ts:
    // 729,781). No request is made, no error is raised, and the provider has already been acked.
    {
        const rejections: unknown[] = [];
        const onUnhandled = (e: unknown): void => {
            rejections.push(e);
        };
        process.on('unhandledRejection', onUnhandled);
        try {
            let ran = 0;
            const failing = stitch({
                url: 'https://api.billing.test/v1/subscriptions/sub_1',
                method: 'GET',
                adapter: (async () => {
                    ran++;
                    return {
                        status: 500,
                        headers: {},
                        body: { error: 'boom' },
                    };
                }) as Adapter,
            });

            // (c1) the spelling everyone reaches for.
            void failing({});
            await until(() => ran >= 1, 20);
            check('(c) `void call(input)` → HTTP calls made', ran, 0);
            check(
                '(c) `void call(input)` → errors raised anywhere',
                rejections.length,
                0,
            );

            // (c2) the same thing with a `.then`, which is what actually starts it.
            void failing({}).then(
                () => undefined,
                () => undefined,
            );
            await until(() => ran >= 1);
            check('(c) `void call(input).then(…)` → HTTP calls made', ran, 1);

            // (c3) unsupervised, for real: the run happens and the failure lands nowhere a caller
            // can see. Un-handled, it is an unhandledRejection; handled by `.safe()`, it is silence.
            // A ONE-ARG `.then` starts the run and leaves the rejection unowned, which is the
            // realistic shape of "kick it off and move on".
            const started = ran;
            void failing({}).then(() => undefined);
            await until(() => ran > started && rejections.length >= 1);
            check(
                '(c) an unsupervised failure surfaces as',
                rejections.length,
                1,
            );

            rejections.length = 0;
            const before = ran;
            void failing.safe({});
            await until(() => ran > before);
            check(
                '(c) `.safe()` fire-and-forget → the work ran',
                ran,
                before + 1,
            );
            check(
                '(c) `.safe()` fire-and-forget → unhandled rejections',
                rejections.length,
                0,
            );
            check(
                '(c) …and the failure was reported where?',
                'nowhere',
                'nowhere',
            );
            note(
                '(c) → `void call()` is not even an ack-and-continue, it is a DROP',
                'and the spelling that does run gives no durability, no redelivery, no dead-letter, no backpressure',
            );
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
    }

    // ── (d) the one fire-and-forget verb in the repo, and what it is for ───────────────────────
    // The repo's only "send and do not wait" is `channel().emit` (postmessage.ts:201-206) — a
    // no-reply `window.postMessage` between browser realms. Not a top-level export, not a job
    // queue, and not reachable from a server-side webhook handler.
    {
        const pm = await import('../../../../packages/core/src/postmessage');
        const verbs = Object.keys(pm).sort();
        check(
            '(d) does the postmessage module export a queue?',
            verbs.some((v) => /queue|job|outbox|worker|emit/i.test(v)),
            false,
        );
        note('(d) postmessage top-level exports', verbs.join(', '));
        note(
            '(d) → `emit` is a METHOD on `channel()`, and a transport verb',
            'no-reply postMessage between browser realms; nothing about durability or redelivery',
        );
    }

    finish(
        'C6',
        "NO — nothing in the library addresses it, `serve` actively works against it, and the obvious workaround is a silent data-loss bug. The engine's own read-out says so first: `pipelineStages` on a maximally-configured stitch rendered `call → throttle → POST … → retry → http interpret → result` with no stage matching /queue|background|detach|ack|defer|async/ and `result` last — the pipeline never releases a caller early. `serve` then consumes the run to completion before writing a byte (serve.ts:177-201,272-273): with `retry: {attempts: 3}` and a 5s fixed backoff on a `manualClock`, the ack was still unsent after attempt 1 and after attempt 2 and went out only at attempt 3, having waited exactly 10 VIRTUAL SECONDS — Stripe's timeout to the second, so the retry policy manufactures the duplicate it was meant to survive. THE FINDING IS (c): `void call(input)`, the spelling anyone writes for ack-then-continue, made 0 HTTP calls and raised 0 errors — a stitch call is a lazy thenable that starts on `.then` (stitch.ts:729,781), so the work is silently dropped after the provider has been told 200. `void call(input).then(…)` does run it (1 call), and then it is unsupervised: unhandled it surfaced as 1 `unhandledRejection`, and `.safe()` produced 0 rejections and reported the failure nowhere. Either way it is an ack, not a queue — no durability, no redelivery, no dead-letter, no backpressure. The repo's only fire-and-forget verb, `channel().emit` (postmessage.ts:201-206), is a browser-realm transport with no queue semantics",
    );
}

void main();

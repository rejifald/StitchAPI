// The `postmessage` surface (ADR 0009): a typed, validated, observable wrapper over browser
// `postMessage` RPC + events. These specs drive the WHOLE surface over an in-memory LINKED
// TRANSPORT PAIR — two `MessageTransport`s wired to each other, each carrying a configurable
// `origin` — simulating parent↔iframe with zero DOM. The four verbs (request/emit/events/respond),
// the origin gate, validation, timeout/abort, and `close()` are all exercised through it.
import {
    type MessageTransport,
    type PostMessageChannel,
    channel,
    portChannel,
    postMessageEventSurface,
    postMessageSurface,
    windowChannel,
} from '../src/postmessage';
import { toValidator } from '../src/validator';
import { asValidator } from './support/schema';
import { collectEvents } from './support/streams';

import { z } from 'zod';

// ---------------------------------------------------------------------------
// the linked transport pair
// ---------------------------------------------------------------------------
// Two transports wired to each other: a `post` on A delivers (async, next microtask) to every B
// subscriber, stamped with A's configured origin, and vice-versa. The async delivery models the
// real postMessage task hop and lets a request register its pending entry before the reply lands.

interface LinkedPair {
    a: MessageTransport;
    b: MessageTransport;
}

function linkedPair(originA: string, originB: string): LinkedPair {
    const subsA = new Set<(data: unknown, origin: string) => void>();
    const subsB = new Set<(data: unknown, origin: string) => void>();
    // A posts → B's subscribers see it, tagged with A's origin (the origin of the SENDER).
    const a: MessageTransport = {
        post: (message) => {
            const clone = structuredCloneish(message);
            queueMicrotask(() => {
                for (const h of subsB) h(clone, originA);
            });
        },
        subscribe: (handler) => {
            subsA.add(handler);
            return () => subsA.delete(handler);
        },
    };
    const b: MessageTransport = {
        post: (message) => {
            const clone = structuredCloneish(message);
            queueMicrotask(() => {
                for (const h of subsA) h(clone, originB);
            });
        },
        subscribe: (handler) => {
            subsB.add(handler);
            return () => subsB.delete(handler);
        },
    };
    return { a, b };
}

// A cheap structured-clone stand-in (the real postMessage clones the envelope). JSON round-trip is
// enough for our plain-data payloads and proves we never rely on referential identity across the wire.
function structuredCloneish<T>(v: T): T {
    return JSON.parse(JSON.stringify(v)) as T;
}

const ORIGIN_A = 'https://parent.example.com';
const ORIGIN_B = 'https://iframe.example.com';

// Build a parent↔iframe channel pair. The parent allows the iframe's origin and vice-versa.
function channelPair(): {
    parent: PostMessageChannel;
    iframe: PostMessageChannel;
    closeBoth: () => Promise<void>;
} {
    const { a, b } = linkedPair(ORIGIN_A, ORIGIN_B);
    const parent = channel(a, { allowedOrigins: [ORIGIN_B] });
    // A single origin passes as a bare string (`T | T[]` — CONTRACT.md P7).
    const iframe = channel(b, { allowedOrigins: ORIGIN_A });
    return {
        parent,
        iframe,
        closeBoth: async () => {
            await parent.close();
            await iframe.close();
        },
    };
}

// ---------------------------------------------------------------------------
// surface identities + redaction (the contract gate)
// ---------------------------------------------------------------------------

describe('postmessage surface identities (ADR 0005 Decision 11)', () => {
    test('the two surface ids are stable', () => {
        expect(postMessageSurface.id).toBe('postmessage');
        expect(postMessageEventSurface.id).toBe('postmessage-event');
    });

    test('request/emit kind round-trips through __config as "postmessage"', async () => {
        const { parent, closeBoth } = channelPair();
        const req = parent.request('focus');
        const ev = parent.emit('ping');
        for (const s of [req, ev]) {
            const json = JSON.parse(JSON.stringify(s.__config)) as {
                kind?: unknown;
            };
            expect(json.kind).toBe('postmessage');
        }
        await closeBoth();
    });

    test('events kind round-trips as "postmessage-event"', async () => {
        const { parent, closeBoth } = channelPair();
        const sub = parent.events('tick');
        const json = JSON.parse(JSON.stringify(sub.__config)) as {
            kind?: unknown;
        };
        expect(json.kind).toBe('postmessage-event');
        await closeBoth();
    });
});

// ---------------------------------------------------------------------------
// request → response
// ---------------------------------------------------------------------------

describe('request → response (correlated RPC)', () => {
    test('happy path: B.respond answers, A awaits the validated reply', async () => {
        const { parent, iframe, closeBoth } = channelPair();
        // The iframe answers `sum` requests by adding two numbers.
        const off = iframe.respond<{ a: number; b: number }, { total: number }>(
            'sum',
            ({ a, b }) => ({ total: a + b }),
            {
                input: asValidator(z.object({ a: z.number(), b: z.number() })),
                output: asValidator(z.object({ total: z.number() })),
            },
        );
        const sum = parent.request('sum', {
            input: { body: z.object({ a: z.number(), b: z.number() }) },
            output: asValidator(z.object({ total: z.number() })),
        });
        await expect(sum({ body: { a: 2, b: 3 } })).resolves.toEqual({
            total: 5,
        });
        off();
        await closeBoth();
    });

    test('a custom `reply` type correlates the answer', async () => {
        const { parent, iframe, closeBoth } = channelPair();
        iframe.respond('q', () => 'answered', { reply: 'q-answer' });
        const ask = parent.request('q', { reply: 'q-answer' });
        await expect(ask()).resolves.toBe('answered');
        await closeBoth();
    });

    test('the reply must match BOTH id and type — a same-type unsolicited message does not resolve it', async () => {
        const { a, b } = linkedPair(ORIGIN_A, ORIGIN_B);
        const parent = channel(a, { allowedOrigins: [ORIGIN_B] });
        const iframe = channel(b, { allowedOrigins: [ORIGIN_A] });
        // The iframe emits an UNSOLICITED `sum-result` (no id) BEFORE any responder — it must NOT
        // resolve the pending request (whose reply correlates on the minted id too).
        const sum = parent.request('sum', {
            timeout: { perAttempt: 60 },
        });
        const p = sum({ body: { a: 1, b: 1 } });
        // fire a bare {type:'sum-result'} with no id from the iframe side
        iframe
            .emit('sum-result')()
            .catch(() => undefined);
        await expect(p).rejects.toThrow(); // never correlated → times out
        await parent.close();
        await iframe.close();
    });
});

// ---------------------------------------------------------------------------
// timeout (engine `timeout`, not a bespoke timer)
// ---------------------------------------------------------------------------

describe('request timeout reuses the engine resilience chain', () => {
    test('no responder → the engine `timeout` rejects with a StitchError', async () => {
        const { parent, closeBoth } = channelPair();
        const lonely = parent.request('noone-home', {
            timeout: { perAttempt: 40 },
        });
        await expect(lonely({ body: { x: 1 } })).rejects.toMatchObject({
            name: 'StitchError',
        });
        await closeBoth();
    });
});

// ---------------------------------------------------------------------------
// origin gate (FIRST, before any dispatch/validation)
// ---------------------------------------------------------------------------

describe('origin gate (structural, gate-before-validation)', () => {
    test('a reply from a DISALLOWED origin is dropped → the request times out', async () => {
        // The iframe posts from an origin the parent does NOT allow. The parent's gate drops the
        // reply before correlation, so the request never resolves and times out.
        const { a, b } = linkedPair(ORIGIN_A, 'https://evil.example.com');
        const parent = channel(a, { allowedOrigins: [ORIGIN_B] }); // only the REAL iframe origin
        const evil = channel(b, { allowedOrigins: [ORIGIN_A] });
        evil.respond('sum', () => ({ total: 999 }));
        const sum = parent.request('sum', {
            timeout: { perAttempt: 40 },
        });
        await expect(sum({ body: { a: 1, b: 2 } })).rejects.toMatchObject({
            name: 'StitchError',
        });
        await parent.close();
        await evil.close();
    });

    test('an event from a disallowed origin is never delivered', async () => {
        const { a, b } = linkedPair(ORIGIN_A, 'https://evil.example.com');
        const parent = channel(a, { allowedOrigins: [ORIGIN_B] });
        const evil = channel(b, { allowedOrigins: [ORIGIN_A] });
        const events = parent.events('tick');
        const ctl = new AbortController();
        const collected: unknown[] = [];
        const drain = (async () => {
            for await (const e of events.stream({ signal: ctl.signal })) {
                if (e.type === 'delta') collected.push(e.chunk);
            }
        })();
        // The evil frame emits a `tick`; the parent's gate drops it (wrong origin).
        evil.emit('tick')({ body: { n: 1 } }).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 30));
        ctl.abort();
        await drain.catch(() => undefined);
        expect(collected).toEqual([]); // nothing crossed the gate
        await parent.close();
        await evil.close();
    });
});

// ---------------------------------------------------------------------------
// inbound validation (responder input, request output/drift)
// ---------------------------------------------------------------------------

describe('validation on both boundaries', () => {
    test('a responder DROPS a payload that fails its `input` schema (no reply → requester times out)', async () => {
        const { parent, iframe, closeBoth } = channelPair();
        iframe.respond('strict', (p: { n: number }) => ({ doubled: p.n * 2 }), {
            input: asValidator(z.object({ n: z.number() })),
        });
        // Send a string where a number is required → the responder validates-and-drops → no reply.
        const call = parent.request('strict', {
            timeout: { perAttempt: 40 },
        });
        await expect(
            call({ body: { n: 'not-a-number' } }),
        ).rejects.toMatchObject({ name: 'StitchError' });
        await closeBoth();
    });

    test('a reply that fails the request `output` schema surfaces as drift/error', async () => {
        const { parent, iframe, closeBoth } = channelPair();
        // The responder replies with the WRONG shape (no `output` guard on its side).
        iframe.respond('mismatch', () => ({ wrong: true }));
        const call = parent.request('mismatch', {
            output: asValidator(z.object({ ok: z.boolean() })),
        });
        // The reply correlates, but the buffered `output` contract rejects it → StitchError (drift).
        await expect(call({ body: {} })).rejects.toMatchObject({
            name: 'StitchError',
        });
        await closeBoth();
    });

    // A plain `Validator` (from `toValidator(...)`) exposes `.validate()` but neither `~standard`
    // nor `safeParse` — the same shape a Zod < 3.24 schema has. `respond` must accept it: the old
    // `passes()` only handled `~standard`, so a Validator threw → was caught → treated as a
    // failure → EVERY inbound request was silently dropped and the requester timed out.
    test('a responder accepts a `toValidator(...)` input schema — a valid payload is NOT dropped', async () => {
        const { parent, iframe, closeBoth } = channelPair();
        // `toValidator` of a defined predicate always yields a Validator — a `{ validate() }`
        // object with NO `~standard` and NO `safeParse` (the exact shape the old `passes` dropped).
        const inputSchema = toValidator(
            (v: unknown): boolean =>
                typeof (v as { n?: unknown }).n === 'number',
        )!;
        expect('~standard' in inputSchema).toBe(false); // pins the bug's precondition
        expect('safeParse' in inputSchema).toBe(false);
        iframe.respond('dbl', (p: { n: number }) => ({ doubled: p.n * 2 }), {
            input: inputSchema,
        });
        const call = parent.request('dbl', {
            timeout: { perAttempt: 200 },
        });
        await expect(call({ body: { n: 21 } })).resolves.toEqual({
            doubled: 42,
        });
        await closeBoth();
    });

    test('a `toValidator(...)` input schema still DROPS an invalid payload (fail-closed preserved)', async () => {
        const { parent, iframe, closeBoth } = channelPair();
        const inputSchema = toValidator(
            (v: unknown): boolean =>
                typeof (v as { n?: unknown }).n === 'number',
        )!;
        iframe.respond('dbl2', (p: { n: number }) => ({ doubled: p.n * 2 }), {
            input: inputSchema,
        });
        const call = parent.request('dbl2', {
            timeout: { perAttempt: 40 },
        });
        await expect(
            call({ body: { n: 'not-a-number' } }),
        ).rejects.toMatchObject({ name: 'StitchError' });
        await closeBoth();
    });

    // `output` rides the same coercion — a `toValidator(...)` responder output that the result
    // satisfies must let the reply through (before the fix it threw in `passes` → no reply posted).
    test('a responder accepts a `toValidator(...)` output schema — a valid reply is posted', async () => {
        const { parent, iframe, closeBoth } = channelPair();
        const outputSchema = toValidator(
            (v: unknown): boolean =>
                typeof (v as { doubled?: unknown }).doubled === 'number',
        )!;
        iframe.respond('dbl3', (p: { n: number }) => ({ doubled: p.n * 2 }), {
            output: outputSchema,
        });
        const call = parent.request('dbl3', {
            timeout: { perAttempt: 200 },
        });
        await expect(call({ body: { n: 5 } })).resolves.toEqual({
            doubled: 10,
        });
        await closeBoth();
    });
});

// ---------------------------------------------------------------------------
// events (streaming surface)
// ---------------------------------------------------------------------------

describe('events (a streaming surface, validated payloads)', () => {
    test('await collects the payloads; ordering is preserved over .stream()', async () => {
        const { parent, iframe, closeBoth } = channelPair();
        const events = parent.events('tick', {
            output: asValidator(z.object({ n: z.number() })),
        });

        const ctl = new AbortController();
        const seen: unknown[] = [];
        const drain = (async () => {
            for await (const e of events.stream({ signal: ctl.signal })) {
                if (e.type === 'delta') {
                    seen.push(e.chunk);
                    if (seen.length === 3) ctl.abort(); // stop after three
                }
            }
        })();

        // Let the subscription register, then emit three ticks IN ORDER from the iframe.
        await new Promise((r) => setTimeout(r, 5));
        for (const n of [1, 2, 3])
            iframe
                .emit('tick')({ body: { n } })
                .catch(() => undefined);

        await drain.catch(() => undefined);
        expect(seen).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]); // contractValue → the payload, in order
        await closeBoth();
    });

    test('await resolves to the collected payload array when the channel closes the stream', async () => {
        const { parent, iframe } = channelPair();
        const events = parent.events('evt');
        // Kick off consumption NOW (`.then` starts the run and registers the subscription via
        // `execute`); the same shared run is what we assert on below. A bare `events()` is lazy.
        const settled = events().then((v) => v);

        await new Promise((r) => setTimeout(r, 5));
        for (const v of ['x', 'y'])
            iframe
                .emit('evt')({ body: v })
                .catch(() => undefined);
        await new Promise((r) => setTimeout(r, 20));
        // Closing the parent ends its live event streams GRACEFULLY → the await resolves to the
        // payloads collected so far (vs. an abort, which errors the stream — tested separately).
        await parent.close();
        await iframe.close();

        await expect(settled).resolves.toEqual(['x', 'y']);
    });

    test('a payload failing the `output` schema fails the stream (the bad event is not delivered)', async () => {
        const { parent, iframe, closeBoth } = channelPair();
        const events = parent.events('num', {
            output: asValidator(z.object({ n: z.number() })),
        });
        const ev = collectEvents(events.stream());
        await new Promise((r) => setTimeout(r, 5));
        iframe
            .emit('num')({ body: { n: 1 } })
            .catch(() => undefined);
        iframe
            .emit('num')({ body: { bad: true } })
            .catch(() => undefined);
        const collected = await ev;
        expect(collected.deltas).toEqual([{ n: 1 }]);
        expect(collected.drifts[0]?.level).toBe('error');
        expect(collected.done?.ok).toBe(false);
        await closeBoth();
    });
});

// ---------------------------------------------------------------------------
// emit (fire-and-forget)
// ---------------------------------------------------------------------------

describe('emit (fire-and-forget)', () => {
    test('B receives the emit via respond; A resolves without awaiting a reply', async () => {
        const { parent, iframe, closeBoth } = channelPair();
        let received: unknown;
        iframe.respond('log', (p) => {
            received = p;
            return null; // a reply nobody is waiting for
        });
        const log = parent.emit('log');
        await expect(log({ body: { msg: 'hello' } })).resolves.toBeUndefined();
        // give the microtask hop time to deliver to the iframe
        await new Promise((r) => setTimeout(r, 5));
        expect(received).toEqual({ msg: 'hello' });
        await closeBoth();
    });

    test('emit is also observable as an inbound event on the peer', async () => {
        const { parent, iframe, closeBoth } = channelPair();
        const events = iframe.events('beacon');
        const ctl = new AbortController();
        const seen: unknown[] = [];
        const drain = (async () => {
            for await (const e of events.stream({ signal: ctl.signal })) {
                if (e.type === 'delta') {
                    seen.push(e.chunk);
                    ctl.abort();
                }
            }
        })();
        await new Promise((r) => setTimeout(r, 5));
        await parent.emit('beacon')({ body: { hit: 1 } });
        await drain.catch(() => undefined);
        expect(seen).toEqual([{ hit: 1 }]);
        await closeBoth();
    });
});

// ---------------------------------------------------------------------------
// abort + close lifecycle
// ---------------------------------------------------------------------------

describe('abort + close', () => {
    test('aborting the call signal rejects the pending request and leaves no dangling entry', async () => {
        const { parent, closeBoth } = channelPair();
        const call = parent.request('never-answered');
        const ctl = new AbortController();
        const p = call({ body: {}, signal: ctl.signal });
        ctl.abort();
        await expect(p).rejects.toMatchObject({ name: 'StitchError' });
        // A second, independently-aborted call also rejects — proving the pending map didn't wedge.
        const ctl2 = new AbortController();
        const p2 = call({ body: {}, signal: ctl2.signal });
        ctl2.abort();
        await expect(p2).rejects.toMatchObject({ name: 'StitchError' });
        await closeBoth();
    });

    test('close() rejects in-flight pending requests and detaches the listener', async () => {
        // Drive a channel over a transport whose post never echoes — the request stays pending until
        // close() rejects it. Closing also unsubscribes (a later inbound message reaches nobody).
        let delivered = 0;
        let detached = false;
        const transport: MessageTransport = {
            post: () => {
                delivered += 1;
            },
            subscribe: () => () => {
                detached = true;
            },
        };
        const ch = channel(transport, { allowedOrigins: [ORIGIN_B] });
        const call = ch.request('pending');
        // A stitch is lazy — start consuming so `execute` actually posts and registers the pending
        // entry, then let the resilience chain reach the transport before closing.
        const p = call({ body: {} });
        p.catch(() => undefined); // begin the run
        await new Promise((r) => setTimeout(r, 10));
        expect(delivered).toBe(1); // the request was posted once before close
        await ch.close();
        await expect(p).rejects.toThrow(/closed/);
        expect(detached).toBe(true); // close() detached the demux listener
    });
});

// ---------------------------------------------------------------------------
// windowChannel / portChannel guards
// ---------------------------------------------------------------------------

describe('windowChannel guards', () => {
    test("targetOrigin '*' throws at runtime (defense in depth beyond the Origin type)", () => {
        const fakeWindow = {
            postMessage: () => undefined,
        } as unknown as Window;
        expect(() =>
            windowChannel({
                target: fakeWindow,
                // The Origin type forbids '*'; cast to prove the RUNTIME guard also bites.
                targetOrigin: '*' as unknown as `https://${string}`,
            }),
        ).toThrow(/'\*'/);
    });

    test('windowChannel posts to the resolved target with the bound origin', async () => {
        const posts: { msg: unknown; origin: string }[] = [];
        const fakeWindow = {
            postMessage: (msg: unknown, origin: string) => {
                posts.push({ msg, origin });
            },
        } as unknown as Window;
        // A thunk target is resolved per post (the natural shape when the frame mounts late).
        const ch = windowChannel({
            target: () => fakeWindow,
            targetOrigin: 'https://app.example.com',
        });
        // Fire-and-forget so no reply is awaited; we only assert the post shape.
        await ch.emit('hi')({ body: { a: 1 } });
        expect(posts).toHaveLength(1);
        expect(posts[0]?.origin).toBe('https://app.example.com');
        expect(posts[0]?.msg).toMatchObject({ type: 'hi', payload: { a: 1 } });
        await ch.close();
    });
});

describe('portChannel (origin gating bypassed for ports)', () => {
    test('a MessagePort channel does an RPC round-trip with no origin', async () => {
        const mc = new MessageChannel();
        const parent = portChannel(mc.port1);
        const worker = portChannel(mc.port2);
        worker.respond<{ x: number }, { y: number }>('double', ({ x }) => ({
            y: x * 2,
        }));
        const dbl = parent.request('double');
        await expect(dbl({ body: { x: 21 } })).resolves.toEqual({ y: 42 });
        await parent.close();
        await worker.close();
    });
});

// ---------------------------------------------------------------------------
// the raw `channel` builder over a fake transport (the core path the others delegate to)
// ---------------------------------------------------------------------------

describe('channel() over an arbitrary transport', () => {
    test('an empty allowedOrigins over an origin-bearing transport fails closed (drops everything)', async () => {
        const { a, b } = linkedPair(ORIGIN_A, ORIGIN_B);
        const parent = channel(a, { allowedOrigins: [] }); // allow NOTHING
        const iframe = channel(b, { allowedOrigins: [ORIGIN_A] });
        iframe.respond('x', () => 'ok');
        const call = parent.request('x', { timeout: { perAttempt: 40 } });
        // The iframe's reply carries origin ORIGIN_B, which is not in [] → dropped → times out.
        await expect(call({ body: {} })).rejects.toMatchObject({
            name: 'StitchError',
        });
        await parent.close();
        await iframe.close();
    });
});

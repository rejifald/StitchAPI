// The `postmessage` surface (ADR 0009): a typed, validated, observable wrapper over browser
// `postMessage` RPC + events. These specs drive the WHOLE surface over an in-memory LINKED
// TRANSPORT PAIR — two `MessageTransport`s wired to each other, each carrying a configurable
// `origin` — simulating parent↔iframe with zero DOM. The four verbs (request/emit/events/respond),
// the origin gate, validation, timeout/abort, and `close()` are all exercised through it.
import {
    type ChannelOptions,
    type MessageTransport,
    type Origin,
    type PostMessageChannel,
    type WindowChannelOptions,
    channel,
    postMessageEventSurface,
    postMessageSurface,
} from '../src/postmessage';
import type { Adapter } from '../src/types';
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
    const parent = channel.over(a, { from: [ORIGIN_B] });
    // A single origin passes as a bare string (`T | T[]` — CONTRACT.md P7).
    const iframe = channel.over(b, { from: ORIGIN_A });
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
        const parent = channel.over(a, { from: [ORIGIN_B] });
        const iframe = channel.over(b, { from: [ORIGIN_A] });
        // The iframe emits an UNSOLICITED `sum-result` (no id) BEFORE any responder — it must NOT
        // resolve the pending request (whose reply correlates on the minted id too).
        const sum = parent.request('sum', {
            timeout: { each: 60 },
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
            timeout: { each: 40 },
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
        const parent = channel.over(a, { from: [ORIGIN_B] }); // only the REAL iframe origin
        const evil = channel.over(b, { from: [ORIGIN_A] });
        evil.respond('sum', () => ({ total: 999 }));
        const sum = parent.request('sum', {
            timeout: { each: 40 },
        });
        await expect(sum({ body: { a: 1, b: 2 } })).rejects.toMatchObject({
            name: 'StitchError',
        });
        await parent.close();
        await evil.close();
    });

    test('an event from a disallowed origin is never delivered', async () => {
        const { a, b } = linkedPair(ORIGIN_A, 'https://evil.example.com');
        const parent = channel.over(a, { from: [ORIGIN_B] });
        const evil = channel.over(b, { from: [ORIGIN_A] });
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

    test('an origin outside the policy is dropped BEFORE dispatch or validation', async () => {
        // The security bar (ADR 0009 Decision 5), pinned positively rather than by a timeout: a
        // message from a disallowed origin must not reach the responder's INPUT VALIDATOR, let
        // alone its handler. A validator that records every value it is handed proves the gate
        // runs first — an implementation that validated then gated would tick the counter.
        const { a, b } = linkedPair(ORIGIN_A, 'https://evil.example.com');
        const parent = channel.over(a, { from: [ORIGIN_B] }); // only the REAL iframe origin
        const evil = channel.over(b, { from: [ORIGIN_A] });
        const validated: unknown[] = [];
        const handled: unknown[] = [];
        parent.respond(
            'ping',
            (p) => {
                handled.push(p);
                return 'pong';
            },
            {
                input: (v: unknown): boolean => {
                    validated.push(v);
                    return true;
                },
            },
        );
        const ping = evil.request('ping', { timeout: { each: 40 } });
        await expect(ping({ body: { n: 1 } })).rejects.toMatchObject({
            name: 'StitchError',
        });
        expect(validated).toEqual([]); // the validator never saw it
        expect(handled).toEqual([]); // and neither did the handler
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
            timeout: { each: 40 },
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
            timeout: { each: 200 },
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
            timeout: { each: 40 },
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
            timeout: { each: 200 },
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
        const ch = channel.over(transport, { from: [ORIGIN_B] });
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
// channel.window / channel.port guards
// ---------------------------------------------------------------------------

const fakeWindow = (posts: { msg: unknown; origin: string }[]): Window =>
    ({
        postMessage: (msg: unknown, origin: string) => {
            posts.push({ msg, origin });
        },
    }) as unknown as Window;

// `channel.window` subscribes to the GLOBAL `'message'` event, so the only way to exercise its
// INBOUND gate is to capture the listeners it installs and synthesise `MessageEvent`s at chosen
// origins. Asserting on what a channel POSTS can never see that half: the outbound address comes
// from `origins.to` alone, so a gate that quietly narrowed back to `[to]` would keep every
// post-shape assertion green. Restores the real (possibly undefined) globals afterwards.
interface EventTargetish {
    addEventListener:
        ((t: string, l: (e: MessageEvent) => void) => void) | undefined;
    removeEventListener:
        ((t: string, l: (e: MessageEvent) => void) => void) | undefined;
}

const withMessageListeners = async (
    body: (
        deliver: (origin: string, data: unknown, source?: unknown) => void,
    ) => Promise<void>,
): Promise<void> => {
    const listeners = new Set<(e: MessageEvent) => void>();
    const g = globalThis as unknown as EventTargetish;
    const realAdd = g.addEventListener;
    const realRemove = g.removeEventListener;
    g.addEventListener = (t, l) => {
        if (t === 'message') listeners.add(l);
    };
    g.removeEventListener = (t, l) => {
        if (t === 'message') listeners.delete(l);
    };
    try {
        await body((origin, data, source) => {
            // `isTrusted: true` models USER-AGENT delivery, which is what a real
            // `window.postMessage` from the peer frame produces. It is required now, and the fact
            // that it is required is the signal the `isTrusted` gate is live: `channel.window`
            // drops a synthesised event (`isTrusted === false`) before the origin gate runs,
            // because `MessageEventInit.origin` is author-settable and the origin gate therefore
            // cannot tell a forgery from the real thing. The forged half is exercised against a
            // REAL `EventTarget` + REAL `MessageEvent` in `withRealMessageTarget` below.
            //
            // `source` is OMITTED unless a caller passes one, which is itself under test: the
            // listener tolerates an ABSENT source (a non-DOM global, an SSR pass, a polyfill —
            // the same tolerance `isTrusted === false` has) and gates a PRESENT one. The
            // same-realm `window.postMessage` forgery — trusted, allow-listed origin, wrong
            // source — is the `source`-carrying case below.
            for (const l of [...listeners])
                l(
                    (source === undefined
                        ? { data, origin, isTrusted: true }
                        : {
                              data,
                              origin,
                              isTrusted: true,
                              source,
                          }) as MessageEvent,
                );
        });
    } finally {
        g.addEventListener = realAdd;
        g.removeEventListener = realRemove;
    }
};

// Let every listener run and the responder's async answer settle.
const settle = (): Promise<void> =>
    new Promise((r) =>
        setTimeout(() => {
            r();
        }, 10),
    );

// ---------------------------------------------------------------------------
// the forged-event attacker path (the in-band `''` sentinel regression)
// ---------------------------------------------------------------------------
// `withMessageListeners` above fakes `addEventListener` and hands the listener an object literal,
// which is the right tool for asserting WHICH origins the gate admits but the wrong one for the
// attack: an attacker does not get to choose the event's internals. This harness installs a REAL
// `EventTarget` as the global message target, so the test dispatches a REAL `MessageEvent` exactly
// as a script sharing the page's realm would:
//
//     window.dispatchEvent(new MessageEvent('message', { data: forged, origin: TRUSTED }))
//
// Everything about that event is then the platform's, not the test's — in particular `origin` and
// `isTrusted`, which is precisely what is under test.
interface RealTargetHandle {
    dispatch: (init: MessageEventInit) => void;
}

const withRealMessageTarget = async (
    body: (handle: RealTargetHandle) => Promise<void>,
): Promise<void> => {
    const target = new EventTarget();
    const g = globalThis as unknown as EventTargetish;
    const realAdd = g.addEventListener;
    const realRemove = g.removeEventListener;
    g.addEventListener = (t, l) => {
        target.addEventListener(t, l as unknown as EventListener);
    };
    g.removeEventListener = (t, l) => {
        target.removeEventListener(t, l as unknown as EventListener);
    };
    try {
        await body({
            dispatch: (init) => {
                target.dispatchEvent(new MessageEvent('message', init));
            },
        });
    } finally {
        g.addEventListener = realAdd;
        g.removeEventListener = realRemove;
    }
};

describe('the origin gate has no in-band sentinel (security regression)', () => {
    // The PLATFORM facts the whole fix rests on, pinned rather than asserted in a comment. If any
    // of these ever changes, the sentinel argument below changes with it.
    test('MessageEvent cannot spell the out-of-band sentinel, and defaults to the old in-band one', () => {
        // `origin` is a USVString: there is no way to deliver a JS `null` through it. The casts
        // are the point, not noise — `MessageEventInit.origin` is typed `string`, so these two
        // shapes are what a JS caller or an `as any` produces, and the WebIDL coercion is what
        // makes the out-of-band sentinel unspellable from data.
        expect(
            new MessageEvent('message', {
                origin: null,
            } as unknown as MessageEventInit).origin,
        ).toBe('null'); // the STRING — not an `Origin`, so it stays unallow-listable
        expect(
            new MessageEvent('message', {
                origin: undefined,
            } as unknown as MessageEventInit).origin,
        ).toBe('');
        // …and `''` is its DEFAULT, which is exactly why `''` could never be a trust signal.
        expect(new MessageEvent('message', {}).origin).toBe('');
        // `isTrusted` is `[LegacyUnforgeable]`: `false` on a constructed event, and the init dict
        // cannot set it. This is the only bit a same-realm script cannot forge.
        expect(new MessageEvent('message', {}).isTrusted).toBe(false);
        expect(
            new MessageEvent('message', {
                isTrusted: true,
            } as MessageEventInit).isTrusted,
        ).toBe(false);
    });

    // THE DEFECT, at the `channel.over` layer where no `isTrusted` gate exists to mask it: the gate
    // used to read `origin === '' || allowed.includes(origin)`, so a message stamped `''` was waved
    // through on ANY channel. `''` is now an ordinary untrusted string.
    test('an inbound message stamped with the empty origin is DROPPED on a gated channel', async () => {
        const seen: unknown[] = [];
        const validated: unknown[] = [];
        let handler:
            ((data: unknown, origin: string | null) => void) | undefined;
        const transport: MessageTransport = {
            post: () => undefined,
            subscribe: (h) => {
                handler = h;
                return () => undefined;
            },
        };
        const ch = channel.over(transport, { from: [ORIGIN_B] });
        ch.respond(
            'ping',
            (p) => {
                seen.push(p);
                return 'pong';
            },
            {
                // Proves the gate runs FIRST: an implementation that validated then gated would
                // tick this counter even while dropping the message.
                input: (v: unknown): boolean => {
                    validated.push(v);
                    return true;
                },
            },
        );
        handler?.({ type: 'ping', id: '1', payload: { n: 1 } }, '');
        await settle();
        expect(seen).toEqual([]);
        expect(validated).toEqual([]);
        await ch.close();
    });

    // The sibling of the above: the literal `'null'` a sandboxed frame posts with is likewise just
    // a string, and is NOT the out-of-band sentinel.
    test("the literal origin 'null' is DROPPED and is not the sentinel", async () => {
        const seen: unknown[] = [];
        let handler:
            ((data: unknown, origin: string | null) => void) | undefined;
        const ch = channel.over(
            {
                post: () => undefined,
                subscribe: (h) => {
                    handler = h;
                    return () => undefined;
                },
            },
            { from: [ORIGIN_B] },
        );
        ch.respond('ping', (p) => {
            seen.push(p);
            return 'pong';
        });
        handler?.({ type: 'ping', payload: { n: 1 } }, 'null');
        await settle();
        expect(seen).toEqual([]);
        await ch.close();
    });

    // The allow-list must not be inert — the #795 / P24 carve-out (b) bar. A transport's
    // per-message "I have no origins" claim CANNOT widen a channel the caller gated, so it fails
    // closed. `from: []` is the sharpest case: a deliberately fail-closed list stays fail-closed.
    test.each([
        ['a populated list', [ORIGIN_B] as const],
        ['the deliberately empty list', [] as const],
    ])(
        'a transport passing `null` is DROPPED on a channel gated by %s',
        async (_label, from) => {
            const seen: unknown[] = [];
            let handler:
                ((data: unknown, origin: string | null) => void) | undefined;
            const ch = channel.over(
                {
                    post: () => undefined,
                    subscribe: (h) => {
                        handler = h;
                        return () => undefined;
                    },
                },
                { from: [...from] },
            );
            ch.respond('ping', (p) => {
                seen.push(p);
                return 'pong';
            });
            handler?.({ type: 'ping', payload: { n: 1 } }, null);
            await settle();
            expect(seen).toEqual([]);
            await ch.close();
        },
    );

    // The policy is bound at CONSTRUCTION, not ALIASED. `originList` used to hand `makeChannel`
    // the CALLER's array when one was passed, and the gate closed over it — so `allowed.push(…)`
    // retargeted a live channel, and `allowed.length = 0` silently fail-closed a working one.
    // The sharper half is the second assertion: an entry added afterwards skipped `assertOrigin`
    // entirely, so the gate honoured a string the constructor itself rejects. Not wire-reachable
    // — it takes the app mutating its own config array — but the file's first paragraph and
    // `PostMessageChannel`'s docblock both promise binding ONCE at construction, and this is what
    // makes that promise true.
    test('mutating the array passed as `from` after construction cannot retarget the gate', async () => {
        const allowed: Origin[] = [ORIGIN_B];
        const seen: unknown[] = [];
        let handler:
            ((data: unknown, origin: string | null) => void) | undefined;
        const ch = channel.over(
            {
                post: () => undefined,
                subscribe: (h) => {
                    handler = h;
                    return () => undefined;
                },
            },
            { from: allowed },
        );
        ch.respond('ping', (p) => {
            seen.push(p);
            return 'pong';
        });

        // (1) a widening push does not widen the gate…
        allowed.push(ORIGIN_A);
        handler?.({ type: 'ping', payload: { n: 1 } }, ORIGIN_A);
        // (2) …and an entry the CONSTRUCTOR would have thrown on is not honoured either. The cast
        //     is the point: `channel.over(t, { from: 'not-an-origin' })` throws, so a gate that
        //     accepted this string was routing around its own validation.
        allowed.push('not-an-origin' as unknown as Origin);
        handler?.({ type: 'ping', payload: { n: 2 } }, 'not-an-origin');
        await settle();
        expect(seen).toEqual([]);

        // (3) …and emptying it cannot fail-close a channel that was built open.
        allowed.length = 0;
        handler?.({ type: 'ping', payload: { n: 3 } }, ORIGIN_B);
        await settle();
        expect(seen).toEqual([{ n: 3 }]);
        await ch.close();
    });

    // …and the exemption still WORKS where it is declared in code. `channel.private` takes no
    // origin policy at all, so a `null`-origin message is delivered. This is the port bypass made
    // provable without a real `MessagePort`.
    test('an UNGATED channel (`channel.private`) delivers a `null`-origin message', async () => {
        const seen: unknown[] = [];
        let handler:
            ((data: unknown, origin: string | null) => void) | undefined;
        const ch = channel.private({
            post: () => undefined,
            subscribe: (h) => {
                handler = h;
                return () => undefined;
            },
        });
        ch.respond('ping', (p) => {
            seen.push(p);
            return 'pong';
        });
        handler?.({ type: 'ping', payload: { n: 1 } }, null);
        await settle();
        expect(seen).toEqual([{ n: 1 }]);
        await ch.close();
    });

    // THE HEADLINE REGRESSION — the attack itself, on the real `channel.window` inbound path, with
    // a real `MessageEvent` dispatched at a real `EventTarget`. Before this commit both variants
    // reached the responder and the reply correlation: `origin: ''` slipped the in-band sentinel,
    // and `origin: <allow-listed>` slipped the literal `includes` because `MessageEventInit.origin`
    // is author-settable. Now neither does.
    //
    // WHAT THESE TWO CASES DO AND DO NOT DISCRIMINATE, stated because the labels alone mislead
    // and mutation testing is what settles it. `withRealMessageTarget` dispatches a CONSTRUCTED
    // `MessageEvent`: its `isTrusted` is always `false` AND its `source` defaults to `null`, so
    // `channel.window` returns twice over before the origin gate is reached. Mutation-checked:
    // restoring `origin === '' ||` in `makeChannel`'s gate leaves BOTH variants green (only the
    // `channel.over` test above goes red), and so does removing the `isTrusted` guard (the peer
    // check drops the same events). These are end-to-end assertions that the real attack reaches
    // NOTHING — worth having, since they drive every demux path at once — but they pin no single
    // guard. Each guard's own discriminating test is elsewhere: the gate's is the `channel.over`
    // case above, where no `isTrusted` guard exists to mask it; `isTrusted`'s is the
    // peer-as-`source` case below; the peer check's is the same-origin `window.postMessage` case
    // below.
    test.each([
        ['the empty origin (defence in depth: `isTrusted` drops it first)', ''],
        ['a correctly-spelled allow-listed origin', 'https://app.example.com'],
    ])(
        'a same-realm forged MessageEvent carrying %s reaches nothing',
        async (_label, forgedOrigin) => {
            await withRealMessageTarget(async ({ dispatch }) => {
                const posts: { msg: unknown; origin: string }[] = [];
                const ch = channel.window({
                    target: fakeWindow(posts),
                    origins: 'https://app.example.com',
                });

                const handled: unknown[] = [];
                ch.respond('delete-account', (p) => {
                    handled.push(p);
                    return { deleted: true };
                });

                // A real in-flight request, so the forged REPLY path is covered too: an attacker
                // who guesses (or reads) the minted id must not be able to resolve it.
                const events: unknown[] = [];
                const sub = ch.events('price-tick');
                const drain = (async () => {
                    for await (const e of sub.stream()) {
                        if (e.type === 'delta') events.push(e.chunk);
                    }
                })();
                drain.catch(() => undefined);

                let settled: unknown = 'NOT-SETTLED';
                const pending = ch.request('slow', { timeout: { each: 60 } });
                const p = pending({ body: {} }).then(
                    (v) => (settled = { ok: v }),
                    () => (settled = 'REJECTED'),
                );
                await settle();
                const sent = posts.find(
                    (x) => (x.msg as { type?: string }).type === 'slow',
                );
                const mintedId = (sent?.msg as { id?: string } | undefined)?.id;
                expect(typeof mintedId).toBe('string');

                const postsBefore = posts.length;

                // === the attack: three forged envelopes, one per demux path ===
                dispatch({
                    data: {
                        type: 'delete-account',
                        id: 'a1',
                        payload: { all: true },
                    },
                    origin: forgedOrigin,
                });
                dispatch({
                    data: { type: 'price-tick', payload: { px: 999 } },
                    origin: forgedOrigin,
                });
                dispatch({
                    data: {
                        type: 'slow-result',
                        id: mintedId,
                        payload: { pwned: true },
                    },
                    origin: forgedOrigin,
                });
                await settle();

                // No responder ran, and nothing was posted in reply.
                expect(handled).toEqual([]);
                expect(posts.length).toBe(postsBefore);
                // No event delta was delivered.
                expect(events).toEqual([]);
                // No pending request resolved — it is still in flight, and goes on to reject via
                // the engine's own timeout rather than resolving with the attacker's payload.
                expect(settled).toBe('NOT-SETTLED');

                await p;
                expect(settled).toBe('REJECTED');
                await ch.close();
                await drain.catch(() => undefined);
            });
        },
    );

    // The `isTrusted` guard's OWN discriminating coverage. Every forgery above is now stopped by
    // the peer check as well — a constructed `MessageEvent`'s `source` defaults to `null`, which
    // fails closed — so nothing above can tell which guard did the work. Here the forged event
    // ALSO spells the right source: the channel's target is a real `MessagePort` (its
    // `postMessage` is the only thing the transport asks of a target, and a `MessagePort` is the
    // one `source` value a constructed `MessageEvent` accepts outside a DOM). Origin allow-listed,
    // source correct — `isTrusted` is all that is left, and it is the one bit a page script
    // cannot spell.
    test("a synthesised event naming the channel's own peer as `source` is still dropped", async () => {
        const pair = new MessageChannel();
        try {
            await withRealMessageTarget(async ({ dispatch }) => {
                const ch = channel.window({
                    target: pair.port1 as unknown as Window,
                    origins: 'https://app.example.com',
                });
                const handled: unknown[] = [];
                ch.respond('delete-account', (p) => {
                    handled.push(p);
                    return { deleted: true };
                });
                dispatch({
                    data: {
                        type: 'delete-account',
                        id: 'a1',
                        payload: { all: true },
                    },
                    origin: 'https://app.example.com',
                    source: pair.port1,
                });
                await settle();
                expect(handled).toEqual([]);
                await ch.close();
            });
        } finally {
            pair.port1.close();
            pair.port2.close();
        }
    });

    // The other half of the same gate: a REAL user-agent delivery is unaffected. Node cannot mint
    // an `isTrusted: true` event through `dispatchEvent`, so this half rides the object-literal
    // harness — which is exactly why that harness now stamps `isTrusted: true`.
    test('a genuine user-agent delivery on the same channel still arrives', async () => {
        await withMessageListeners(async (deliver) => {
            const ch = channel.window({
                target: fakeWindow([]),
                origins: 'https://app.example.com',
            });
            const handled: unknown[] = [];
            ch.respond('delete-account', (p) => {
                handled.push(p);
                return { deleted: true };
            });
            deliver('https://app.example.com', {
                type: 'delete-account',
                id: 'real',
                payload: { all: true },
            });
            await settle();
            expect(handled).toEqual([{ all: true }]);
            await ch.close();
        });
    });

    // THE VECTOR `isTrusted` DOES NOT CLOSE — and the reason the peer check exists. A script
    // sharing the page's realm can skip `dispatchEvent` entirely and call the REAL
    // `window.postMessage(forged, '*')`. The user agent then delivers a genuinely trusted event
    // stamped with the CALLING document's own origin, so `isTrusted` is really `true` and the
    // origin really is the page's. Cross-origin that is harmless (the attacker's origin is not on
    // the list); with a SAME-ORIGIN peer — `origins: location.origin`, which is what the scalar
    // shorthand means when parent and frame share an origin — it is allow-listed, and before the
    // `source` check both guards waved it through. The extension content script ADR 0009 names is
    // exactly this actor: isolated world, so it cannot call the page's handlers, but its
    // `postMessage` arrives with the page's origin and `isTrusted === true`.
    //
    // The OBJECT-LITERAL harness is the right one here precisely because the event under test is
    // GENUINE: `isTrusted: true` is what user-agent delivery looks like and Node cannot mint one
    // through `dispatchEvent`. What is forged is the SOURCE WINDOW, which is the whole point.
    test('a same-origin `window.postMessage` forgery — trusted, allow-listed, wrong `source` — reaches nothing', async () => {
        await withMessageListeners(async (deliver) => {
            const posts: { msg: unknown; origin: string }[] = [];
            const peer = fakeWindow(posts); // the iframe this channel talks to
            const attacker = fakeWindow([]); // any other window in the same realm
            const ch = channel.window({
                target: peer,
                origins: 'https://app.example.com',
            });

            const handled: unknown[] = [];
            ch.respond('delete-account', (p) => {
                handled.push(p);
                return { deleted: true };
            });
            const events: unknown[] = [];
            const sub = ch.events('price-tick');
            const drain = (async () => {
                for await (const e of sub.stream()) {
                    if (e.type === 'delta') events.push(e.chunk);
                }
            })();
            drain.catch(() => undefined);
            await settle();
            const postsBefore = posts.length;

            const forged = {
                type: 'delete-account',
                id: 'atk',
                payload: { user: 'victim' },
            };
            deliver('https://app.example.com', forged, attacker);
            deliver(
                'https://app.example.com',
                { type: 'price-tick', payload: { px: 999 } },
                attacker,
            );
            await settle();
            expect(handled).toEqual([]);
            expect(events).toEqual([]);
            expect(posts.length).toBe(postsBefore);

            // …and the SAME envelope from the channel's REAL peer is delivered. That is what makes
            // this a test of the peer check rather than of the origin gate: origin, `isTrusted`
            // and payload are byte-identical across the two deliveries, and only `source` differs.
            deliver('https://app.example.com', forged, peer);
            await settle();
            expect(handled).toEqual([{ user: 'victim' }]);

            await ch.close();
            await drain.catch(() => undefined);
        });
    });

    // The three states of `source`, pinned. `null` is a REAL event whose source browsing context
    // is gone (or a DOM that does not attribute sources — jsdom) and cannot BE the peer, so it
    // fails closed, the same reading the origin gate gives its own `null`. ABSENT is an
    // environment that has no such property at all, and must not be gated out of its own channel
    // — the tolerance `isTrusted === false` has, and the state every other delivery in this file
    // exercises by omitting the argument.
    test.each([
        ['`null` (a dead browsing context) fails closed', null, []],
        ['ABSENT (a non-DOM environment) is tolerated', undefined, [{ n: 1 }]],
    ])(
        'a trusted, allow-listed event whose `source` is %s',
        async (_label, source, expected) => {
            await withMessageListeners(async (deliver) => {
                const peer = fakeWindow([]);
                const ch = channel.window({
                    target: peer,
                    origins: 'https://app.example.com',
                });
                const handled: unknown[] = [];
                ch.respond('ping', (p) => {
                    handled.push(p);
                    return 'pong';
                });
                // Passing `undefined` IS omitting the property — the helper keys the two states off
                // exactly that, so `null` must be passed through rather than coalesced away.
                deliver(
                    'https://app.example.com',
                    { type: 'ping', id: 'x', payload: { n: 1 } },
                    source,
                );
                await settle();
                expect(handled).toEqual(expected);
                await ch.close();
            });
        },
    );
});

describe('channel.window guards', () => {
    test('a wildcard origin throws at runtime, through the scalar shorthand (defense in depth beyond the Origin type)', () => {
        expect(
            () =>
                channel.window({
                    target: fakeWindow([]),
                    // The Origin type forbids '*'; cast to prove the RUNTIME guard also bites.
                    origins: '*' as unknown as `https://${string}`,
                }),
            // The SLOT is the property the caller wrote — `origins`. The shorthand normalises to
            // `{ to: X }` internally, but an error naming `origins.to` sends a caller looking for
            // a key that is absent from their source. Pinned here because nothing else does.
        ).toThrow(/wildcard origin is forbidden in `origins`, got '\*'/);
    });

    test('a wildcard origin throws through the explicit envelope too, naming the half that is wrong', () => {
        expect(() =>
            channel.window({
                target: fakeWindow([]),
                origins: { to: '*' as unknown as `https://${string}` },
            }),
        ).toThrow(/wildcard origin is forbidden in `origins\.to`, got '\*'/);
        expect(
            () =>
                channel.window({
                    target: fakeWindow([]),
                    origins: {
                        to: 'https://app.example.com',
                        // The Origin TYPE cannot forbid this one — a `*` pattern satisfies
                        // `https://${string}` — and the gate's literal `includes` would silently
                        // match nothing, dropping every inbound message. The runtime guard is what
                        // makes it loud.
                        from: 'https://*.example.com',
                    },
                }),
            // Echoes the PATTERN the caller actually wrote. A message that only quotes a bare
            // '*' names a string absent from their source, and reads as a different mistake.
        ).toThrow(
            /wildcard origin is forbidden in `origins\.from`, got 'https:\/\/\*\.example\.com'/,
        );
    });

    test('a missing origin policy is the directed construction error, not an opaque TypeError', () => {
        // Exactly the shape a call site still spelling the pre-envelope `targetOrigin` /
        // `allowedOrigins` produces. TypeScript rejects it, but a JS caller, an `as any`, a stale
        // `.d.ts`, or options round-tripped through JSON all reach the constructor without the
        // policy — and this file's whole thesis is that construction fails LOUD, which an
        // undefined dereference two lines later does not honour.
        const staleWindowOpts = {
            target: fakeWindow([]),
            targetOrigin: 'https://app.example.com',
        } as unknown as WindowChannelOptions;
        expect(() => channel.window(staleWindowOpts)).toThrow(
            /`origins` is required/,
        );
        // Specifically NOT `TypeError: Cannot read properties of undefined (reading 'to')`.
        expect(() => channel.window(staleWindowOpts)).not.toThrow(TypeError);

        const staleChannelOpts = {
            allowedOrigins: ['https://app.example.com'],
        } as unknown as ChannelOptions;
        const transport: MessageTransport = {
            post: () => undefined,
            subscribe: () => () => undefined,
        };
        // Each builder names the slot the CALLER would have written, not a shared one: `channel`
        // takes the inbound half as `from`, so an error naming `origins` would send them looking
        // for a key that does not exist on `ChannelOptions` at all.
        expect(() => channel.over(transport, staleChannelOpts)).toThrow(
            /`from` is required/,
        );
        expect(() => channel.over(transport, staleChannelOpts)).not.toThrow(
            TypeError,
        );

        // Same for an envelope that names only the inbound half: the missing `to` names its own
        // slot instead of dying on `.includes` of undefined.
        expect(() =>
            channel.window({
                target: fakeWindow([]),
                origins: { from: 'https://app.example.com' },
            } as unknown as WindowChannelOptions),
        ).toThrow(/`origins\.to` must be a bare origin string.*got undefined/);
    });

    test('a non-bare origin is rejected at construction rather than silently matching nothing', () => {
        const nonBare = [
            'https://app.example.com/', // trailing slash
            'https://App.Example.com', // upper-cased host
            'https://app.example.com:443', // explicit default port
        ] as `https://${string}`[];
        for (const origin of nonBare) {
            expect(() =>
                channel.window({ target: fakeWindow([]), origins: origin }),
            ).toThrow(/bare origin/);
        }
        // The error names the normalised spelling AND the slot the caller wrote, so the fix is
        // in the message: the shorthand reports `origins`…
        expect(() =>
            channel.window({
                target: fakeWindow([]),
                origins: 'https://app.example.com/',
            }),
        ).toThrow(
            /`origins` must be a bare origin.*did you mean 'https:\/\/app\.example\.com'/,
        );
        // …and the envelope reports the half that is wrong, on either half.
        expect(() =>
            channel.window({
                target: fakeWindow([]),
                origins: { to: 'https://app.example.com/' },
            }),
        ).toThrow(/`origins\.to` must be a bare origin/);
        expect(() =>
            channel.window({
                target: fakeWindow([]),
                origins: {
                    to: 'https://app.example.com',
                    from: ['https://app.example.com:443'],
                },
            }),
        ).toThrow(/`origins\.from` must be a bare origin/);
    });

    test('channel.window posts to the resolved target with the bound origin', async () => {
        const posts: { msg: unknown; origin: string }[] = [];
        const target = fakeWindow(posts);
        // A thunk target is resolved per post (the natural shape when the frame mounts late).
        const ch = channel.window({
            target: () => target,
            origins: 'https://app.example.com',
        });
        // Fire-and-forget so no reply is awaited; we only assert the post shape.
        await ch.emit('hi')({ body: { a: 1 } });
        expect(posts).toHaveLength(1);
        expect(posts[0]?.origin).toBe('https://app.example.com');
        expect(posts[0]?.msg).toMatchObject({ type: 'hi', payload: { a: 1 } });
        await ch.close();
    });

    test('the scalar shorthand IS `{ to: X, from: [X] }` — same outbound address, same gate', async () => {
        // Same fake global for both, so the two channels see the same inbound stream. The
        // shorthand and the explicit envelope must agree on BOTH halves: where posts go, and
        // which inbound origins survive the gate.
        await withMessageListeners(async (deliver) => {
            const shorthandPosts: { msg: unknown; origin: string }[] = [];
            const envelopePosts: { msg: unknown; origin: string }[] = [];
            const shorthand = channel.window({
                target: fakeWindow(shorthandPosts),
                origins: 'https://app.example.com',
            });
            const envelope = channel.window({
                target: fakeWindow(envelopePosts),
                origins: {
                    to: 'https://app.example.com',
                    from: ['https://app.example.com'],
                },
            });

            // Outbound: identical target origin.
            await shorthand.emit('hi')({ body: { a: 1 } });
            await envelope.emit('hi')({ body: { a: 1 } });
            expect(shorthandPosts).toEqual(envelopePosts);

            // Inbound: identical gate. Both accept the policy origin…
            const seenShorthand: unknown[] = [];
            const seenEnvelope: unknown[] = [];
            shorthand.respond('probe', (p) => {
                seenShorthand.push(p);
                return null;
            });
            envelope.respond('probe', (p) => {
                seenEnvelope.push(p);
                return null;
            });
            deliver('https://app.example.com', {
                type: 'probe',
                id: 'x',
                payload: { ok: 1 },
            });
            await settle();
            expect(seenShorthand).toEqual([{ ok: 1 }]);
            expect(seenEnvelope).toEqual(seenShorthand);

            // …and both drop anything else.
            deliver('https://evil.example.com', {
                type: 'probe',
                id: 'y',
                payload: { ok: 2 },
            });
            await settle();
            expect(seenShorthand).toEqual([{ ok: 1 }]);
            expect(seenEnvelope).toEqual(seenShorthand);

            await shorthand.close();
            await envelope.close();
        });
    });

    // `from` widens the ORIGINS one window may answer from, never the set of windows: a window
    // channel is bound to its `target` (see the peer-binding block below). So every delivery here
    // comes from that one window — a frame that moves between the app and widget origins.
    test('`from` widens the inbound gate without widening the outbound address', async () => {
        await withMessageListeners(async (deliver) => {
            const posts: { msg: unknown; origin: string }[] = [];
            const frame = fakeWindow(posts);
            const ch = channel.window({
                target: frame,
                origins: {
                    to: 'https://app.example.com',
                    from: [
                        'https://app.example.com',
                        'https://widget.example.com',
                    ],
                },
            });
            const seen: unknown[] = [];
            ch.respond('probe', (p) => {
                seen.push(p);
                return null;
            });

            // Outbound: ONE address — the `to` half. Widening `from` must not widen this.
            await ch.emit('hi')({ body: {} });
            expect(posts).toHaveLength(1);
            expect(posts[0]?.origin).toBe('https://app.example.com');

            // Inbound: BOTH listed origins reach the responder. This is the half the envelope
            // exists to add, and the ONLY assertion that can see it — `posts[0].origin` comes
            // from `policy.to` alone, so a gate that silently narrowed back to `[to]` (turning a
            // working app→widget channel into one that drops every widget message, with no
            // error) would leave a post-shape assertion green.
            deliver(
                'https://app.example.com',
                { type: 'probe', id: 'a', payload: { via: 'app' } },
                frame,
            );
            deliver(
                'https://widget.example.com',
                { type: 'probe', id: 'b', payload: { via: 'widget' } },
                frame,
            );
            await settle();
            expect(seen).toEqual([{ via: 'app' }, { via: 'widget' }]);

            // …and an origin outside `from` is still dropped before dispatch — from the SAME
            // window, so it is the origin gate doing it, not the peer check.
            deliver(
                'https://evil.example.com',
                { type: 'probe', id: 'c', payload: { via: 'evil' } },
                frame,
            );
            await settle();
            expect(seen).toEqual([{ via: 'app' }, { via: 'widget' }]);

            await ch.close();
        });
    });

    test('`from` REPLACES the `[to]` default rather than extending it', async () => {
        await withMessageListeners(async (deliver) => {
            const ch = channel.window({
                target: fakeWindow([]),
                origins: {
                    to: 'https://app.example.com',
                    // Only the widget is named. `to`'s own origin is NOT implicitly retained —
                    // the footgun for a caller who reads `from` as "one MORE origin" and thereby
                    // stops accepting replies from the very frame they post to.
                    from: ['https://widget.example.com'],
                },
            });
            const seen: unknown[] = [];
            ch.respond('probe', (p) => {
                seen.push(p);
                return null;
            });
            deliver('https://app.example.com', {
                type: 'probe',
                id: 'a',
                payload: { via: 'app' },
            });
            deliver('https://widget.example.com', {
                type: 'probe',
                id: 'b',
                payload: { via: 'widget' },
            });
            await settle();
            expect(seen).toEqual([{ via: 'widget' }]);
            await ch.close();
        });
    });
});

// ---------------------------------------------------------------------------
// channel.window is bound to its PEER — several frames on one page
// ---------------------------------------------------------------------------
// The shape that surfaced this: a design gallery rendering many preview tiles, each an iframe of
// the SAME origin (a `blob:` document inherits its creator's origin; a CDN serves every tile from
// one host), each with its own host channel. Every `channel.window` listens on the page's ONE
// global `'message'` event, so an origin-only gate handed every tile's `ready` and
// `content-height` to every channel: tiles resized and went ready on each other's messages. The
// origin cannot tell the tiles apart; the posting window can. These pin the binding at the level
// a consumer sees it — `events` and `respond` across channels — plus the thunk and navigation
// semantics it rests on. The real-browser proof, with true `WindowProxy` identity across reload,
// re-mint and remount, is `test/browser/postmessage-window-peer.browser.ts`.
describe('channel.window is bound to its peer (several frames on one page)', () => {
    const HOST = 'https://host.example.com';

    // Drain `events(type)` into `into`; the returned drain settles once the channel closes.
    const hear = (
        ch: PostMessageChannel,
        type: string,
        into: unknown[],
    ): Promise<void> =>
        (async () => {
            for await (const e of ch.events(type).stream()) {
                if (e.type === 'delta') into.push(e.chunk);
            }
        })().catch(() => undefined);

    test("two same-origin frames, two channels: each hears only its own frame's events", async () => {
        await withMessageListeners(async (deliver) => {
            const frameA = fakeWindow([]);
            const frameB = fakeWindow([]);
            // The gallery's own spelling: a thunk over each tile's frame, one origin for all.
            const tileA = channel.window({
                target: () => frameA,
                origins: HOST,
            });
            const tileB = channel.window({
                target: () => frameB,
                origins: HOST,
            });
            const heardA: unknown[] = [];
            const heardB: unknown[] = [];
            const drains = [
                hear(tileA, 'template/ready', heardA),
                hear(tileA, 'template/content-height', heardA),
                hear(tileB, 'template/ready', heardB),
                hear(tileB, 'template/content-height', heardB),
            ];
            await settle();

            deliver(HOST, { type: 'template/ready', payload: 'A' }, frameA);
            deliver(
                HOST,
                { type: 'template/content-height', payload: 111 },
                frameA,
            );
            deliver(HOST, { type: 'template/ready', payload: 'B' }, frameB);
            deliver(
                HOST,
                { type: 'template/content-height', payload: 222 },
                frameB,
            );
            await settle();

            expect(heardA).toEqual(['A', 111]);
            expect(heardB).toEqual(['B', 222]);

            await tileA.close();
            await tileB.close();
            await Promise.all(drains);
        });
    });

    test('a request from one frame runs only its own channel responder, and the answer goes back to that frame', async () => {
        await withMessageListeners(async (deliver) => {
            const postsA: { msg: unknown; origin: string }[] = [];
            const postsB: { msg: unknown; origin: string }[] = [];
            const frameA = fakeWindow(postsA);
            const frameB = fakeWindow(postsB);
            const tileA = channel.window({
                target: () => frameA,
                origins: HOST,
            });
            const tileB = channel.window({
                target: () => frameB,
                origins: HOST,
            });
            const ranA: unknown[] = [];
            const ranB: unknown[] = [];
            tileA.respond('focus', (p) => {
                ranA.push(p);
                return { tile: 'A' };
            });
            tileB.respond('focus', (p) => {
                ranB.push(p);
                return { tile: 'B' };
            });

            deliver(
                HOST,
                { type: 'focus', id: 'q1', payload: { selector: '#hero' } },
                frameB,
            );
            await settle();

            // Before the binding, tile A ALSO ran — and answered frame A, which never asked.
            expect(ranA).toEqual([]);
            expect(postsA).toEqual([]);
            expect(ranB).toEqual([{ selector: '#hero' }]);
            expect(postsB).toEqual([
                {
                    msg: {
                        type: 'focus-result',
                        id: 'q1',
                        payload: { tile: 'B' },
                    },
                    origin: HOST,
                },
            ]);

            await tileA.close();
            await tileB.close();
        });
    });

    // Navigation and reload keep a frame's `WindowProxy` — `iframe.contentWindow` is the same
    // object before and after (the browser test asserts it) — so the binding survives both with
    // no re-subscription. That is also why the origin gate is NOT redundant beside it: the same
    // window can navigate to a foreign origin, and only the origin tells those documents apart.
    test('the same window across navigation: the peer check keeps matching, the origin gate still decides', async () => {
        await withMessageListeners(async (deliver) => {
            const frame = fakeWindow([]);
            const ch = channel.window({ target: frame, origins: HOST });
            const heard: unknown[] = [];
            const drain = hear(ch, 'template/ready', heard);
            await settle();

            deliver(HOST, { type: 'template/ready', payload: 1 }, frame);
            // The frame navigates cross-origin: the same window, a foreign document.
            deliver(
                'https://elsewhere.example.com',
                { type: 'template/ready', payload: 2 },
                frame,
            );
            // …then reloads back at the allowed origin: still the same window.
            deliver(HOST, { type: 'template/ready', payload: 3 }, frame);
            await settle();

            expect(heard).toEqual([1, 3]);
            await ch.close();
            await drain;
        });
    });

    // A REMOUNT is different: a new `<iframe>` element is a new browsing context with a new
    // `WindowProxy`. A thunk target is resolved on every inbound message, so it follows the
    // remount, and the old window stops matching the moment the thunk stops returning it. (A
    // `Window` passed directly stays bound to the old context — the thunk is the form to use
    // when the element can be replaced.)
    test('a thunk target is resolved per inbound message, so it follows a remount', async () => {
        await withMessageListeners(async (deliver) => {
            const first = fakeWindow([]);
            let mounted = first;
            const ch = channel.window({
                target: () => mounted,
                origins: HOST,
            });
            const heard: unknown[] = [];
            const drain = hear(ch, 'template/ready', heard);
            await settle();

            deliver(HOST, { type: 'template/ready', payload: 'first' }, first);
            await settle();
            mounted = fakeWindow([]); // the tile re-renders with a new <iframe>
            deliver(HOST, { type: 'template/ready', payload: 'stale' }, first);
            deliver(
                HOST,
                { type: 'template/ready', payload: 'second' },
                mounted,
            );
            await settle();

            expect(heard).toEqual(['first', 'second']);
            await ch.close();
            await drain;
        });
    });

    // A thunk over a ref resolves to NOTHING while its frame is not mounted: `ref.current?.
    // contentWindow` is `undefined` before mount, and a detached `<iframe>`'s `contentWindow` is
    // `null`. That channel has no peer, so no source may match it. `null` is the case a bare
    // `source !== peer` got wrong: a `null` source — a DOM that does not attribute sources, or a
    // context already gone — EQUALS a `null` peer, and the message was delivered.
    test.each([
        ['`null` (a detached iframe)', null],
        ['`undefined` (an unmounted ref)', undefined],
    ])(
        'a thunk resolving to %s has no peer: no source matches it, `null` included',
        async (_label, nothing) => {
            await withMessageListeners(async (deliver) => {
                const ch = channel.window({
                    target: () => nothing as unknown as Window,
                    origins: HOST,
                });
                const heard: unknown[] = [];
                const drain = hear(ch, 'template/content-height', heard);
                await settle();

                deliver(
                    HOST,
                    { type: 'template/content-height', payload: 1 },
                    null,
                );
                deliver(
                    HOST,
                    { type: 'template/content-height', payload: 2 },
                    fakeWindow([]),
                );
                await settle();

                expect(heard).toEqual([]);
                await ch.close();
                await drain;
            });
        },
    );

    test('a thunk that throws drops the message and never throws out of the global listener', async () => {
        await withMessageListeners(async (deliver) => {
            const ch = channel.window({
                // `ref.current!.contentWindow!` before the frame mounts.
                target: () => {
                    throw new TypeError(
                        "Cannot read properties of null (reading 'contentWindow')",
                    );
                },
                origins: HOST,
            });
            const heard: unknown[] = [];
            const drain = hear(ch, 'template/ready', heard);
            await settle();

            expect(() => {
                deliver(
                    HOST,
                    { type: 'template/ready', payload: 'x' },
                    fakeWindow([]),
                );
            }).not.toThrow();
            await settle();

            expect(heard).toEqual([]);
            await ch.close();
            await drain;
        });
    });
});

describe('channel.port (origin gating bypassed for ports)', () => {
    test('a MessagePort channel does an RPC round-trip with no origin', async () => {
        const mc = new MessageChannel();
        const parent = channel.port(mc.port1);
        const worker = channel.port(mc.port2);
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
// no inert `adapter` on the verb options (P24)
// ---------------------------------------------------------------------------
// Every postMessage surface carries an `execute` hook, and the engine reads
// `cfg.kind.execute ?? rt.adapter` — so an adapter handed to a verb can NEVER be called. The three
// verb option types therefore Omit `adapter` (behind one shared `PostMessageVerbConfig` alias, so
// they cannot drift apart), making `request(type, { adapter })` a COMPILE error instead of config
// that typechecks and sits dead. Same defect, same fix as #795's `channel.port({ allowedOrigins })`
// above: CONTRACT.md P24 carve-out (b) — a flat shape is never a licence to let inert config
// typecheck. The `@ts-expect-error` directives are enforced by `check:types`; the closure is never
// invoked, and the runtime test beside them proves the transport really is the channel's, not the
// config's.

describe('the verb options carry no inert `adapter` (P24)', () => {
    test('`adapter` is rejected on request / emit / events', () => {
        const rejected = () => {
            const { parent } = channelPair();
            const adapter: Adapter = () =>
                Promise.resolve({ status: 200, headers: {}, body: {} });
            return [
                // @ts-expect-error — `adapter` is not a RequestOptions slot: `execute` replaces it.
                parent.request('x', { adapter }),
                // @ts-expect-error — `adapter` is not an EmitOptions slot: `execute` replaces it.
                parent.emit('x', { adapter }),
                // @ts-expect-error — `adapter` is not an EventsOptions slot: `execute` replaces it.
                parent.events('x', { adapter }),
            ];
        };
        expect(typeof rejected).toBe('function');
    });

    test('the channel transport answers, and nothing else can be substituted for it', async () => {
        const { parent, iframe, closeBoth } = channelPair();
        iframe.respond('ping', () => 'from-the-channel');
        const ping = parent.request('ping');
        await expect(ping({ body: {} })).resolves.toBe('from-the-channel');
        await closeBoth();
    });
});

// ---------------------------------------------------------------------------
// the raw `channel` builder over a fake transport (the core path the others delegate to)
// ---------------------------------------------------------------------------

describe('channel.over() over an arbitrary transport', () => {
    test('an empty `from` over an origin-bearing transport fails closed (drops everything)', async () => {
        const { a, b } = linkedPair(ORIGIN_A, ORIGIN_B);
        const parent = channel.over(a, { from: [] }); // allow NOTHING
        const iframe = channel.over(b, { from: [ORIGIN_A] });
        iframe.respond('x', () => 'ok');
        const call = parent.request('x', { timeout: { each: 40 } });
        // The iframe's reply carries origin ORIGIN_B, which is not in [] → dropped → times out.
        await expect(call({ body: {} })).rejects.toMatchObject({
            name: 'StitchError',
        });
        await parent.close();
        await iframe.close();
    });

    test('a bad origin names `from` — the slot the caller wrote, not `origins`', () => {
        const transport: MessageTransport = {
            post: () => undefined,
            subscribe: () => () => undefined,
        };
        // `channel` takes the inbound half alone, so its slot is `from` end to end: the guard that
        // rejects a wildcard and the one that rejects a non-bare origin both report the property
        // that is actually on `ChannelOptions`. `origins` does not exist on this builder, and an
        // error naming it would describe a different surface's shape.
        expect(() =>
            channel.over(transport, {
                from: '*' as unknown as `https://${string}`,
            }),
        ).toThrow(/wildcard origin is forbidden in `from`, got '\*'/);
        expect(() =>
            channel.over(transport, { from: ['https://app.example.com/'] }),
        ).toThrow(
            /`from` must be a bare origin.*did you mean 'https:\/\/app\.example\.com'/,
        );
    });
});

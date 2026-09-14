// The `postmessage` surface (ADR 0009): a typed, validated, observable wrapper over browser
// `postMessage` RPC + events. These specs drive the WHOLE surface over an in-memory LINKED
// TRANSPORT PAIR — two `MessageTransport`s wired to each other, each carrying a configurable
// `origin` — simulating parent↔iframe with zero DOM. The four verbs (request/emit/events/respond),
// the origin gate, validation, timeout/abort, and `close()` are all exercised through it.
import {
    type ChannelOptions,
    type MessageTransport,
    type PostMessageChannel,
    type WindowChannelOptions,
    channel,
    portChannel,
    postMessageEventSurface,
    postMessageSurface,
    windowChannel,
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
    const parent = channel(a, { origins: [ORIGIN_B] });
    // A single origin passes as a bare string (`T | T[]` — CONTRACT.md P7).
    const iframe = channel(b, { origins: ORIGIN_A });
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
        const parent = channel(a, { origins: [ORIGIN_B] });
        const iframe = channel(b, { origins: [ORIGIN_A] });
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
        const parent = channel(a, { origins: [ORIGIN_B] }); // only the REAL iframe origin
        const evil = channel(b, { origins: [ORIGIN_A] });
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
        const parent = channel(a, { origins: [ORIGIN_B] });
        const evil = channel(b, { origins: [ORIGIN_A] });
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
        const parent = channel(a, { origins: [ORIGIN_B] }); // only the REAL iframe origin
        const evil = channel(b, { origins: [ORIGIN_A] });
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
        const ch = channel(transport, { origins: [ORIGIN_B] });
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

const fakeWindow = (posts: { msg: unknown; origin: string }[]): Window =>
    ({
        postMessage: (msg: unknown, origin: string) => {
            posts.push({ msg, origin });
        },
    }) as unknown as Window;

// `windowChannel` subscribes to the GLOBAL `'message'` event, so the only way to exercise its
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
    body: (deliver: (origin: string, data: unknown) => void) => Promise<void>,
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
        await body((origin, data) => {
            for (const l of [...listeners]) l({ data, origin } as MessageEvent);
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

describe('windowChannel guards', () => {
    test('a wildcard origin throws at runtime, through the scalar shorthand (defense in depth beyond the Origin type)', () => {
        expect(
            () =>
                windowChannel({
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
            windowChannel({
                target: fakeWindow([]),
                origins: { to: '*' as unknown as `https://${string}` },
            }),
        ).toThrow(/wildcard origin is forbidden in `origins\.to`, got '\*'/);
        expect(
            () =>
                windowChannel({
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

    test('a missing `origins` is the directed construction error, not an opaque TypeError', () => {
        // Exactly the shape a call site still spelling the pre-envelope `targetOrigin` /
        // `allowedOrigins` produces. TypeScript rejects it, but a JS caller, an `as any`, a stale
        // `.d.ts`, or options round-tripped through JSON all reach the constructor without
        // `origins` — and this file's whole thesis is that construction fails LOUD, which an
        // undefined dereference two lines later does not honour.
        const staleWindowOpts = {
            target: fakeWindow([]),
            targetOrigin: 'https://app.example.com',
        } as unknown as WindowChannelOptions;
        expect(() => windowChannel(staleWindowOpts)).toThrow(
            /`origins` is required/,
        );
        // Specifically NOT `TypeError: Cannot read properties of undefined (reading 'to')`.
        expect(() => windowChannel(staleWindowOpts)).not.toThrow(TypeError);

        const staleChannelOpts = {
            allowedOrigins: ['https://app.example.com'],
        } as unknown as ChannelOptions;
        const transport: MessageTransport = {
            post: () => undefined,
            subscribe: () => () => undefined,
        };
        expect(() => channel(transport, staleChannelOpts)).toThrow(
            /`origins` is required/,
        );
        expect(() => channel(transport, staleChannelOpts)).not.toThrow(
            TypeError,
        );

        // Same for an envelope that names only the inbound half: the missing `to` names its own
        // slot instead of dying on `.includes` of undefined.
        expect(() =>
            windowChannel({
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
                windowChannel({ target: fakeWindow([]), origins: origin }),
            ).toThrow(/bare origin/);
        }
        // The error names the normalised spelling AND the slot the caller wrote, so the fix is
        // in the message: the shorthand reports `origins`…
        expect(() =>
            windowChannel({
                target: fakeWindow([]),
                origins: 'https://app.example.com/',
            }),
        ).toThrow(
            /`origins` must be a bare origin.*did you mean 'https:\/\/app\.example\.com'/,
        );
        // …and the envelope reports the half that is wrong, on either half.
        expect(() =>
            windowChannel({
                target: fakeWindow([]),
                origins: { to: 'https://app.example.com/' },
            }),
        ).toThrow(/`origins\.to` must be a bare origin/);
        expect(() =>
            windowChannel({
                target: fakeWindow([]),
                origins: {
                    to: 'https://app.example.com',
                    from: ['https://app.example.com:443'],
                },
            }),
        ).toThrow(/`origins\.from` must be a bare origin/);
    });

    test('windowChannel posts to the resolved target with the bound origin', async () => {
        const posts: { msg: unknown; origin: string }[] = [];
        const target = fakeWindow(posts);
        // A thunk target is resolved per post (the natural shape when the frame mounts late).
        const ch = windowChannel({
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
            const shorthand = windowChannel({
                target: fakeWindow(shorthandPosts),
                origins: 'https://app.example.com',
            });
            const envelope = windowChannel({
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

    test('`from` widens the inbound gate without widening the outbound address', async () => {
        await withMessageListeners(async (deliver) => {
            const posts: { msg: unknown; origin: string }[] = [];
            const ch = windowChannel({
                target: fakeWindow(posts),
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
            // working parent/app/widget channel into one that drops every widget message, with
            // no error) would leave a post-shape assertion green.
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
            expect(seen).toEqual([{ via: 'app' }, { via: 'widget' }]);

            // …and an origin outside `from` is still dropped before dispatch.
            deliver('https://evil.example.com', {
                type: 'probe',
                id: 'c',
                payload: { via: 'evil' },
            });
            await settle();
            expect(seen).toEqual([{ via: 'app' }, { via: 'widget' }]);

            await ch.close();
        });
    });

    test('`from` REPLACES the `[to]` default rather than extending it', async () => {
        await withMessageListeners(async (deliver) => {
            const ch = windowChannel({
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
// no inert `adapter` on the verb options (P24)
// ---------------------------------------------------------------------------
// Every postMessage surface carries an `execute` hook, and the engine reads
// `cfg.kind.execute ?? rt.adapter` — so an adapter handed to a verb can NEVER be called. The three
// verb option types therefore Omit `adapter` (behind one shared `PostMessageVerbConfig` alias, so
// they cannot drift apart), making `request(type, { adapter })` a COMPILE error instead of config
// that typechecks and sits dead. Same defect, same fix as #795's `portChannel({ allowedOrigins })`
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

describe('channel() over an arbitrary transport', () => {
    test('an empty `origins` over an origin-bearing transport fails closed (drops everything)', async () => {
        const { a, b } = linkedPair(ORIGIN_A, ORIGIN_B);
        const parent = channel(a, { origins: [] }); // allow NOTHING
        const iframe = channel(b, { origins: [ORIGIN_A] });
        iframe.respond('x', () => 'ok');
        const call = parent.request('x', { timeout: { each: 40 } });
        // The iframe's reply carries origin ORIGIN_B, which is not in [] → dropped → times out.
        await expect(call({ body: {} })).rejects.toMatchObject({
            name: 'StitchError',
        });
        await parent.close();
        await iframe.close();
    });
});

// Three postmessage-surface behaviours (src/postmessage.ts) that postmessage.spec.ts leaves open,
// driven over the same in-memory linked-transport pair (parent↔iframe, no DOM):
//   1. respond() REPLACEMENT — a second respond(type, …) replaces the first, and the first's
//      unsubscribe becomes a no-op (the `responders.get(type) === responder` guard), so the
//      replacement keeps answering.
//   2. a THROWING responder handler does not reply → the requester times out (a distinct branch
//      from the already-tested input-validation drop).
//   3. a single inbound event FANS OUT to every matching subscription (the demux loop over
//      eventSubs) — two events(type) streams of the same type both receive each event.
import {
    type MessageTransport,
    type PostMessageChannel,
    channel,
} from '../src/postmessage';

// ---- the in-memory linked transport pair (mirrors postmessage.spec.ts) ----
interface LinkedPair {
    a: MessageTransport;
    b: MessageTransport;
}

function structuredCloneish<T>(v: T): T {
    return JSON.parse(JSON.stringify(v)) as T;
}

function linkedPair(originA: string, originB: string): LinkedPair {
    const subsA = new Set<(data: unknown, origin: string) => void>();
    const subsB = new Set<(data: unknown, origin: string) => void>();
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

const ORIGIN_A = 'https://parent.example.com';
const ORIGIN_B = 'https://iframe.example.com';

function channelPair(): {
    parent: PostMessageChannel;
    iframe: PostMessageChannel;
    closeBoth: () => void;
} {
    const { a, b } = linkedPair(ORIGIN_A, ORIGIN_B);
    const parent = channel(a, { allowedOrigins: [ORIGIN_B] });
    const iframe = channel(b, { allowedOrigins: [ORIGIN_A] });
    return {
        parent,
        iframe,
        closeBoth: () => {
            parent.close();
            iframe.close();
        },
    };
}

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('respond() replacement', () => {
    test('a second respond(type) replaces the first; the stale unsubscribe is a no-op', async () => {
        const { parent, iframe, closeBoth } = channelPair();
        const off1 = iframe.respond('q', () => 'first', { reply: 'q-reply' });
        // Same type → replaces the first responder in the registry.
        iframe.respond('q', () => 'second', { reply: 'q-reply' });
        // The first handle must NOT remove the now-active 'second' responder.
        off1();
        const ask = parent.request({
            type: 'q',
            reply: 'q-reply',
            timeout: { perAttempt: 300 },
        });
        await expect(ask()).resolves.toBe('second');
        closeBoth();
    });
});

describe('responder error handling', () => {
    test('a throwing handler posts no reply → the requester times out', async () => {
        const { parent, iframe, closeBoth } = channelPair();
        iframe.respond('boom', () => {
            throw new Error('handler blew up');
        });
        const ask = parent.request({
            type: 'boom',
            timeout: { perAttempt: 40 },
        });
        await expect(ask({ body: { x: 1 } })).rejects.toMatchObject({
            name: 'StitchError',
        });
        closeBoth();
    });
});

describe('events fan-out', () => {
    test('one inbound event reaches every matching subscription of that type', async () => {
        const { parent, iframe, closeBoth } = channelPair();
        const subA = parent.events<{ type: 'tick' }>({ type: 'tick' });
        const subB = parent.events<{ type: 'tick' }>({ type: 'tick' });
        const ctlA = new AbortController();
        const ctlB = new AbortController();
        const gotA: unknown[] = [];
        const gotB: unknown[] = [];
        const drainA = (async () => {
            for await (const e of subA.stream({ signal: ctlA.signal }))
                if (e.type === 'delta') gotA.push(e.chunk);
        })();
        const drainB = (async () => {
            for await (const e of subB.stream({ signal: ctlB.signal }))
                if (e.type === 'delta') gotB.push(e.chunk);
        })();
        // Let both subscriptions register before emitting.
        await tick(10);
        await iframe.emit({ type: 'tick' as const })({ body: { n: 1 } });
        await iframe.emit({ type: 'tick' as const })({ body: { n: 2 } });
        await tick(30);
        ctlA.abort();
        ctlB.abort();
        await Promise.all([
            drainA.catch(() => undefined),
            drainB.catch(() => undefined),
        ]);
        expect(gotA).toEqual([{ n: 1 }, { n: 2 }]);
        expect(gotB).toEqual([{ n: 1 }, { n: 2 }]);
        closeBoth();
    });
});

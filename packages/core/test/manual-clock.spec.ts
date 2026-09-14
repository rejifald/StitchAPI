// Direct unit tests for the manualClock primitives (src/test-clock.ts). clock-seam.spec.ts proves
// manualClock makes the ENGINE deterministic (retry/throttle/timeout via advance + pending), but the
// clock's own contract — the thing every deterministic-time test leans on — is only exercised
// indirectly. These pin it: now()/advance, setTimer/clearTimer + pending, same-time ordering, a
// timer armed BY a fired callback running in the same advance, a not-yet-due timer staying pending,
// and sleep's resolve / pre-abort / mid-flight-abort behaviour.
import { manualClock } from '../src/test-clock';

describe('manualClock: time + timers', () => {
    test('now() starts at the seed and tracks advance', async () => {
        expect(manualClock().now()).toBe(0);
        const c = manualClock(1000);
        expect(c.now()).toBe(1000);
        await c.advance(50);
        expect(c.now()).toBe(1050);
    });

    test('setTimer fires only once its due time is reached; pending tracks it', async () => {
        const c = manualClock();
        let fired = false;
        c.setTimer(() => {
            fired = true;
        }, 100);
        expect(c.pending()).toBe(1);
        await c.advance(99);
        expect(fired).toBe(false); // not yet due
        await c.advance(1); // now at 100
        expect(fired).toBe(true);
        expect(c.pending()).toBe(0);
    });

    test('clearTimer cancels a pending timer', async () => {
        const c = manualClock();
        let fired = false;
        const handle = c.setTimer(() => {
            fired = true;
        }, 100);
        c.clearTimer(handle);
        expect(c.pending()).toBe(0);
        await c.advance(200);
        expect(fired).toBe(false);
    });

    test('fires due timers in time order, then insertion order for ties', async () => {
        const c = manualClock();
        const order: string[] = [];
        c.setTimer(() => order.push('t10-a'), 10);
        c.setTimer(() => order.push('t30'), 30);
        c.setTimer(() => order.push('t10-b'), 10); // same time as t10-a, later insertion
        c.setTimer(() => order.push('t20'), 20);
        await c.advance(100);
        expect(order).toEqual(['t10-a', 't10-b', 't20', 't30']);
    });

    test('a timer armed by a fired callback runs within the same advance if due', async () => {
        const c = manualClock();
        const order: string[] = [];
        c.setTimer(() => {
            order.push('first');
            c.setTimer(() => order.push('second'), 5); // armed at t=10 → due t=15
        }, 10);
        await c.advance(20); // target 20 ≥ 15 → both fire
        expect(order).toEqual(['first', 'second']);
        expect(c.now()).toBe(20);
    });

    test('a timer due after the target stays pending; time still advances to the target', async () => {
        const c = manualClock();
        let fired = false;
        c.setTimer(() => {
            fired = true;
        }, 100);
        await c.advance(50);
        expect(fired).toBe(false);
        expect(c.now()).toBe(50);
        expect(c.pending()).toBe(1);
    });
});

describe('manualClock: sleep', () => {
    test('sleep resolves when the clock is advanced past it', async () => {
        const c = manualClock();
        let resolved = false;
        const p = c.sleep(100).then(() => {
            resolved = true;
        });
        await c.advance(100);
        await p;
        expect(resolved).toBe(true);
    });

    test('sleep rejects immediately for an already-aborted signal', async () => {
        const c = manualClock();
        const ac = new AbortController();
        ac.abort();
        await expect(c.sleep(100, ac.signal)).rejects.toThrow('aborted');
        expect(c.pending()).toBe(0); // nothing scheduled
    });

    test('aborting mid-sleep rejects it and drops the pending timer', async () => {
        const c = manualClock();
        const ac = new AbortController();
        const p = c.sleep(100, ac.signal);
        expect(c.pending()).toBe(1);
        ac.abort();
        await expect(p).rejects.toThrow('aborted');
        expect(c.pending()).toBe(0);
    });

    test('sleep rejects with the caller-supplied abort reason (mirrors systemClock)', async () => {
        const c = manualClock();
        const ac = new AbortController();
        const reason = new Error('deliberate cancel');
        const p = c.sleep(100, ac.signal);
        ac.abort(reason);
        await expect(p).rejects.toBe(reason); // the same instance, not a re-minted Error
        expect(c.pending()).toBe(0);
    });
});

// P17: `advance` is a consumer-authored duration on the published `stitchapi/testing` surface, so
// it takes `number | string`. The parse has to land BEFORE the arithmetic — `current + '10s'`
// string-concatenates into `'010s'` rather than throwing, which is P17's silent-collapse failure
// (the clock would then report a string and every later comparison would be garbage).
describe('manualClock: advance takes a duration token (P17)', () => {
    test("advance('1s') moves the clock exactly 1000ms", async () => {
        const c = manualClock();
        await c.advance('1s');
        expect(c.now()).toBe(1000);
        expect(typeof c.now()).toBe('number'); // not the concatenated '01s'
    });

    test('a token fires the timers a raw-ms advance of the same length would', async () => {
        const c = manualClock();
        const order: string[] = [];
        c.setTimer(() => order.push('t500ms'), 500);
        c.setTimer(() => order.push('t30s'), 30_000);
        c.setTimer(() => order.push('t2m'), 120_000);
        await c.advance('1m');
        expect(order).toEqual(['t500ms', 't30s']); // the 2m timer is not due
        expect(c.now()).toBe(60_000);
        expect(c.pending()).toBe(1);
    });

    test('tokens accumulate as numbers across successive advances', async () => {
        const c = manualClock(1000);
        await c.advance('1.5s');
        await c.advance(500);
        await c.advance('2m');
        expect(c.now()).toBe(1000 + 1500 + 500 + 120_000);
    });

    test('a numeric string and a fractional token both read as ms', async () => {
        const c = manualClock();
        await c.advance('250'); // bare numeric string → raw ms
        expect(c.now()).toBe(250);
        await c.advance('0.5s');
        expect(c.now()).toBe(750);
    });

    test('an unreadable token lands on its default and advances nothing', async () => {
        const c = manualClock();
        let fired = false;
        c.setTimer(() => {
            fired = true;
        }, 10);
        await c.advance('soon');
        expect(c.now()).toBe(0); // never NaN, never a string
        expect(fired).toBe(false);
        expect(c.pending()).toBe(1);
    });
});

// Extra behaviours of stubStitch/failStitch (src/test-stub.ts) beyond testing-kit.spec.ts's basics
// (canned value + spy, synthesized stream, fn-of-input, failStitch reject/safe/stream):
//   - .with(partial) returns a fresh stub whose run merges `partial` UNDER the call input
//     (the call input wins on a shared key);
//   - the call spy records .unwrap()/.safe()/.stream() too (not just the callable), and reset()
//     clears it;
//   - opts.events overrides the synthesized stream; opts.name/status/config flow onto __config and
//     the synthesized result event;
//   - failStitch({ status, message }) puts the status on the StitchError, safe().error, and the
//     synthesized error event.
import { failStitch, stubStitch } from '../src/test-stub';
import type { StitchEvent, StitchInput } from '../src/types';

const collect = async (
    it: AsyncIterable<StitchEvent>,
): Promise<StitchEvent[]> => {
    const out: StitchEvent[] = [];
    for await (const e of it) out.push(e);
    return out;
};

describe('stubStitch.with', () => {
    test('merges the bound partial UNDER the call input', async () => {
        const echo = stubStitch<StitchInput>((input) => input);
        const bound = echo.with({ params: { a: 1 } });
        // disjoint keys combine…
        await expect(bound({ query: { b: 2 } })).resolves.toEqual({
            params: { a: 1 },
            query: { b: 2 },
        });
        // …and the call input wins on a shared key.
        await expect(bound({ params: { a: 99 } })).resolves.toEqual({
            params: { a: 99 },
        });
    });
});

describe('stubStitch call spy', () => {
    test('records callable / unwrap / safe / stream invocations, and reset clears them', async () => {
        const s = stubStitch('V');
        s();
        await s.unwrap({ params: { id: 1 } });
        await s.safe();
        await collect(s.stream());
        expect(s.callCount).toBe(4);
        expect(s.calls[1]).toEqual({ params: { id: 1 } });
        s.reset();
        expect(s.callCount).toBe(0);
        expect(s.calls).toEqual([]);
    });
});

describe('stubStitch options', () => {
    test('opts.events overrides the synthesized stream', async () => {
        const s = stubStitch('ignored', {
            events: () => [
                { type: 'info', topic: 'custom', at: 1 },
                { type: 'done', ok: true, elapsed: 0, attempts: 1, at: 1 },
            ],
        });
        const types = (await collect(s.stream())).map((e) => e.type);
        expect(types).toEqual(['info', 'done']);
    });

    test('opts.name / status / config flow onto __config and the result event', async () => {
        const s = stubStitch('V', {
            name: 'myStub',
            status: 201,
            config: { baseUrl: 'https://x.test' },
        });
        expect(s.__config.name).toBe('myStub');
        expect(s.__config.baseUrl).toBe('https://x.test');
        const result = (await collect(s.stream())).find(
            (e): e is Extract<StitchEvent, { type: 'result' }> =>
                e.type === 'result',
        );
        expect(result?.status).toBe(201);
    });
});

describe('failStitch with a { status, message } shape', () => {
    test('puts the status on the error, safe().error, and the error event', async () => {
        const f = failStitch({ status: 503, message: 'down' });
        await expect(f.unwrap()).rejects.toMatchObject({
            name: 'StitchError',
            status: 503,
            message: 'down',
        });
        const safe = await f.safe();
        expect(safe.ok).toBe(false);
        expect(safe.error?.status).toBe(503);
        const errEvent = (await collect(f.stream())).find(
            (e): e is Extract<StitchEvent, { type: 'error' }> =>
                e.type === 'error',
        );
        expect(errEvent?.status).toBe(503);
    });
});

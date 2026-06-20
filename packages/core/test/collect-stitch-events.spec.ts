// Direct tests for collectStitchEvents (src/test-events.ts). testing-kit.spec.ts drives it once
// through a real stream surface (deltas + done). Driving it with hand-built event generators pins
// the rest of its contract, deterministically:
//   - it drains every category: types (in order), deltas, drifts, result, done, and the full events;
//   - it accepts BOTH a raw generator AND a `.stream()`-bearing source (the headline ergonomic);
//   - it captures an error event's { message, status } (status undefined when omitted);
//   - an empty stream yields empty/undefined parts.
import { collectStitchEvents } from '../src/test-events';
import type { DriftFinding, StitchEvent } from '../src/types';

async function* gen(
    ...events: StitchEvent[]
): AsyncGenerator<StitchEvent, void> {
    for (const e of events) yield e;
}

const finding: DriftFinding = {
    level: 'warn',
    path: 'data.id',
    change: 'missing',
};

const fullRun = (): StitchEvent[] => [
    { type: 'start', name: 'x', method: 'GET', url: 'u', input: {}, at: 1 },
    { type: 'delta', chunk: 'a', at: 1 },
    { type: 'delta', chunk: 'b', at: 1 },
    { type: 'drift', finding, at: 1 },
    { type: 'result', value: 'R', status: 200, attempts: 1, at: 1 },
    { type: 'done', ok: true, ms: 0, attempts: 1, at: 1 },
];

describe('collectStitchEvents', () => {
    test('drains every category from a generator source', async () => {
        const ev = await collectStitchEvents(gen(...fullRun()));
        expect(ev.types).toEqual([
            'start',
            'delta',
            'delta',
            'drift',
            'result',
            'done',
        ]);
        expect(ev.deltas).toEqual(['a', 'b']);
        expect(ev.drifts).toEqual([finding]);
        expect(ev.result).toBe('R');
        expect(ev.done).toEqual({ ok: true });
        expect(ev.error).toBeUndefined();
        expect(ev.events).toHaveLength(6);
    });

    test('accepts a `.stream()`-bearing source (not just a raw generator)', async () => {
        const source = { stream: () => gen(...fullRun()) };
        const ev = await collectStitchEvents(source);
        expect(ev.deltas).toEqual(['a', 'b']);
        expect(ev.result).toBe('R');
        expect(ev.done).toEqual({ ok: true });
    });

    test('captures an error event (message + status), with status undefined when omitted', async () => {
        const withStatus = await collectStitchEvents(
            gen(
                {
                    type: 'error',
                    name: 'StitchError',
                    message: 'boom',
                    status: 503,
                    attempts: 1,
                    at: 1,
                },
                { type: 'done', ok: false, ms: 0, attempts: 1, at: 1 },
            ),
        );
        expect(withStatus.error).toEqual({ message: 'boom', status: 503 });
        expect(withStatus.done).toEqual({ ok: false });
        expect(withStatus.result).toBeUndefined();

        const noStatus = await collectStitchEvents(
            gen({
                type: 'error',
                name: 'StitchError',
                message: 'nope',
                attempts: 1,
                at: 1,
            }),
        );
        expect(noStatus.error).toEqual({ message: 'nope', status: undefined });
    });

    test('an empty stream yields empty/undefined parts', async () => {
        const ev = await collectStitchEvents(gen());
        expect(ev.types).toEqual([]);
        expect(ev.deltas).toEqual([]);
        expect(ev.drifts).toEqual([]);
        expect(ev.result).toBeUndefined();
        expect(ev.error).toBeUndefined();
        expect(ev.done).toBeUndefined();
        expect(ev.events).toEqual([]);
    });
});

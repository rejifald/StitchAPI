// P17 parity: the engine CO-EMITS the @deprecated `*Ms` aliases alongside the canonical
// de-suffixed event fields, so a consumer still reading the old name keeps working until the
// GA cut (CONTRACT.md P17/P19). Covers the `done` (elapsed/ms) and throttled-`progress`
// (waited/waitedMs) events the engine constructs.
import { stitch } from '../src';
import type { Adapter, StitchEvent } from '../src';

const okAdapter: Adapter = async () => ({
    status: 200,
    headers: {},
    body: { ok: true },
});

async function collect(s: {
    stream(): AsyncGenerator<StitchEvent>;
}): Promise<StitchEvent[]> {
    const out: StitchEvent[] = [];
    for await (const e of s.stream()) out.push(e);
    return out;
}

test('done event carries both `elapsed` and the @deprecated `ms` alias', async () => {
    const call = stitch({ url: 'https://x.test', adapter: okAdapter });
    const done = (await collect(call())).find((e) => e.type === 'done');
    const d = done as Extract<StitchEvent, { type: 'done' }>;
    expect(typeof d.elapsed).toBe('number');
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- asserting the alias is co-emitted for back-compat
    expect(d.ms).toBe(d.elapsed);
});

test('throttled progress carries both `waited` and the @deprecated `waitedMs` alias', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let n = 0;
    const adapter: Adapter = async () => {
        // Hold the FIRST call open so the second blocks on the single concurrency slot.
        if (++n === 1) await gate;
        return { status: 200, headers: {}, body: { ok: true } };
    };
    const call = stitch({
        url: 'https://x.test',
        adapter,
        throttle: { concurrency: 1 },
    });

    const first = collect(call()); // takes the only slot, parks on the gate
    await new Promise((r) => setTimeout(r, 10)); // first acquires the slot before the second starts
    const secondP = collect(call()); // blocks on concurrency → records waited > 0
    await new Promise((r) => setTimeout(r, 10)); // hold the block long enough to be measurable
    release();
    const [, second] = await Promise.all([first, secondP]);

    const throttled = second.find(
        (e) => e.type === 'progress' && e.phase === 'throttled',
    ) as Extract<StitchEvent, { type: 'progress' }> | undefined;
    expect(throttled).toBeDefined();
    const p = throttled as Extract<StitchEvent, { type: 'progress' }>;
    expect(typeof p.waited).toBe('number');
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- asserting the alias is co-emitted for back-compat
    expect(p.waitedMs).toBe(p.waited);
});

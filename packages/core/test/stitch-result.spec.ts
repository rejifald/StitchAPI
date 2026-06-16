// The value a stitch CALL returns is a `StitchResult` — a thenable that also exposes `.catch`,
// `.finally`, and `.stream`. then/catch/finally share ONE execution of the call (#133); `stream()`
// is a separate consumption path. A custom adapter (no network) makes execution exactly countable.
import { stitch } from '../src';
import type { Adapter } from '../src/types';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-result-${process.pid}.jsonl`,
);

// A succeeding adapter that counts how many times the call actually executes.
function countingAdapter(): { adapter: Adapter; calls: () => number } {
    let calls = 0;
    const adapter: Adapter = async () => {
        calls += 1;
        return { status: 200, headers: {}, body: { ok: true } };
    };
    return { adapter, calls: () => calls };
}

// An adapter that always fails (so the call rejects).
const failing: Adapter = async () => ({
    status: 500,
    headers: {},
    body: { error: 'boom' },
});

test('.finally runs the callback and resolves to the value on success', async () => {
    const { adapter } = countingAdapter();
    const ping = stitch({ url: 'https://api.example.com/ping', adapter });
    let ran = false;
    await expect(ping().finally(() => void (ran = true))).resolves.toEqual({
        ok: true,
    });
    expect(ran).toBe(true);
});

test('.finally runs the callback on failure too', async () => {
    const boom = stitch({
        url: 'https://api.example.com/boom',
        adapter: failing,
    });
    let ran = false;
    await boom()
        .finally(() => void (ran = true))
        .catch(() => undefined);
    expect(ran).toBe(true);
});

test('.catch handles a rejected call (and is callable without @ts-expect-error)', async () => {
    const boom = stitch({
        url: 'https://api.example.com/boom',
        adapter: failing,
    });
    let reason: unknown;
    const caught = await boom().catch((e: unknown) => {
        reason = e;
        return 'recovered' as const;
    });
    expect(caught).toBe('recovered');
    expect(reason).toBeInstanceOf(Error);
});

test('then + catch on the SAME result run the call exactly once', async () => {
    const { adapter, calls } = countingAdapter();
    const ping = stitch({ url: 'https://api.example.com/ping', adapter });
    const r = ping();
    await Promise.all([r.then((x) => x), r.catch(() => undefined)]);
    // The latent double-make() regression would make this 2.
    expect(calls()).toBe(1);
});

test('stream() is a separate consumption path from the awaited result', async () => {
    const { adapter, calls } = countingAdapter();
    const ping = stitch({ url: 'https://api.example.com/ping', adapter });
    await ping();
    for await (const _ of ping.stream()) void _;
    // An awaited call plus an independent stream() are two executions, as expected.
    expect(calls()).toBe(2);
});

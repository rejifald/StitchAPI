// `STITCH_EXPORT=otlp` with no import. The sink lives on `stitchapi/otlp`, so stitch.ts reaches it
// through a lazy `import('./otlp')` (the way the engine reaches `cache`) and a sink built before the
// module resolves holds its events, then forwards them in order. Tested here:
//   - end to end: the env toggle alone exports a span tree through the real module;
//   - ordering: events emitted while the load is still pending reach the sink in order, and later
//     events go straight through;
//   - failure: a load that rejects warns once, drops the events, and never breaks a run.
//
// The module memoises its load per process, so every case resets the module registry and imports
// a fresh `stitch`.
import type { Adapter, StitchEvent } from '../src';

const ok: Adapter = async () => ({
    status: 200,
    headers: {},
    body: { ok: true },
});

async function freshStitch(): Promise<typeof import('../src').stitch> {
    vi.resetModules();
    return (await import('../src')).stitch;
}

beforeEach(() => {
    vi.stubEnv('STITCH_EXPORT', 'otlp');
    vi.stubEnv('STITCH_TRACE_FILE', '');
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://collector.test');
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.doUnmock('../src/otlp');
    vi.restoreAllMocks();
});

test('the env toggle alone exports a span tree through the lazily loaded module', async () => {
    const posts: { url: string; body: string }[] = [];
    vi.stubGlobal('fetch', (url: string, init: { body: string }) => {
        posts.push({ url, body: init.body });
        return Promise.resolve({ ok: true, status: 200 });
    });
    const stitch = await freshStitch();

    const getThing = stitch({
        name: 'lazyThing',
        url: 'http://api.example.com/thing',
        adapter: ok,
    });
    await expect(getThing()).resolves.toEqual({ ok: true });

    // The run finished before (or while) the module loaded; its events are exported once it has.
    await vi.waitFor(() => {
        expect(posts).toHaveLength(1);
    });
    expect(posts[0]!.url).toBe('http://collector.test/v1/traces');
    const spans = (
        JSON.parse(posts[0]!.body) as {
            resourceSpans: [{ scopeSpans: [{ spans: { name: string }[] }] }];
        }
    ).resourceSpans[0].scopeSpans[0].spans;
    expect(spans.map((s) => s.name)).toEqual(['lazyThing', 'GET']);
});

test('events emitted before the load resolves are forwarded in order; later ones go straight through', async () => {
    let release!: () => void;
    const loaded = new Promise<void>((resolve) => {
        release = resolve;
    });
    const seen: StitchEvent[] = [];
    vi.doMock('../src/otlp', async () => {
        await loaded; // the module stays pending until the test lets it resolve
        return {
            otlp: {
                sink: () => ({
                    handle: (event: StitchEvent) => {
                        seen.push(event);
                    },
                }),
            },
        };
    });
    const stitch = await freshStitch();
    const getThing = stitch({
        name: 'orderedThing',
        url: 'http://api.example.com/thing',
        adapter: ok,
    });

    await getThing(); // the whole run happens while the import is pending
    expect(seen).toEqual([]);

    release();
    await vi.waitFor(() => {
        expect(seen.length).toBeGreaterThan(0);
    });
    const first = seen.length;
    // The held run replays whole and in order: it opens on `start`, closes on `done`, and the
    // timestamps never run backwards.
    expect(seen[0]!.type).toBe('start');
    expect(seen[first - 1]!.type).toBe('done');
    expect(seen.map((e) => e.at)).toEqual(
        [...seen.map((e) => e.at)].sort((a, b) => a - b),
    );

    // Once loaded the sink is called directly, with no hold.
    await getThing();
    expect(seen.length).toBe(first * 2);
    expect(seen[first]!.type).toBe('start');
});

test('a module that fails to load warns once, drops the events, and leaves the run unharmed', async () => {
    vi.doMock('../src/otlp', () => {
        throw new Error('chunk missing');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stitch = await freshStitch();
    const a = stitch({
        name: 'a',
        url: 'http://api.example.com/a',
        adapter: ok,
    });
    const b = stitch({
        name: 'b',
        url: 'http://api.example.com/b',
        adapter: ok,
    });

    await expect(a()).resolves.toEqual({ ok: true });
    await expect(b()).resolves.toEqual({ ok: true });
    // Let the rejected load settle, then run once more: the sinks are inert, not throwing.
    await vi.waitFor(() => {
        expect(warn).toHaveBeenCalled();
    });
    await expect(a()).resolves.toEqual({ ok: true });

    // One warning for the process — not one per stitch or per call — naming the subpath and
    // carrying the loader's own reason.
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain('could not load `stitchapi/otlp`');
    expect(message).toMatch(/\(.+\)\.$/);
});

test('an exporter that fails to start warns once, and the run is unharmed', async () => {
    vi.doMock('../src/otlp', () => ({
        otlp: {
            sink: () => {
                throw new Error('bad endpoint');
            },
        },
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stitch = await freshStitch();
    const a = stitch({
        name: 'a',
        url: 'http://api.example.com/a',
        adapter: ok,
    });
    const b = stitch({
        name: 'b',
        url: 'http://api.example.com/b',
        adapter: ok,
    });

    await expect(a()).resolves.toEqual({ ok: true });
    await expect(b()).resolves.toEqual({ ok: true });
    await vi.waitFor(() => {
        expect(warn).toHaveBeenCalled();
    });
    await expect(a()).resolves.toEqual({ ok: true });

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain('could not start its exporter');
    expect(message).toContain('bad endpoint');
});

test('a sink that throws on replay is reported once, and later events still reach it', async () => {
    const seen: StitchEvent[] = [];
    let first = true;
    vi.doMock('../src/otlp', () => ({
        otlp: {
            sink: () => ({
                handle: (event: StitchEvent) => {
                    if (first) {
                        first = false;
                        throw new Error('sink exploded');
                    }
                    seen.push(event);
                },
            }),
        },
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stitch = await freshStitch();
    const getThing = stitch({
        name: 'thing',
        url: 'http://api.example.com/thing',
        adapter: ok,
    });

    await getThing();
    await vi.waitFor(() => {
        expect(warn).toHaveBeenCalled();
    });
    await expect(getThing()).resolves.toEqual({ ok: true });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('sink exploded');
    expect(seen.length).toBeGreaterThan(0); // the sink was set before the throw: later calls reach it
});

test('while the module loads, a sink holds a bounded number of events: the oldest are dropped, once reported', async () => {
    let release!: () => void;
    const loaded = new Promise<void>((resolve) => {
        release = resolve;
    });
    const seen: StitchEvent[] = [];
    vi.doMock('../src/otlp', async () => {
        await loaded;
        return {
            otlp: {
                sink: () => ({
                    handle: (event: StitchEvent) => {
                        seen.push(event);
                    },
                }),
            },
        };
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stitch = await freshStitch();
    const getThing = stitch({
        name: 'busy',
        url: 'http://api.example.com/thing',
        adapter: ok,
    });

    // Far more events than the hold keeps: a load that never finishes must not grow without bound.
    for (let i = 0; i < 400; i++) await getThing();
    expect(warn).toHaveBeenCalledTimes(1); // once, not once per dropped event
    expect(String(warn.mock.calls[0]![0])).toContain('1000');

    release();
    await vi.waitFor(() => {
        expect(seen.length).toBeGreaterThan(0);
    });
    expect(seen).toHaveLength(1000); // the newest 1000; the oldest were dropped
    expect(seen[seen.length - 1]!.type).toBe('done');
});

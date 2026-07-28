// Surface.execute — the transport-replacing hook (ADR 0008 Stage A). A surface may run its own
// transport INSTEAD of HTTP, at the same site inside the resilience chain, so retry/throttle/
// circuit/timeout/trace all wrap it; the absolute-URL guard is bypassed; and a BYO `adapter` is
// ignored when a surface carries `execute`.
import { stitch } from '../src';
import type { Adapter, AdapterRequest, Surface } from '../src';

// A minimal surface that replaces the transport with an in-memory function (no network). It packs
// `input.body` onto the request (the graphql precedent) and interprets the body as the value.
function execSurface(execute: Adapter): Surface {
    return {
        id: 'exec',
        buildRequest: (_cfg, input, base) => ({ ...base, body: input.body }),
        execute,
    };
}

test('execute replaces the transport (no HTTP) and flows through to the result', async () => {
    const seen: AdapterRequest[] = [];
    const execute: Adapter = async (req) => {
        seen.push(req);
        return { status: 200, headers: {}, body: { echoed: req.body } };
    };
    // A non-http `url` would normally fail the absolute-URL guard — `execute` bypasses it.
    const s = stitch({
        name: 'echo',
        url: 'exec://echo',
        kind: execSurface(execute),
    });

    await expect(s({ body: { hi: 1 } })).resolves.toEqual({
        echoed: { hi: 1 },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('exec://echo');
});

test('the resilience chain wraps execute — a retry-on-status re-runs it', async () => {
    let n = 0;
    const execute: Adapter = async () => {
        n += 1;
        return n === 1
            ? { status: 503, headers: {}, body: {} }
            : { status: 200, headers: {}, body: { ok: true } };
    };
    const s = stitch({
        name: 'flaky-exec',
        url: 'exec://x',
        kind: execSurface(execute),
        retry: { attempts: 3, on: [503], backoff: { curve: 'fixed', base: 1 } },
    });

    await expect(s()).resolves.toEqual({ ok: true });
    expect(n).toBe(2); // retried exactly once, through the standard chain
});

test('a surface with execute ignores a BYO adapter', async () => {
    let adapterCalled = false;
    const adapter: Adapter = async () => {
        adapterCalled = true;
        return { status: 200, headers: {}, body: { from: 'adapter' } };
    };
    const execute: Adapter = async () => ({
        status: 200,
        headers: {},
        body: { from: 'execute' },
    });
    const s = stitch({
        name: 'x',
        url: 'exec://x',
        kind: execSurface(execute),
        adapter,
    });

    await expect(s()).resolves.toEqual({ from: 'execute' });
    expect(adapterCalled).toBe(false);
});

test('a non-2xx from execute throws like any HTTP failure (interpret/error path)', async () => {
    const execute: Adapter = async () => ({
        status: 500,
        headers: {},
        body: { error: 'boom' },
    });
    const s = stitch({
        name: 'x',
        url: 'exec://x',
        kind: execSurface(execute),
    });

    await expect(s()).rejects.toMatchObject({ status: 500 });
});

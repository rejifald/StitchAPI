// ADR 0019 — `.report()` (the enhanced result object) + the `source` discriminator.
// Two surfaces under test:
//   - `source` on `Inspection<T>` (also returned by `.inspect()`): 'live' for a default probe,
//     'stream' for a streaming surface (raw null), 'cache' for a warmed cache hit (raw null).
//   - `.report()`: a `RunReport<T>` (an Inspection plus run diagnostics) — `attempts`, `timing.ms`,
//     the REDACTED `config` (never `__rawConfig`), and the fine-grained `cache` outcome
//     (bypass / miss / hit / disabled). Like `.inspect()` it never throws on a hard contract
//     violation — it returns with `error` set and the diagnostics populated.
import { StitchError, stitch } from '../src';
import type { Adapter } from '../src';
import { bearer } from '../src/auth';
import { stream } from '../src/stream';
import { asValidator } from './support/schema';
import { streamAdapter, streamOf } from './support/streams';

import { z } from 'zod';

const URL = 'https://api.test/resource';

// A counting adapter returning a fixed body. `failTimes` lets the first N calls return a retryable
// 503, so a `retry` policy can be observed in `attempts`.
function counting(
    body: unknown,
    opts?: { status?: number; failTimes?: number },
): { adapter: Adapter; calls: () => number } {
    let calls = 0;
    let failed = 0;
    const adapter: Adapter = async () => {
        calls += 1;
        if (opts?.failTimes && failed < opts.failTimes) {
            failed += 1;
            return { status: 503, headers: {}, body: { error: 'try again' } };
        }
        return {
            status: opts?.status ?? 200,
            headers: {},
            body: typeof body === 'function' ? (body as () => unknown)() : body,
        };
    };
    return { adapter, calls: () => calls };
}

// ===========================================================================
// `source` — the interpretant of `raw`.
// ===========================================================================

// ---------------------------------------------------------------------------
// 1. Default `.inspect()` → source 'live' (a real request ran; raw populated).
// ---------------------------------------------------------------------------
test('source: a default .inspect() is "live" with raw populated', async () => {
    const { adapter } = counting({ n: 1 });
    const s = stitch({
        url: URL,
        adapter,
        trace: false,
        output: asValidator(z.object({ n: z.number() })),
    });
    const r = await s.inspect();
    expect(r.source).toBe('live');
    expect(r.raw).toEqual({ n: 1 });
});

// ---------------------------------------------------------------------------
// 2. Streaming surface → source 'stream', raw null (no single buffered body).
// ---------------------------------------------------------------------------
test('source: a streaming surface is "stream" with raw null', async () => {
    const s = stream({
        url: 'https://x.test/s',
        trace: false,
        stream: { decode: 'lines' },
        adapter: streamAdapter(streamOf(['a\n', 'b\n', 'c'])),
    });
    const r = await s.inspect();
    expect(r.source).toBe('stream');
    expect(r.raw).toBeNull();
    expect(r.data).toEqual(['a', 'b', 'c']);
});

// ---------------------------------------------------------------------------
// 3. A warmed cache hit (`.inspect({ cache: true })`) → source 'cache', raw null.
// ---------------------------------------------------------------------------
test('source: a cache hit is "cache" with raw null', async () => {
    const { adapter, calls } = counting({ n: 1 });
    const s = stitch({
        url: URL,
        adapter,
        trace: false,
        cache: { ttl: '60s', scope: 'app' },
    });
    expect(await s()).toEqual({ n: 1 }); // warm the cache
    expect(calls()).toBe(1);

    const r = await s.inspect(undefined, { cache: true }); // served from cache
    expect(calls()).toBe(1); // no new origin call
    expect(r.source).toBe('cache');
    expect(r.raw).toBeNull();
    expect(r.data).toEqual({ n: 1 });
});

// ===========================================================================
// `.report()` — the enhanced result object.
// ===========================================================================

// ---------------------------------------------------------------------------
// 4. A report carries the Inspection fields PLUS diagnostics; timing.ms is a number.
// ---------------------------------------------------------------------------
test('report: inspection fields + attempts + timing.ms (number) + source', async () => {
    const { adapter } = counting({ n: '42' });
    const s = stitch({
        url: URL,
        adapter,
        trace: false,
        output: asValidator(z.object({ n: z.coerce.number() })),
    });
    const r = await s.report();
    expect(r.data).toEqual({ n: 42 });
    expect(r.raw).toEqual({ n: '42' });
    expect(r.status).toBe(200);
    expect(r.error).toBeNull();
    expect(r.source).toBe('live');
    expect(r.attempts).toBe(1);
    expect(typeof r.timing.ms).toBe('number');
});

// ---------------------------------------------------------------------------
// 5. attempts reflects retries.
// ---------------------------------------------------------------------------
test('report: attempts reflects retries', async () => {
    const { adapter } = counting({ n: 1 }, { failTimes: 2 }); // 2 × 503, then 200
    const s = stitch({
        url: URL,
        adapter,
        trace: false,
        retry: { attempts: 3, baseMs: 0 },
    });
    const r = await s.report();
    expect(r.error).toBeNull();
    expect(r.attempts).toBe(3); // first + 2 retries
});

// ---------------------------------------------------------------------------
// 6. config is present and REDACTED — auth stripped (authScheme projected), and it is NOT
//    `__rawConfig` (the live `auth` strategy / `adapter` / `store` are absent).
// ---------------------------------------------------------------------------
test('report: config is the REDACTED __config, never __rawConfig', async () => {
    const { adapter } = counting({ ok: true });
    const s = stitch({
        url: URL,
        adapter,
        trace: false,
        auth: bearer(() => 'super-secret-token'),
    });
    const r = await s.report();
    expect(r.config).toBeDefined();
    // The live, secret-bearing handles are stripped (this is __config, not __rawConfig).
    expect('auth' in r.config).toBe(false);
    expect('adapter' in r.config).toBe(false);
    expect('store' in r.config).toBe(false);
    // The non-secret auth SCHEME is projected on instead — proof redaction ran.
    expect(r.config.authScheme).toEqual({ type: 'http', scheme: 'bearer' });
    // It is the stitch's own redacted __config, and the raw token never appears anywhere in it.
    expect(r.config).toEqual(s.__config);
    expect(JSON.stringify(r.config)).not.toContain('super-secret-token');
});

// ---------------------------------------------------------------------------
// 7. cache outcome — 'bypass' (the default probe on a cached stitch skips the cache).
// ---------------------------------------------------------------------------
test('report: cache is "bypass" by default on a cached stitch', async () => {
    const { adapter, calls } = counting({ n: 1 });
    const s = stitch({
        url: URL,
        adapter,
        trace: false,
        cache: { ttl: '60s', scope: 'app' },
    });
    const r = await s.report(); // default → bypassCache
    expect(r.cache).toBe('bypass');
    expect(r.source).toBe('live');
    expect(calls()).toBe(1); // a live call ran
});

// ---------------------------------------------------------------------------
// 8. cache outcome — 'miss' then 'hit' under `{ cache: true }`.
// ---------------------------------------------------------------------------
test('report: cache is "miss" then "hit" with { cache: true }', async () => {
    const { adapter } = counting({ n: 1 });
    const s = stitch({
        url: URL,
        adapter,
        trace: false,
        cache: { ttl: '60s', scope: 'app' },
    });
    const miss = await s.report(undefined, { cache: true }); // cold cache → miss
    expect(miss.cache).toBe('miss');
    expect(miss.source).toBe('live'); // a real request ran on the miss

    const hit = await s.report(undefined, { cache: true }); // warm now → hit
    expect(hit.cache).toBe('hit');
    expect(hit.source).toBe('cache');
    expect(hit.raw).toBeNull();
});

// ---------------------------------------------------------------------------
// 9. cache outcome — 'disabled' when no cache block is configured.
// ---------------------------------------------------------------------------
test('report: cache is "disabled" when the stitch has no cache block', async () => {
    const { adapter } = counting({ n: 1 });
    const s = stitch({ url: URL, adapter, trace: false });
    const r = await s.report();
    expect(r.cache).toBe('disabled');
});

// ---------------------------------------------------------------------------
// 10. A hard contract violation still RETURNS (never throws): error set, diagnostics populated.
// ---------------------------------------------------------------------------
test('report: a hard contract violation returns with error + diagnostics', async () => {
    const { adapter } = counting({ id: '1' }); // schema wants a number
    const s = stitch({
        url: URL,
        adapter,
        trace: false,
        output: asValidator(z.object({ id: z.number() })),
    });
    const r = await s.report();
    expect(r.data).toBeNull();
    expect(r.error).toBeInstanceOf(StitchError);
    expect(r.raw).toEqual({ id: '1' }); // raw recovered off the pinned error
    expect(r.status).toBe(200);
    expect(r.source).toBe('live');
    expect(r.attempts).toBe(1);
    expect(typeof r.timing.ms).toBe('number');
    expect(r.cache).toBe('disabled');
    expect(
        r.findings.some((f) => f.change === 'invalid' && f.level === 'error'),
    ).toBe(true);
});

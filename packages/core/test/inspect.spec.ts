// `.inspect()` (ADR 0016): probe a fresh call and return an `Inspection<T>` —
// `{ value, raw, findings, status, error }` — WITHOUT throwing. It surfaces the pre-validation `raw`
// body alongside the validated `value` and the soft/hard drift `findings` diffed between them. These
// exercise it end-to-end through the engine against a counting adapter:
//   - primitive / array / object `T`: `value` + `raw` both populate;
//   - coerced / defaulted / undeclared findings ride the wrapper; `raw` is the untouched body;
//   - a hard contract violation returns `value: null` + `error` with `raw` + `findings` still set;
//   - `raw` is NON-ENUMERABLE: `JSON.stringify(wrapper)` and `{ ...wrapper }` both exclude it;
//   - the default `.inspect()` neither reads nor writes the cache (repeatable); `{ cache: true }`
//     honours the policy and `raw` is `null` on a hit;
//   - a streaming surface yields `raw: null` (no buffered body); `value` + `status` still populate.
import { StitchError, drift, stitch } from '../src';
import type { Adapter } from '../src';
import { stream } from '../src/stream';
import { asValidator } from './support/schema';
import { streamAdapter, streamOf } from './support/streams';

import { z } from 'zod';

const URL = 'https://api.test/resource';

// A counting adapter returning a fixed body — "the origin ran" is observable as a bumped count, so a
// cache read/write is visible as a call that did / didn't reach the origin. `body` may be a thunk so a
// route can vary per call (unused here; every test wants a stable body).
function counting(
    body: unknown,
    opts?: { status?: number; headers?: Record<string, string> },
): { adapter: Adapter; calls: () => number } {
    let calls = 0;
    const adapter: Adapter = async () => {
        calls += 1;
        return {
            status: opts?.status ?? 200,
            headers: opts?.headers ?? {},
            body: typeof body === 'function' ? (body as () => unknown)() : body,
        };
    };
    return { adapter, calls: () => calls };
}

// ---------------------------------------------------------------------------
// 1. Primitive T — `value` and `raw` are the primitive; a plain schema drifts nothing.
// ---------------------------------------------------------------------------
test('primitive T: value + raw are the primitive, no findings', async () => {
    const { adapter } = counting(42);
    const s = stitch({
        url: URL,
        adapter,
        trace: false,
        output: asValidator(z.number()),
    });
    const r = await s.inspect();
    expect(r.data).toBe(42);
    expect(r.raw).toBe(42);
    expect(r.status).toBe(200);
    expect(r.error).toBeNull();
    expect(r.findings).toEqual([]);
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- the @deprecated `value` alias is co-set with `data` until the GA cut (CONTRACT.md P5)
    expect(r.value).toBe(42); // back-compat alias parity
});

// ---------------------------------------------------------------------------
// 2. Array T — the attachment problem the ADR names (you can't pin a prop to an array): the wrapper
//    holds it in `value`, with `raw` the same array.
// ---------------------------------------------------------------------------
test('array T: value + raw are the array', async () => {
    const { adapter } = counting([{ id: 1 }, { id: 2 }]);
    const s = stitch({
        url: URL,
        adapter,
        trace: false,
        output: asValidator(z.array(z.object({ id: z.number() }))),
    });
    const r = await s.inspect();
    expect(r.data).toEqual([{ id: 1 }, { id: 2 }]);
    expect(r.raw).toEqual([{ id: 1 }, { id: 2 }]);
    expect(r.error).toBeNull();
});

// ---------------------------------------------------------------------------
// 3. Object T — coerced / defaulted / undeclared findings all ride the wrapper, and `raw` is the
//    UNTOUCHED pre-validation body (string `n`, the stripped `extra`, no `m`).
// ---------------------------------------------------------------------------
test('object T: coerced + defaulted + undeclared findings ride the wrapper; raw is untouched', async () => {
    const { adapter } = counting({ n: '42', extra: 'x' });
    const s = stitch({
        url: URL,
        adapter,
        trace: false,
        output: drift(
            z.object({ n: z.coerce.number(), m: z.number().default(5) }),
        ),
    });
    const r = await s.inspect();
    expect(r.data).toEqual({ n: 42, m: 5 }); // coerced + defaulted
    expect(r.raw).toEqual({ n: '42', extra: 'x' }); // the body, untouched by validation
    const changes = r.findings.map((f) => f.change);
    expect(changes).toContain('coerced'); // n: string -> number
    expect(changes).toContain('defaulted'); // m: default fired
    expect(changes).toContain('undeclared'); // extra: stripped
    expect(r.error).toBeNull();
});

// ---------------------------------------------------------------------------
// 4. Hard failure (contract violation) — never throws: `value: null` + a StitchError, with `raw` and
//    the `invalid`/error finding still recovered (the failure path normally drops the body).
// ---------------------------------------------------------------------------
test('hard-fail: value null + error + raw + findings', async () => {
    const { adapter } = counting({ id: '1' }); // schema wants a number
    const s = stitch({
        url: URL,
        adapter,
        trace: false,
        output: asValidator(z.object({ id: z.number() })),
    });
    const r = await s.inspect();
    expect(r.data).toBeNull();
    expect(r.error).toBeInstanceOf(StitchError);
    expect(r.raw).toEqual({ id: '1' });
    expect(
        r.findings.some((f) => f.change === 'invalid' && f.level === 'error'),
    ).toBe(true);
    expect(r.status).toBe(200);
});

// ---------------------------------------------------------------------------
// 5. `raw` is non-enumerable — JSON.stringify and spread both drop it, the other fields survive.
// ---------------------------------------------------------------------------
test('raw is non-enumerable: JSON.stringify(wrapper) and { ...wrapper } both exclude raw', async () => {
    const { adapter } = counting({ n: '42' });
    const s = stitch({
        url: URL,
        adapter,
        trace: false,
        output: drift(z.object({ n: z.coerce.number() })),
    });
    const r = await s.inspect();
    expect(r.raw).toEqual({ n: '42' }); // readable deliberately

    const json = JSON.parse(JSON.stringify(r)) as Record<string, unknown>;
    expect('raw' in json).toBe(false);
    expect(json['value']).toEqual({ n: 42 }); // the other fields DO serialise

    const spread = { ...r } as Record<string, unknown>;
    expect('raw' in spread).toBe(false);
    expect(spread['status']).toBe(200);
});

// ---------------------------------------------------------------------------
// 6. Default `.inspect()` bypasses the cache — neither READ nor WRITE — and is repeatable.
// ---------------------------------------------------------------------------
test('default .inspect() neither reads nor writes the cache (repeatable)', async () => {
    const { adapter, calls } = counting({ n: 1 });
    const s = stitch({
        url: URL,
        adapter,
        trace: false,
        cache: { ttl: '60s', scope: 'app' },
    });
    // Two inspects → two live origin calls: it never serves a prior entry (no read) ...
    await s.inspect();
    await s.inspect();
    expect(calls()).toBe(2);
    // ... and never warmed one (no write): the next AWAIT is a miss (a third call) ...
    expect(await s()).toEqual({ n: 1 });
    expect(calls()).toBe(3);
    // ... which DID warm the cache — proving the store was reachable all along, and that only
    // `.inspect()` was holding off it: a second await is a hit, no fourth call.
    expect(await s()).toEqual({ n: 1 });
    expect(calls()).toBe(3);
});

// ---------------------------------------------------------------------------
// 7. `{ cache: true }` honours the policy; on a hit `raw` is null (the cache stores no raw body).
// ---------------------------------------------------------------------------
test('{ cache: true }: a cache hit yields value but raw null', async () => {
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
    expect(calls()).toBe(1); // no new origin call — it read the entry
    expect(r.data).toEqual({ n: 1 });
    expect(r.raw).toBeNull(); // the cache holds { value, status }, never raw
    expect(r.status).toBe(200);
    expect(r.error).toBeNull();
});

// ---------------------------------------------------------------------------
// 8. Streaming surface — `raw` is null (the engine refuses to buffer the delta spine); `value`
//    (the collected chunks) and `status` still populate.
// ---------------------------------------------------------------------------
test('streaming surface: raw is null; value (chunks) + status populate', async () => {
    const s = stream({
        url: 'https://x.test/s',
        trace: false,
        stream: { decode: 'lines' },
        adapter: streamAdapter(streamOf(['a\n', 'b\n', 'c'])),
    });
    const r = await s.inspect();
    expect(r.raw).toBeNull();
    expect(r.data).toEqual(['a', 'b', 'c']);
    expect(r.status).toBe(200);
    expect(r.error).toBeNull();
});

// ---------------------------------------------------------------------------
// 9. `.inspect()` joins the `.with()` re-bind list — a bound stitch inspects with the bound input.
// ---------------------------------------------------------------------------
test('.with(...).inspect() composes with partial-input binding', async () => {
    const { adapter } = counting({ ok: true });
    const s = stitch({
        url: URL,
        adapter,
        trace: false,
        output: asValidator(z.object({ ok: z.boolean() })),
    }).with({ query: { page: 1 } });
    const r = await s.inspect();
    expect(r.data).toEqual({ ok: true });
    expect(r.raw).toEqual({ ok: true });
    expect(r.error).toBeNull();
});

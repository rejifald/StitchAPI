// P20 (No empty-object config): every `StitchConfig` slot that used to be a bare all-optional
// `*Options` bag — `hooks`, `input`, `multipart`, `sse`, `stream`, and now `retry`, `throttle`,
// `timeout`, `circuit` and the nested `sse.reconnect` — rejects the opaque `{}` at the slot. The
// all-defaults case is the scalar (`sse: true`, `stream: 'ndjson'`, `multipart: 'dot'`, `retry: 3`,
// `timeout: '5s'`, `throttle: '2/s'`) or a real ≥1-field object; the empty object is a COMPILE
// error. These `@ts-expect-error` assertions are enforced by `check:types` (an unused directive
// would itself fail), not at runtime — the closures are never invoked.
import { stitch } from '../src';

test('the opaque `{}` is rejected at each Scalar|AtLeastOne slot (P20)', () => {
    const rejected = () => [
        stitch({
            baseUrl: 'https://x',
            path: '/y',
            // @ts-expect-error — `hooks: {}` is rejected; set at least one lifecycle hook.
            hooks: {},
        }),
        stitch({
            baseUrl: 'https://x',
            path: '/y',
            // @ts-expect-error — `input: {}` is rejected; set at least one input schema.
            input: {},
        }),
        stitch({
            baseUrl: 'https://x',
            path: '/y',
            wire: {
                body: 'multipart',
                // @ts-expect-error — `multipart: {}` is rejected; use `'dot'` or set `nesting`.
                multipart: {},
            },
        }),
        stitch({
            baseUrl: 'https://x',
            path: '/y',
            // @ts-expect-error — the opaque `wire: {}` is rejected; set at least one field (P20).
            wire: {},
        }),
        stitch({
            baseUrl: 'https://x',
            path: '/y',
            // @ts-expect-error — `sse: {}` is rejected; use `true` or set `reconnect`.
            sse: {},
        }),
        stitch({
            baseUrl: 'https://x',
            path: '/y',
            // @ts-expect-error — `stream: {}` is rejected; use `'ndjson'` or set `decode`.
            stream: {},
        }),
        stitch({
            baseUrl: 'https://x',
            path: '/y',
            // @ts-expect-error — `retry.backoff: {}` is rejected; use a curve or set base/max.
            retry: { attempts: 2, backoff: {} },
        }),
        stitch({
            baseUrl: 'https://x',
            path: '/y',
            // @ts-expect-error — `retry: {}` is rejected; use `retry: 3` or set a field.
            retry: {},
        }),
        stitch({
            baseUrl: 'https://x',
            path: '/y',
            // @ts-expect-error — `throttle: {}` is rejected; use `'2/s'` or set a field.
            throttle: {},
        }),
        stitch({
            baseUrl: 'https://x',
            path: '/y',
            // @ts-expect-error — `timeout: {}` is rejected; use `'5s'` or set `total`/`perAttempt`.
            timeout: {},
        }),
        stitch({
            baseUrl: 'https://x',
            path: '/y',
            // @ts-expect-error — `sse.reconnect: {}` is rejected; use `true` or set a field.
            sse: { reconnect: {} },
        }),
        stitch({
            baseUrl: 'https://x',
            path: '/y',
            // @ts-expect-error — `circuit: {}` is rejected; both fields are required (P15).
            circuit: {},
        }),
    ];
    // The assertions that matter are the @ts-expect-error directives above (checked by `check:types`).
    expect(typeof rejected).toBe('function');
});

test('the scalar / ≥1-field forms are accepted at each slot (P12/P13/P20)', () => {
    const accepted = () => [
        // `wire.body: 'multipart'` is required alongside `wire.multipart` — the slot is read only on a
        // multipart body, so the pairing is enforced statically. The shorthand under test is the
        // bare `'dot'` string standing in for `{ nesting: 'dot' }` (P12).
        stitch({
            baseUrl: 'https://x',
            path: '/y',
            wire: { body: 'multipart', multipart: 'dot' },
        }),
        stitch({ baseUrl: 'https://x', path: '/y', stream: 'ndjson' }),
        stitch({ baseUrl: 'https://x', path: '/y', sse: true }),
        stitch({ baseUrl: 'https://x', path: '/y', sse: { reconnect: true } }),
        stitch({
            baseUrl: 'https://x',
            path: '/y',
            hooks: { onRequest: () => undefined },
        }),
        // P24/P12: `retry.backoff` takes the bare curve or a ≥1-field envelope.
        stitch({
            baseUrl: 'https://x',
            path: '/y',
            retry: { backoff: 'expo' },
        }),
        stitch({
            baseUrl: 'https://x',
            path: '/y',
            retry: { backoff: { curve: 'expo', base: '1s', max: '10s' } },
        }),
        stitch({
            baseUrl: 'https://x',
            path: '/y',
            retry: { backoff: { base: 5 } },
        }),
    ];
    expect(typeof accepted).toBe('function');
});

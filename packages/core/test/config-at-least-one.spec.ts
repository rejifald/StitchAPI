// P20 (No empty-object config): the five `StitchConfig` slots that used to be a bare all-optional
// `*Options` bag — `hooks`, `input`, `multipart`, `sse`, `stream` — now reject the opaque `{}` at
// the slot. The all-defaults case is the scalar (`sse: true`, `stream: 'ndjson'`, `multipart: 'dot'`)
// or a real ≥1-field object; the empty object is a COMPILE error. These `@ts-expect-error` assertions
// are enforced by `check:types` (an unused directive would itself fail), not at runtime — the
// closures are never invoked.
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
            // @ts-expect-error — `multipart: {}` is rejected; use `'dot'` or set `nesting`.
            multipart: {},
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
    ];
    // The assertions that matter are the @ts-expect-error directives above (checked by `check:types`).
    expect(typeof rejected).toBe('function');
});

test('the scalar / ≥1-field forms are accepted at each slot (P12/P13/P20)', () => {
    const accepted = () => [
        stitch({ baseUrl: 'https://x', path: '/y', multipart: 'dot' }),
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

// P20 (No empty-object config): every `StitchConfig` slot that used to be a bare all-optional
// `*Options` bag — `hooks`, `input`, `multipart`, `sse`, `stream`, `retry`, `throttle`,
// `timeout`, `circuit`, `extends` and the nested `sse.reconnect` — rejects the opaque `{}` at the
// slot. The all-defaults case is the scalar (`sse: true`, `stream: 'ndjson'`, `multipart: 'dot'`,
// `retry: 3`, `timeout: '5s'`, `throttle: '2/s'`) or a real ≥1-field object; the empty object is a
// COMPILE error. These `@ts-expect-error` assertions are enforced by `check:types` (an unused
// directive would itself fail), not at runtime — the closures are never invoked.
import { stitch } from '../src';
import type { SecurityScheme } from '../src/types';

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
            // @ts-expect-error — `timeout: {}` is rejected; use `'5s'` or set `total`/`each`.
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
            // @ts-expect-error — `circuit: {}` is rejected: an opaque envelope says nothing that
            // `circuit: [5, '30s']` does not say better. Both fields DEFAULT (5 / 30s), so either
            // one alone is a valid object form — see the accepted list below.
            circuit: {},
        }),
        stitch({
            baseUrl: 'https://x',
            path: '/y',
            // @ts-expect-error — `extends: {}` is rejected; an empty layer merges nothing.
            extends: {},
        }),
        stitch({
            baseUrl: 'https://x',
            path: '/y',
            // @ts-expect-error — and inside the list form too, at every element.
            extends: [{}],
        }),
        stitch({
            baseUrl: 'https://x',
            path: '/y',
            // @ts-expect-error — a non-empty sibling does not launder an empty one.
            extends: [{ headers: { a: 'b' } }, {}],
        }),
        stitch({
            baseUrl: 'https://x',
            path: '/y',
            // @ts-expect-error — `cache.fingerprint: {}` is rejected; use a version tag or set a field.
            cache: { ttl: '60s', fingerprint: {} },
        }),
        stitch({
            baseUrl: 'https://x',
            path: '/y',
            transform: (b) => b,
            // @ts-expect-error — the nested `fingerprint.transform: {}` is rejected too; name a
            // version or set `trust`. P20 holds at both depths of the two-level slot.
            cache: { ttl: '60s', fingerprint: { transform: {} } },
        }),
    ];
    // The assertions that matter are the @ts-expect-error directives above (checked by `check:types`).
    expect(typeof rejected).toBe('function');
});

test('the scalar / ≥1-field forms are accepted at each slot (P12/P13/P20)', () => {
    const accepted = () => [
        // `wire.body: 'multipart'` is required alongside `wire.multipart` — the slot is read only
        // on a multipart body, so the pairing is enforced statically. The shorthand under test is
        // the bare `'dot'` string standing in for `{ nesting: 'dot' }` (P12).
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
        // P24/P12: `cache.fingerprint` and the `transform` inside it each take the bare version tag
        // or a ≥1-field envelope — the same shorthand, one level apart.
        stitch({
            baseUrl: 'https://x',
            path: '/y',
            cache: { ttl: '60s', fingerprint: 3 },
        }),
        stitch({
            baseUrl: 'https://x',
            path: '/y',
            transform: (b) => b,
            cache: { ttl: '60s', fingerprint: { transform: 3 } },
        }),
        stitch({
            baseUrl: 'https://x',
            path: '/y',
            transform: (b) => b,
            cache: { ttl: '60s', fingerprint: { transform: { trust: true } } },
        }),
        stitch({
            baseUrl: 'https://x',
            path: '/y',
            cache: { ttl: '60s', fingerprint: { fallback: 'revalidate' } },
        }),
        // P15/P20: `circuit`'s two knobs both DEFAULT (5 / 30s), so either alone is a complete
        // object form. Only the empty envelope is rejected.
        stitch({ baseUrl: 'https://x', path: '/y', circuit: { failures: 3 } }),
        stitch({
            baseUrl: 'https://x',
            path: '/y',
            circuit: { cooldown: '1m' },
        }),
        stitch({
            baseUrl: 'https://x',
            path: '/y',
            circuit: { key: 'shared' },
        }),
        // P7/P20: `extends` takes a string, one ≥1-field partial, a stitch, or a list of those.
        stitch({ baseUrl: 'https://x', extends: '/y' }),
        stitch({ path: '/y', extends: { baseUrl: 'https://x' } }),
        stitch({
            path: '/y',
            extends: [{ baseUrl: 'https://x' }, { headers: { a: 'b' } }],
        }),
    ];
    expect(typeof accepted).toBe('function');
});

// P20 reaches past `StitchConfig`: `SecurityScheme`'s oauth2 arm carries exactly one flow, so
// `flows: {}` would be a scheme that declares oauth2 and then describes nothing. The member is
// required, which is what makes the empty literal a compile error rather than a silent export of
// `{ type: 'oauth2', flows: {} }` into `components.securitySchemes`.
test("`SecurityScheme`'s oauth2 arm requires its one flow (P20)", () => {
    const flow = {
        tokenUrl: 'https://id.example.com/token',
        scopes: { read: 'Read' },
    };
    const accepted: SecurityScheme = {
        type: 'oauth2',
        flows: { clientCredentials: flow },
    };
    const rejected = (): SecurityScheme => ({
        type: 'oauth2',
        // @ts-expect-error — `flows: {}` is rejected; `clientCredentials` is required.
        flows: {},
    });
    expect(accepted.type).toBe('oauth2');
    expect(typeof rejected).toBe('function');
});

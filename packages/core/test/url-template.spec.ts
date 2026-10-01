// The `start` event's `template` (#900): the stitch's low-cardinality PATH template, which the OTLP
// sink turns into an attempt span's `{method} {url.template}` name. It is derived from the config as
// written — never from the input — so an expanded value, a query or a credential cannot reach it.
// The table pins the derivation rule; a custom adapter stands in for the network, so a config the
// real transport would refuse (userinfo in the URL) can still be exercised.
import { stitch } from '../src';
import type { Adapter, StitchEvent } from '../src';

const adapter: Adapter = async (req) => ({
    status: 200,
    headers: {},
    body: {},
    url: req.url,
});

// The `template` of the one `start` event a call emits.
async function templateOf(
    s: { stream(input?: object): AsyncIterable<StitchEvent> },
    input?: object,
): Promise<string | undefined> {
    let start: Extract<StitchEvent, { type: 'start' }> | undefined;
    for await (const ev of s.stream(input)) {
        if (ev.type === 'start') start = ev;
    }
    expect(start).toBeDefined();
    return start?.template;
}

const BASE = 'https://api.example.com';

describe('derived from path and baseUrl', () => {
    test.each([
        [
            'a templated path',
            { baseUrl: BASE, path: '/users/{id}' },
            '/users/{id}',
        ],
        [
            'a literal path (the declared route)',
            { baseUrl: BASE, path: '/users' },
            '/users',
        ],
        ['a baseUrl and no path: the root', { baseUrl: BASE }, '/'],
        [
            'the static baseUrl path prefix, slashes joined',
            { baseUrl: `${BASE}/v2/`, path: 'users/{id}' },
            '/v2/users/{id}',
        ],
        [
            'baseUrl userinfo and port',
            {
                baseUrl: 'https://u:hunter2@api.example.com:8443',
                path: '/users',
            },
            '/users',
        ],
        [
            'a {?q,sort} query operator',
            { baseUrl: BASE, path: '/search{?q,sort}' },
            '/search',
        ],
        [
            'a literal query, whatever follows it',
            { baseUrl: BASE, path: '/search?api_key=hunter2&q={q}' },
            '/search',
        ],
        [
            'a {#frag} operator, with {/segments*} kept',
            { baseUrl: BASE, path: '/files{/segments*}{#frag}' },
            '/files{/segments*}',
        ],
        [
            'an absolute path, which ignores baseUrl',
            {
                baseUrl: 'https://other.example.com/v9',
                path: `${BASE}/orgs/{org}`,
            },
            '/orgs/{org}',
        ],
    ])('%s', async (_label, config, expected) => {
        expect(
            await templateOf(stitch({ name: 't', adapter, ...config })),
        ).toBe(expected);
    });
});

describe('derived from url', () => {
    test.each([
        [
            'scheme, userinfo, host, port, query and fragment are dropped',
            'https://u:hunter2@api.example.com:8443/orgs/{org}?token=hunter2#top',
            '/orgs/{org}',
        ],
        [
            'a templated host is authority too',
            'https://{tenant}.example.com/orgs/{org}',
            '/orgs/{org}',
        ],
        [
            'a relative templated url',
            '/orgs/{org}/members',
            '/orgs/{org}/members',
        ],
        [
            'a {?q} operator',
            'https://api.example.com/orgs/{org}{?q}',
            '/orgs/{org}',
        ],
        [
            'a scheme-relative url: userinfo, host and port are authority too',
            '//u:hunter2@api.example.com:8443/orgs/{org}',
            '/orgs/{org}',
        ],
        [
            'a scheme-relative url with a templated host',
            '//{tenant}.example.com/orgs/{org}',
            '/orgs/{org}',
        ],
    ])('%s', async (_label, url, expected) => {
        expect(await templateOf(stitch({ name: 't', adapter, url }))).toBe(
            expected,
        );
    });
});

describe('no template is known', () => {
    test.each([
        [
            'an absolute literal url (a path may be an id or a secret)',
            { url: `${BASE}/users/42` },
        ],
        [
            'an absolute literal url with only a query',
            { url: `${BASE}/users?q={q}` },
        ],
        [
            'a scheme-relative literal url (one URL, whose path may be an id)',
            { url: '//u:hunter2@api.example.com/users/42' },
        ],
        [
            'a function url, even one returning a template',
            { url: () => `${BASE}/users/{id}` },
        ],
        [
            'a function baseUrl (its path prefix is unknown)',
            { baseUrl: () => BASE, path: '/users/{id}' },
        ],
    ])('%s', async (_label, config) => {
        expect(
            await templateOf(stitch({ name: 't', adapter, ...config })),
        ).toBeUndefined();
    });

    test('a surface that replaces the transport has none', async () => {
        const shell = stitch({
            name: 't',
            url: 'shell:git/{sub}',
            kind: { id: 'shell', execute: adapter },
        });
        expect(await templateOf(shell)).toBeUndefined();
    });
});

test('a scheme-relative url never lets its userinfo into the template', async () => {
    const template = await templateOf(
        stitch({
            name: 't',
            adapter,
            url: '//u:hunter2@api.example.com/orgs/{org}',
        }),
    );
    expect(template).not.toContain('hunter2');
    expect(template).not.toContain('@');
});

test('only the config is read: an expanded value never reaches the template', async () => {
    const s = stitch({
        name: 't',
        adapter,
        baseUrl: BASE,
        path: '/users/{id}{?token}',
    });
    const template = await templateOf(s, {
        params: { id: 'hunter2', token: 'hunter2' },
    });
    expect(template).toBe('/users/{id}');
});

// An unclosed `{&…` repeated is the input a backtracking pattern re-scans from every brace (CodeQL
// js/polynomial-redos): 5 000 repetitions already cost the `[^}]*` form ~0.8 s, so 20 000 would take
// ~13 s. The bound is generous for a linear pass and far below the quadratic one.
test.each([
    ['a path', { baseUrl: BASE, path: `/x${'{&a'.repeat(20_000)}` }],
    ['an authority', { url: `https://${'{&'.repeat(20_000)}` }],
])(
    'unclosed braces in %s are scanned in linear time',
    async (_label, config) => {
        const started = performance.now();
        await templateOf(stitch({ name: 't', adapter, ...config }));
        expect(performance.now() - started).toBeLessThan(1500);
    },
);

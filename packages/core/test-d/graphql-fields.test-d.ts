// `document` / `operationName` are read only by the graphql surface's `buildRequest`, so authoring
// either without selecting that surface is dead config — the document is dropped and a plain
// request goes out. CONTRACT.md P24 carve-out (b) requires a flat group to make its dead
// combinations unrepresentable, so those spellings must not typecheck.
import { graphql, graphqlSurface, seam, stitch } from '../src';
import type { Stitch } from '../src';

import { expectError, expectType } from 'tsd';

// ── Legal: the presets select the surface themselves ────────────────────────
const me = graphql({
    baseUrl: 'https://api.example.com',
    document: 'query Me { me { id } }',
});
expectType<Stitch<unknown>>(me);

graphql({
    baseUrl: 'https://api.example.com',
    document: 'query A { a } query B { b }',
    operationName: 'B',
});

const api = seam({ baseUrl: 'https://api.example.com' });
api.graphql({ document: 'query Me { me { id } }', operationName: 'Me' });

// ── Legal: the generic spelling, with the surface named explicitly ──────────
stitch({
    baseUrl: 'https://api.example.com',
    kind: graphqlSurface,
    document: 'query Me { me { id } }',
});

stitch({
    baseUrl: 'https://api.example.com',
    kind: graphqlSurface,
    document: 'query A { a } query B { b }',
    operationName: 'B',
});

api.stitch({ kind: graphqlSurface, document: 'query Me { me { id } }' });

// ── Legal: neither field, any surface ───────────────────────────────────────
stitch({ baseUrl: 'https://api.example.com', path: '/users' });

// ── Illegal: graphql-only fields with no graphql surface ────────────────────
expectError(
    stitch({
        baseUrl: 'https://api.example.com',
        path: '/users',
        document: 'query Me { me { id } }',
    }),
);

expectError(
    stitch({
        baseUrl: 'https://api.example.com',
        path: '/users',
        operationName: 'Me',
    }),
);

// A member stitch is guarded the same way — only `.graphql()` selects the surface.
expectError(api.stitch({ path: '/users', document: 'query Me { me { id } }' }));

// ── KNOWN LIMIT: the guard reads the config literal, not the composed result ──
// A surface inherited through `extends` is invisible to it, so this is a FALSE POSITIVE. Pinned so
// the limitation is a decision on record rather than a surprise — if `extends` walking is ever
// added, this expectation flips and the test names the place to update.
const gqlBase = { kind: graphqlSurface, baseUrl: 'https://api.example.com' };
expectError(stitch({ extends: [gqlBase], document: 'query Me { me { id } }' }));

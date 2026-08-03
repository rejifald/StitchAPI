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

// ── The guard reads the COMPOSED config, so `extends` counts ────────────────
// This used to be a false positive: the surface came from a fragment, the guard only saw the
// literal, and a valid config was rejected. It now walks the layer list.
const gqlBase = { kind: graphqlSurface, baseUrl: 'https://api.example.com' };
stitch({ extends: [gqlBase], document: 'query Me { me { id } }' });
stitch({ extends: [gqlBase], document: 'query A { a }', operationName: 'A' });

// Nested one level down: the flattener recurses, so the surface is still found.
stitch({
    extends: [{ extends: [gqlBase], headers: { 'x-a': '1' } }],
    document: 'query Me { me { id } }',
});

// ── Inherited from `Layers`, not introduced here ────────────────────────────
// The flattener destructures a TUPLE (`readonly [H, ...T]`), so an `extends` list that TypeScript
// widened to `Frag[]` — which is what a `const` binding does without `as const` — reads as empty,
// and so does the P7 single-fragment spelling (`extends: frag`, not a list). `InputOf` has read
// `extends` this way since #76; every existing test in `extends-inference.test-d.ts` uses an inline
// array literal, which stays a tuple. Both cases fail CLOSED here (a valid config is rejected), so
// they are pinned rather than left to surprise someone. Fixing them means widening `Flatten`, which
// changes call-argument inference for every consumer — deliberately out of scope for a guard change.
expectError(stitch({ extends: gqlBase, document: 'query Me { me { id } }' }));

const widened = [gqlBase]; // inferred `Frag[]`, not `[Frag]`
expectError(stitch({ extends: widened, document: 'query Me { me { id } }' }));

// …but a fragment chain that never selects the surface is still rejected.
const httpBase = { baseUrl: 'https://api.example.com', path: '/users' };
expectError(
    stitch({ extends: [httpBase], document: 'query Me { me { id } }' }),
);

// The `graphql` surface owns its body encoding: `buildRequest` always sends a JSON
// `{ query, variables, operationName? }` body (ADR 0005 Decision 1 — a surface owns *shaping*), so
// a `wire.body` authored alongside it is never read. That is dead config, so it must not typecheck.
//
// `wire.body: 'multipart'` is the arm worth naming: a GraphQL file upload is a real thing, but it
// is the `operations`/`map`/file-part envelope of the GraphQL multipart request spec — NOT this
// JSON body multipart-encoded. The surface does not implement that envelope, and rejecting the
// spelling is what keeps the gap honest rather than silently sending JSON.
//
// This file covers the SURFACE guard (`wire.body` is dead on graphql). The sibling
// `body-encoding.test-d.ts` covers the surface-agnostic one (`wire.multipart` needs
// `wire.body: 'multipart'`); the two intersect on graphql, which is what makes `wire.multipart`
// unreachable there for free.
import { graphql, seam, stitch } from '../src';
import type { Stitch } from '../src';
import { graphqlSurface } from '../src/surface';

import { expectError, expectType } from 'tsd';

const DOC = 'query Me { me { id } }';

// ── Legal: a graphql stitch that says nothing about the body encoding ───────
const me = graphql({ baseUrl: 'https://api.example.com', document: DOC });
expectType<Stitch<unknown>>(me);

// Every other config key is unaffected — only `wire.body` is claimed by the surface, so the rest of
// the envelope stays authorable.
graphql({
    baseUrl: 'https://api.example.com',
    document: DOC,
    method: 'POST',
    operationName: 'Me',
    headers: { 'x-api-key': 'k' },
    wire: { response: 'text', array: 'repeat' },
});

// ── Illegal: `wire.body` on the `graphql()` preset ──────────────────────────
expectError(
    graphql({
        baseUrl: 'https://api.example.com',
        document: DOC,
        wire: { body: 'multipart' },
    }),
);

// Not special to multipart — `form` is just as dead.
expectError(
    graphql({
        baseUrl: 'https://api.example.com',
        document: DOC,
        wire: { body: 'form' },
    }),
);

// Even the value the surface actually sends is rejected: it is the surface's to decide, and
// letting `wire.body: 'json'` through would imply the slot is read (it is not).
expectError(
    graphql({
        baseUrl: 'https://api.example.com',
        document: DOC,
        wire: { body: 'json' },
    }),
);

// A live sibling in the same envelope does not launder the rejected member.
expectError(
    graphql({
        baseUrl: 'https://api.example.com',
        document: DOC,
        wire: { body: 'form', response: 'text' },
    }),
);

// ── Illegal: the same config reached through the generic `stitch({ kind })` ──
// Positive control first: the identical config MINUS `wire.body` must typecheck, so the rejection
// below is attributable to the guard and not to the `kind`/`document` pairing itself.
stitch({
    baseUrl: 'https://api.example.com',
    kind: graphqlSurface,
    document: DOC,
});
stitch({
    baseUrl: 'https://api.example.com',
    kind: graphqlSurface,
    document: DOC,
    wire: { response: 'text' },
});
expectError(
    stitch({
        baseUrl: 'https://api.example.com',
        kind: graphqlSurface,
        document: DOC,
        wire: { body: 'multipart' },
    }),
);

// ── Legal: `wire.body` on any NON-graphql surface is untouched by this guard ──
const upload = stitch({
    method: 'POST',
    baseUrl: 'https://api.example.com',
    path: '/upload',
    wire: { body: 'multipart' },
});
expectType<Stitch<unknown>>(upload);

stitch({
    method: 'POST',
    baseUrl: 'https://api.example.com',
    path: '/x',
    wire: { body: 'form' },
});

// ── The guard binds every surface that authors a graphql stitch (CONTRACT.md P16) ──
const api = seam({ baseUrl: 'https://api.example.com' });

api.graphql({ document: DOC });
expectError(api.graphql({ document: DOC, wire: { body: 'multipart' } }));

// `graphql.bind(seam).stitch` is `Seam['graphql']`, so it inherits the same guard.
const bound = graphql.bind(api);
bound.stitch({ document: DOC });
expectError(bound.stitch({ document: DOC, wire: { body: 'multipart' } }));

// A seam member on the default (http) surface still takes any body encoding.
api.stitch({ path: '/upload', method: 'POST', wire: { body: 'multipart' } });

// ── The guard reads the COMPOSED config, so `extends` counts ────────────────
// `BodyTypeFixedByGraphql` walks `Layers<C>` like every other config guard (#597). It is the
// complement of `GraphqlOnlyOnGraphqlSurface` on the same surface: that one requires graphql
// before `document` is legal, this one forbids `wire.body` once graphql is selected.
const gqlBase = { kind: graphqlSurface, baseUrl: 'https://api.example.com' };

// Positive control: the fragment selects the surface, the literal says nothing about the encoding.
stitch({ extends: [gqlBase], document: DOC });

expectError(
    stitch({ extends: [gqlBase], document: DOC, wire: { body: 'form' } }),
);

// Nested one level down: the flattener recurses, so the surface is still found.
expectError(
    stitch({
        extends: [{ extends: [gqlBase], headers: { 'x-a': '1' } }],
        document: DOC,
        wire: { body: 'form' },
    }),
);

// ── Inherited from `Layers`, and fail-OPEN here ─────────────────────────────
// The tuple-destructuring limit `graphql-fields.test-d.ts` pins fails CLOSED there (the surface is
// the enabler, so an unseen layer rejects valid code) but OPEN here (the surface is the trigger, so
// an unseen layer only fails to catch dead config). Both spellings still typecheck.
//
// To isolate THIS guard the surface must live ONLY in the unseen fragment — naming `kind` on the
// literal would fire the guard from there and prove nothing about the layer walk.
const widened = [gqlBase]; // inferred `Frag[]`, not `[Frag]`
stitch({ extends: widened, wire: { body: 'form' } });

// Same, via the P7 single-fragment spelling.
stitch({ extends: gqlBase, wire: { body: 'form' } });

// ── The non-inferring fallback must not launder a rejected config ───────────
// A bare path string still reaches the loose overload unharmed.
expectType<Stitch<unknown>>(stitch('/plain'));

// A genuinely loose `string | Partial<StitchConfig>` argument stays the escape hatch it was.
declare const loose: string | Partial<import('../src').StitchConfig>;
expectType<Stitch<unknown>>(stitch(loose));

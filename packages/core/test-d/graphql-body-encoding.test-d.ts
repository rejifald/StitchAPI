// The `graphql` surface owns its body encoding: `buildRequest` always sends a JSON
// `{ query, variables, operationName? }` body (ADR 0005 Decision 1 — a surface owns *shaping*), so
// a `wire.body` authored alongside it is never read. That is dead config, so it must not typecheck.
//
// `wire.body: 'multipart'` is the arm worth naming: a GraphQL file upload is a real thing, but it
// is the `operations`/`map`/file-part envelope of the GraphQL multipart request spec — NOT this
// JSON body multipart-encoded. The surface does not implement that envelope, and rejecting the
// spelling is what keeps the gap honest rather than silently sending JSON.
//
// Only `wire.body` is claimed. The sibling wire slots are not body encodings, so they stay legal
// (`wire.response`, `wire.array`) — see the section at the end.
import { graphql, seam, stitch } from '../src';
import type { Stitch } from '../src';
import { graphqlSurface, httpSurface } from '../src/surface';

import { expectError, expectType } from 'tsd';

const DOC = 'query Me { me { id } }';

// ── Legal: a graphql stitch that says nothing about the body encoding ───────
const me = graphql({ baseUrl: 'https://api.example.com', document: DOC });
expectType<Stitch<unknown>>(me);

// Every other config key is unaffected — only `wire.body` is claimed by the surface.
graphql({
    baseUrl: 'https://api.example.com',
    document: DOC,
    method: 'POST',
    operationName: 'Me',
    headers: { 'x-api-key': 'k' },
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

// One guard closes both dead pairings. `MultipartOnlyOnMultipartBody` already requires
// `wire.body: 'multipart'` before `wire.multipart` is legal, and that spelling is exactly what
// this rejects — so `wire.multipart` is unreachable on graphql from either direction.
expectError(
    graphql({
        baseUrl: 'https://api.example.com',
        document: DOC,
        wire: { body: 'multipart', multipart: 'dot' },
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

// ── Legal: the sibling wire slots, which are not body encodings ─────────────
// The surface fixes the BODY only. `wire.response` reads the response, and `wire.array` governs
// the query string, so neither is dead config on graphql and neither is claimed by the guard.
graphql({
    baseUrl: 'https://api.example.com',
    document: DOC,
    wire: { response: 'text' },
});
graphql({
    baseUrl: 'https://api.example.com',
    document: DOC,
    wire: { array: 'repeat' },
});
graphql({
    baseUrl: 'https://api.example.com',
    document: DOC,
    wire: { response: 'text', array: 'repeat' },
});

// ── The guard reads the COMPOSED config, so `extends` counts ────────────────
// This used to be a false NEGATIVE: the surface came from a fragment, the guard only saw the
// literal, and dead config sailed through. It now walks the same layer list `InputOf` uses.
const gqlBase = { kind: graphqlSurface, baseUrl: 'https://api.example.com' };
expectError(stitch({ extends: [gqlBase], wire: { body: 'form' } }));

// Nested one level down: the flattener recurses, so the surface is still found.
expectError(
    stitch({
        extends: [{ extends: [gqlBase], headers: { 'x-a': '1' } }],
        wire: { body: 'multipart' },
    }),
);

// Positive control: the same fragment chain without a `wire.body` is legal, so the rejections
// above are attributable to the guard rather than to `extends` itself.
stitch({ extends: [gqlBase], document: DOC });
// …and the sibling wire slots stay legal through `extends` too.
stitch({ extends: [gqlBase], document: DOC, wire: { response: 'text' } });

// A fragment chain that never selects graphql leaves `wire.body` alone.
const httpBase = { baseUrl: 'https://api.example.com', path: '/upload' };
stitch({ extends: [httpBase], method: 'POST', wire: { body: 'multipart' } });

// ── POLARITY LIMIT: this guard's surface probe is an INHIBITOR ──────────────
// `AnyLayer` is existential by design, which is fail-OPEN for the sibling guards (finding the
// enabler makes a config legal). Here finding the surface makes a config ILLEGAL, so the same scan
// is fail-CLOSED: a config that inherits graphql and then overrides `kind` back to a non-graphql
// surface has a LIVE `wire.body` and is nevertheless rejected. Distinguishing it needs last-wins
// resolution of `kind` — the complexity the existential scan exists to avoid — and the config it
// costs is a perverse one (inherit a GraphQL base, then make it not GraphQL) with an obvious
// workaround. Pinned so the tradeoff is visible rather than latent.
//
// Positive control first: the identical override chain MINUS `wire.body` typechecks, so the
// rejection below is attributable to this guard and not to overriding `kind` through `extends`.
stitch({ extends: [gqlBase], kind: httpSurface, path: '/x' });
expectError(
    stitch({
        extends: [gqlBase],
        kind: httpSurface,
        wire: { body: 'form' },
    }),
);

// ── Inherited from `Layers`, not introduced here ────────────────────────────
// The flattener destructures a TUPLE, so an `extends` list widened to `Frag[]` (what a `const`
// binding does without `as const`) reads as empty, as does the P7 single-fragment spelling
// (`extends: frag`). `InputOf` has read `extends` this way since #76. Note these fail OPEN for this
// guard — the inverse of how they fail for `GraphqlOnlyOnGraphqlSurface`, and for the same polarity
// reason: an unreadable `extends` means the surface is not found, so dead config is ACCEPTED rather
// than a valid config rejected. Pinned as plain calls: they typecheck, and should not.
stitch({ extends: gqlBase, wire: { body: 'form' } });

const widened = [gqlBase]; // inferred `Frag[]`, not `[Frag]`
stitch({ extends: widened, wire: { body: 'form' } });

// The same fail-open applies to a fragment typed as `Partial<StitchConfig>` rather than inferred
// from its literal: optional properties satisfy no probe, so it reads as supplying nothing.
declare const opaque: Partial<import('../src').StitchConfig>;
stitch({ extends: [opaque], wire: { body: 'form' } });

// ── `NoWireBodyOnGraphql` fails open when the slot lives only in a fragment ──
// The error is surfaced by intersecting onto the config LITERAL, so a `wire.body` supplied entirely
// by a fragment is not reported (shared with `MultipartOnlyOnMultipartBody`). The literal-level
// case — the one people actually write — still errors precisely, as asserted far above.
graphql({
    baseUrl: 'https://api.example.com',
    document: DOC,
    extends: [{ wire: { body: 'form' } }],
});

// ── The non-inferring fallback must not launder a rejected config ───────────
// A bare path string still reaches the loose overload unharmed.
expectType<Stitch<unknown>>(stitch('/plain'));

// A genuinely loose `string | Partial<StitchConfig>` argument stays the escape hatch it was.
declare const loose: string | Partial<import('../src').StitchConfig>;
expectType<Stitch<unknown>>(stitch(loose));

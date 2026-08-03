// The `graphql` surface owns its body encoding: `buildRequest` always sends a JSON
// `{ query, variables, operationName? }` body (ADR 0005 Decision 1 — a surface owns *shaping*), so
// a `bodyType` authored alongside it is never read. That is dead config, so it must not typecheck.
//
// `bodyType: 'multipart'` is the arm worth naming: a GraphQL file upload is a real thing, but it
// is the `operations`/`map`/file-part envelope of the GraphQL multipart request spec — NOT this
// JSON body multipart-encoded. The surface does not implement that envelope, and rejecting the
// spelling is what keeps the gap honest rather than silently sending JSON.
import { graphql, seam, stitch } from '../src';
import type { Stitch } from '../src';
import { graphqlSurface } from '../src/surface';

import { expectError, expectType } from 'tsd';

const DOC = 'query Me { me { id } }';

// ── Legal: a graphql stitch that says nothing about the body encoding ───────
const me = graphql({ baseUrl: 'https://api.example.com', document: DOC });
expectType<Stitch<unknown>>(me);

// Every other config key is unaffected — only `bodyType` is claimed by the surface.
graphql({
    baseUrl: 'https://api.example.com',
    document: DOC,
    method: 'POST',
    operationName: 'Me',
    headers: { 'x-api-key': 'k' },
});

// ── Illegal: `bodyType` on the `graphql()` preset ───────────────────────────
expectError(
    graphql({
        baseUrl: 'https://api.example.com',
        document: DOC,
        bodyType: 'multipart',
    }),
);

// Not special to multipart — `form` is just as dead.
expectError(
    graphql({
        baseUrl: 'https://api.example.com',
        document: DOC,
        bodyType: 'form',
    }),
);

// Even the value the surface actually sends is rejected: it is the surface's to decide, and
// letting `bodyType: 'json'` through would imply the slot is read (it is not).
expectError(
    graphql({
        baseUrl: 'https://api.example.com',
        document: DOC,
        bodyType: 'json',
    }),
);

// ── Illegal: the same config reached through the generic `stitch({ kind })` ──
// Positive control first: the identical config MINUS `bodyType` must typecheck, so the rejection
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
        bodyType: 'multipart',
    }),
);

// ── Legal: `bodyType` on any NON-graphql surface is untouched by this guard ──
const upload = stitch({
    method: 'POST',
    baseUrl: 'https://api.example.com',
    path: '/upload',
    bodyType: 'multipart',
});
expectType<Stitch<unknown>>(upload);

stitch({
    method: 'POST',
    baseUrl: 'https://api.example.com',
    path: '/x',
    bodyType: 'form',
});

// ── The guard binds every surface that authors a graphql stitch (CONTRACT.md P16) ──
const api = seam({ baseUrl: 'https://api.example.com' });

api.graphql({ document: DOC });
expectError(api.graphql({ document: DOC, bodyType: 'multipart' }));

// `graphql.bind(seam).stitch` is `Seam['graphql']`, so it inherits the same guard.
const bound = graphql.bind(api);
bound.stitch({ document: DOC });
expectError(bound.stitch({ document: DOC, bodyType: 'multipart' }));

// A seam member on the default (http) surface still takes any body encoding.
api.stitch({ path: '/upload', method: 'POST', bodyType: 'multipart' });

// ── The non-inferring fallback must not launder a rejected config ───────────
// A bare path string still reaches the loose overload unharmed.
expectType<Stitch<unknown>>(stitch('/plain'));

// A genuinely loose `string | Partial<StitchConfig>` argument stays the escape hatch it was.
declare const loose: string | Partial<import('../src').StitchConfig>;
expectType<Stitch<unknown>>(stitch(loose));

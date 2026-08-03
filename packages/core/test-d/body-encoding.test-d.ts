// `wire.multipart` is read only when `wire.body` is `'multipart'` (CONTRACT.md P24 carve-out (b),
// enforced via the R8-recognised mutual-exclusion shape). Pairing it with any other body encoding
// is dead config, so it must not typecheck.
import { graphql, seam, stitch } from '../src';
import type { Stitch } from '../src';

import { expectError, expectType } from 'tsd';

// ── Legal: multipart options with a multipart body ──────────────────────────
const upload = stitch({
    method: 'POST',
    baseUrl: 'https://api.example.com',
    path: '/upload',
    wire: { body: 'multipart', multipart: 'dot' },
});
expectType<Stitch<unknown>>(upload);

// The object form is equally legal.
stitch({
    method: 'POST',
    baseUrl: 'https://api.example.com',
    path: '/upload',
    wire: { body: 'multipart', multipart: { nesting: 'bracket' } },
});

// ── Legal: any body encoding, so long as `multipart` is absent ──────────────
stitch({
    baseUrl: 'https://api.example.com',
    path: '/x',
    wire: { body: 'json' },
});
stitch({
    baseUrl: 'https://api.example.com',
    path: '/x',
    wire: { body: 'form' },
});
stitch({ baseUrl: 'https://api.example.com', path: '/x' });

// `wire.array` is legal on both urlencoded surfaces — the query string (any body) and a
// `wire.body: 'form'` body. It is NOT gated on the body encoding.
stitch({
    baseUrl: 'https://api.example.com',
    path: '/x',
    wire: { array: 'repeat' },
});
stitch({
    method: 'POST',
    baseUrl: 'https://api.example.com',
    path: '/x',
    wire: { body: 'form', array: 'brackets' },
});

// ── Illegal: multipart options on a non-multipart body ──────────────────────
expectError(
    stitch({
        method: 'POST',
        baseUrl: 'https://api.example.com',
        path: '/x',
        wire: { body: 'json', multipart: 'dot' },
    }),
);

expectError(
    stitch({
        method: 'POST',
        baseUrl: 'https://api.example.com',
        path: '/x',
        wire: { body: 'form', multipart: 'json' },
    }),
);

// No `wire.body` at all defaults to `json`, so this is dead config too.
expectError(
    stitch({
        method: 'POST',
        baseUrl: 'https://api.example.com',
        path: '/x',
        wire: { multipart: { nesting: 'bracket' } },
    }),
);

// ── The same guard binds every surface that authors a stitch (CONTRACT.md P16) ──
// `seam()` itself is the documented exception: it stays non-generic so excess-property checking
// can keep `input`/`output` off a seam fragment (see `extends-inference.test-d.ts` §8), so a dead
// `multipart` on the seam FRAGMENT is not caught. Every member surface below still catches it.
const api = seam({
    baseUrl: 'https://api.example.com',
    wire: { body: 'multipart' },
});

api.stitch({ path: '/ok', wire: { body: 'multipart', multipart: 'dot' } });
expectError(
    api.stitch({ path: '/x', wire: { body: 'form', multipart: 'dot' } }),
);

expectError(
    api.graphql({
        document: 'query { me { id } }',
        wire: { body: 'json', multipart: 'dot' },
    }),
);

expectError(
    graphql({
        baseUrl: 'https://api.example.com',
        document: 'query { me { id } }',
        wire: { multipart: 'dot' },
    }),
);

// A bare path string still reaches the non-inferring fallback unharmed.
expectType<Stitch<unknown>>(stitch('/plain'));

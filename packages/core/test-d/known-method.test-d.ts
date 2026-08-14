// `StitchConfig.method` is `KnownMethod | (string & {})` (issue #462 part 1, gap 4): the union arm
// gives an IDE the eight verbs to autocomplete — `QUERY` among them, which is the whole point, since
// nothing else would tell an author it exists — while `string & {}` keeps the field open. Widening a
// `string` this way is only safe if it is PURELY additive, so that is what this pins: everything that
// typechecked before still does.
import { stitch } from '../src';
import type { KnownMethod, Stitch } from '../src';

import { expectAssignable, expectType } from 'tsd';

// ── The known verbs, including QUERY ────────────────────────────────────────
expectType<Stitch<unknown>>(
    stitch({ url: 'https://api.example.com/orders', method: 'QUERY' }),
);
for (const m of [
    'GET',
    'HEAD',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'OPTIONS',
    'QUERY',
] as const)
    expectAssignable<KnownMethod>(m);

// ── Still open: a custom verb is not an error ───────────────────────────────
// The door stays open for WebDAV, a vendor verb, or a method the spec adds next — the union is an
// autocomplete list, never an allowlist.
expectType<Stitch<unknown>>(
    stitch({ url: 'https://api.example.com/x', method: 'PROPFIND' }),
);
// Including a method that is only known at runtime, which a closed union would have rejected.
declare const runtimeVerb: string;
expectType<Stitch<unknown>>(
    stitch({ url: 'https://api.example.com/x', method: runtimeVerb }),
);

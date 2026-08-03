// The `download` surface owns the request shape its result depends on: `buildRequest` always forces
// `method: 'GET'` and a blob response (ADR 0005 Decision 1 — a surface owns *shaping*), so either
// field authored alongside it is never read. That is dead config, so it must not typecheck.
//
// `wire.response` is the load-bearing one: it is what makes the buffered body a `Blob` at all, and
// the surface's `interpret` casts `res.body` to one before handing back `{ blob, filename }`. Any
// other response type would make that cast a lie. `method` is the weaker of the two — a
// POST-then-download is a real pattern — but honouring it alone would leave the surface's own name
// describing half the request. Either way the escape hatch is a plain `stitch()` with
// `wire: { response: 'blob' }`, exercised below.
//
// The two guarded fields sit at different DEPTHS, because the fields do: `method` is a flat
// `StitchConfig` slot, while the response decoding lives in the `wire` envelope. The nested arm has
// to reject `wire.response` without closing the rest of `wire`, so the envelope's other members are
// asserted still-authorable below. (`AdapterRequest` keeps the flat `responseType` — that is the
// transport contract one layer down, and no guard here touches it.)
import { seam, stitch } from '../src';
import type { Stitch, StitchConfig } from '../src';
import { download, downloadSurface } from '../src/download';
import type { DownloadResult } from '../src/download';
import { httpSurface } from '../src/surface';

import { expectError, expectType } from 'tsd';

const URL_ = 'https://files.example.com/report.pdf';

// ── Legal: a download stitch that says nothing about the request shape ──────
const report = download({ url: URL_ });
expectType<Stitch<DownloadResult>>(report);

// Every other config key is unaffected — only `method` / `wire.response` are claimed by the surface.
download({
    url: URL_,
    headers: { 'x-api-key': 'k' },
    timeout: 30_000,
    retry: 2,
});

// And the guard closes ONE member of `wire`, not the envelope: the query-array format is still the
// caller's, and reaches the surface's forced GET.
download({ url: 'https://files.example.com/{id}', wire: { array: 'repeat' } });

// ── Illegal: `method` on the `download()` preset ────────────────────────────
expectError(download({ url: URL_, method: 'POST' }));

// Not special to POST — even the verb the surface actually sends is rejected: it is the surface's
// to decide, and letting `method: 'GET'` through would imply the slot is read (it is not).
expectError(download({ url: URL_, method: 'GET' }));

// ── Illegal: `wire.response` on the `download()` preset ─────────────────────
expectError(download({ url: URL_, wire: { response: 'text' } }));

// Same reasoning as `method: 'GET'` — the value the surface itself forces is still not the
// caller's to author.
expectError(download({ url: URL_, wire: { response: 'blob' } }));

// A legal sibling in the same envelope does not launder the rejected member.
expectError(
    download({ url: URL_, wire: { response: 'text', array: 'repeat' } }),
);

// Both at once.
expectError(
    download({ url: URL_, method: 'POST', wire: { response: 'text' } }),
);

// `download.stitch` is the same function as the callable, so it inherits the guard.
download.stitch({ url: URL_ });
expectError(download.stitch({ url: URL_, method: 'POST' }));
expectError(download.stitch({ url: URL_, wire: { response: 'text' } }));

// ── Illegal: the same config reached through the generic `stitch({ kind })` ──
// Positive control first: the identical config MINUS the guarded field must typecheck, so each
// rejection below is attributable to the guard and not to the `kind` pairing itself.
stitch({ url: URL_, kind: downloadSurface });
stitch({ url: URL_, kind: downloadSurface, wire: { array: 'repeat' } });
expectError(stitch({ url: URL_, kind: downloadSurface, method: 'POST' }));
expectError(
    stitch({ url: URL_, kind: downloadSurface, wire: { response: 'text' } }),
);

// ── Legal: `method` / `wire.response` on any NON-download surface are untouched ──
// This is also the documented escape hatch for "POST, then take the bytes as a Blob".
const posted = stitch({
    url: URL_,
    method: 'POST',
    wire: { response: 'blob' },
});
expectType<Stitch<unknown>>(posted);

stitch({ path: '/things', method: 'PUT', wire: { response: 'arrayBuffer' } });

// ── The guard binds every surface that authors a download stitch (CONTRACT.md P16) ──
const api = seam({ baseUrl: 'https://files.example.com' });

// `download.bind(seam).stitch` — positive control, then the two rejections.
const bound = download.bind(api);
bound.stitch({ path: '/report.pdf' });
expectError(bound.stitch({ path: '/report.pdf', method: 'POST' }));
expectError(bound.stitch({ path: '/report.pdf', wire: { response: 'text' } }));

// `download.bind(options)` builds its own seam and must guard identically.
const owned = download.bind({ baseUrl: 'https://files.example.com' });
owned.stitch({ path: '/report.pdf' });
expectError(owned.stitch({ path: '/report.pdf', method: 'POST' }));

// A seam member reaching the surface through `kind` is guarded too.
api.stitch({ path: '/report.pdf', kind: downloadSurface });
expectError(
    api.stitch({ path: '/report.pdf', kind: downloadSurface, method: 'POST' }),
);
expectError(
    api.stitch({
        path: '/report.pdf',
        kind: downloadSurface,
        wire: { response: 'text' },
    }),
);

// A seam member on the default (http) surface still takes any request shape.
api.stitch({ path: '/upload', method: 'POST', wire: { response: 'text' } });

// ── The guard reads the COMPOSED config, so `extends` counts ────────────────
// `RequestShapeFixedByDownload` walks `Layers<C>` like every other config guard (#597), so the
// surface can arrive through a fragment and the rejection still applies.
const dlBase = { kind: downloadSurface, baseUrl: 'https://files.example.com' };

// Positive control: the fragment selects the surface, the literal says nothing about the shape.
stitch({ extends: [dlBase], path: '/report.pdf' });

expectError(stitch({ extends: [dlBase], method: 'POST' }));
expectError(stitch({ extends: [dlBase], wire: { response: 'text' } }));

// Nested one level down: the flattener recurses, so the surface is still found.
expectError(
    stitch({
        extends: [{ extends: [dlBase], headers: { 'x-a': '1' } }],
        method: 'POST',
    }),
);

// A fragment chain that never selects download leaves both fields live, as before.
stitch({ extends: [{ baseUrl: 'https://api.example.com' }], method: 'POST' });

// ── POLARITY: the surface probe is an INHIBITOR, so it can fail CLOSED ──────
// Identical to `WireBodyFixedByGraphql`'s documented tradeoff, for the identical reason. For
// `MultipartOnlyOnMultipartBody` and `GraphqlOnlyOnGraphqlSurface`, finding the enabler on some
// layer makes a config LEGAL, so `AnyLayer`'s existential scan can only fail open. Here, finding
// the download surface makes a config ILLEGAL, so the same scan fails CLOSED: inherit download,
// override `kind` back to something else, and the `method` is live but still rejected.
//
// Accepted rather than resolved — distinguishing it needs the last-wins resolution the existential
// scan exists to avoid, and the config it costs is perverse with an obvious workaround.
expectError(stitch({ extends: [dlBase], kind: httpSurface, method: 'POST' }));

// Positive control: the same override WITHOUT the guarded field typechecks, proving the rejection
// above is this guard's and not the `kind` override's.
stitch({ extends: [dlBase], kind: httpSurface, path: '/x' });

// ── Inherited from `Layers`, not introduced here — and fail-OPEN here ───────
// The same two limits `graphql-body-encoding.test-d.ts` pins: the flattener destructures a TUPLE,
// so an `extends` widened to `Frag[]` (what a `const` binding does without `as const`) reads as
// empty, as does the P7 single-fragment spelling (`extends: frag`, not a list).
//
// These fail OPEN rather than closed, which is the opposite of the polarity case just above and
// worth keeping straight: there the flattener SEES a layer whose surface no longer applies; here it
// sees no layers at all, so the trigger is never found and the guard simply does not fire. Both
// spellings therefore still typecheck; they are not `expectError`.
stitch({ extends: dlBase, method: 'POST' });

const widened = [dlBase]; // inferred `Frag[]`, not `[Frag]`
stitch({ extends: widened, method: 'POST' });

// A third fail-open, different cause again: a violation living ENTIRELY in a fragment is not
// reported, because the error is surfaced by intersecting onto the config LITERAL. Documented on
// `MultipartOnlyOnMultipartBody` as the first residual limit; pinned here so it stays deliberate.
stitch({ extends: [{ method: 'POST' }], kind: downloadSurface, url: URL_ });

// ── The non-inferring fallback must not launder a rejected config ───────────
// A bare path string still reaches the loose overload unharmed.
expectType<Stitch<unknown>>(stitch('/plain'));

// A genuinely loose `string | Partial<StitchConfig>` argument stays the escape hatch it was.
declare const loose: string | Partial<StitchConfig>;
expectType<Stitch<unknown>>(stitch(loose));

// ── The result type is unchanged by the guard ───────────────────────────────
// `InputOf<C>` inference still reads the path template off the literal, so `params` is required —
// proof the guard's intersection did not flatten the inferring overload into the loose one.
const byId = download({ url: 'https://files.example.com/{id}' });
expectError(byId());
byId({ params: { id: 'r-1' } });

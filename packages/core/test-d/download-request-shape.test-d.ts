// The `download` surface owns the request shape its result depends on: `buildRequest` always forces
// `method: 'GET'` and `responseType: 'blob'` (ADR 0005 Decision 1 — a surface owns *shaping*), so
// either field authored alongside it is never read. That is dead config, so it must not typecheck.
//
// `responseType` is the load-bearing one: it is what makes the buffered body a `Blob` at all, and
// the surface's `interpret` casts `res.body` to one before handing back `{ blob, filename }`. Any
// other response type would make that cast a lie. `method` is the weaker of the two — a
// POST-then-download is a real pattern — but honouring it alone would leave the surface's own name
// describing half the request. Either way the escape hatch is a plain `stitch()` with
// `responseType: 'blob'`, exercised below.
import { seam, stitch } from '../src';
import type { Stitch, StitchConfig } from '../src';
import { download, downloadSurface } from '../src/download';
import type { DownloadResult } from '../src/download';

import { expectError, expectType } from 'tsd';

const URL_ = 'https://files.example.com/report.pdf';

// ── Legal: a download stitch that says nothing about the request shape ──────
const report = download({ url: URL_ });
expectType<Stitch<DownloadResult>>(report);

// Every other config key is unaffected — only `method` / `responseType` are claimed by the surface.
download({
    url: URL_,
    headers: { 'x-api-key': 'k' },
    timeout: 30_000,
    retry: 2,
});

// ── Illegal: `method` on the `download()` preset ────────────────────────────
expectError(download({ url: URL_, method: 'POST' }));

// Not special to POST — even the verb the surface actually sends is rejected: it is the surface's
// to decide, and letting `method: 'GET'` through would imply the slot is read (it is not).
expectError(download({ url: URL_, method: 'GET' }));

// ── Illegal: `responseType` on the `download()` preset ──────────────────────
expectError(download({ url: URL_, responseType: 'text' }));

// Same reasoning as `method: 'GET'` — the value the surface itself forces is still not the
// caller's to author.
expectError(download({ url: URL_, responseType: 'blob' }));

// Both at once.
expectError(download({ url: URL_, method: 'POST', responseType: 'text' }));

// `download.stitch` is the same function as the callable, so it inherits the guard.
download.stitch({ url: URL_ });
expectError(download.stitch({ url: URL_, method: 'POST' }));
expectError(download.stitch({ url: URL_, responseType: 'text' }));

// ── Illegal: the same config reached through the generic `stitch({ kind })` ──
// Positive control first: the identical config MINUS the guarded field must typecheck, so each
// rejection below is attributable to the guard and not to the `kind` pairing itself.
stitch({ url: URL_, kind: downloadSurface });
expectError(stitch({ url: URL_, kind: downloadSurface, method: 'POST' }));
expectError(stitch({ url: URL_, kind: downloadSurface, responseType: 'text' }));

// ── Legal: `method` / `responseType` on any NON-download surface are untouched ──
// This is also the documented escape hatch for "POST, then take the bytes as a Blob".
const posted = stitch({
    url: URL_,
    method: 'POST',
    responseType: 'blob',
});
expectType<Stitch<unknown>>(posted);

stitch({ path: '/things', method: 'PUT', responseType: 'arrayBuffer' });

// ── The guard binds every surface that authors a download stitch (CONTRACT.md P16) ──
const api = seam({ baseUrl: 'https://files.example.com' });

// `download.bind(seam).stitch` — positive control, then the two rejections.
const bound = download.bind(api);
bound.stitch({ path: '/report.pdf' });
expectError(bound.stitch({ path: '/report.pdf', method: 'POST' }));
expectError(bound.stitch({ path: '/report.pdf', responseType: 'text' }));

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
        responseType: 'text',
    }),
);

// A seam member on the default (http) surface still takes any request shape.
api.stitch({ path: '/upload', method: 'POST', responseType: 'text' });

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

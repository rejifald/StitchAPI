// The endpoint slot has two spellings — the atomic `url`, and the `baseUrl` + `path` pair — and
// `buildRequest` (`engine.ts`) reads exactly one of them: when `url` is set it IS the whole
// endpoint, no base is joined, and neither sibling is ever read. Pairing them in ONE config literal
// is therefore dead config, and must not typecheck (CONTRACT.md P24 carve-out (b): a flat group
// kept flat MUST make its dead combinations unrepresentable).
//
// Why the type has to carry this at all — the runtime cannot. The engine's own diagnostic fires
// only when the JOINED result is not absolute, which catches the relative-`url` slip
// (`url: '/users'` beside a `baseUrl`) and nothing else. The absolute-`url` case —
// `url: 'https://a.test/x'` beside `baseUrl: 'https://b.test'` — resolves to a perfectly fetchable
// URL aimed at the wrong host, so it shipped silently. That asymmetry is the whole reason for the
// guard, and the silent case is the first assertion below.
//
// The guard is LITERAL-ONLY, and the composed cases in the second half are as load-bearing as the
// rejections. Across `extends` fragments the two spellings are a SUPPORTED last-writer-wins
// override (`stitch.ts`'s endpoint-slot reconcile): a seam supplying `baseUrl` while one member
// supplies an absolute `url` is the ordinary way to point a single endpoint off-origin. Reading
// composed layers here — the way the `graphql`/`multipart` guards do — would reject that, so the
// divergence from the sibling guards is deliberate and pinned here.
import { graphql, seam, stitch } from '../src';
import type { Stitch, StitchConfig } from '../src';
import { download } from '../src/download';
import type { DownloadResult } from '../src/download';

import { expectAssignable, expectError, expectType } from 'tsd';

const URL_ = 'https://files.example.com/report.csv';
const BASE = 'https://api.example.com';
const DOC = 'query Me { me { id } }';

// ── Legal: each spelling on its own ─────────────────────────────────────────
expectType<Stitch<unknown>>(stitch({ url: `${BASE}/users` }));
expectType<Stitch<unknown>>(stitch({ baseUrl: BASE, path: '/users' }));
expectType<Stitch<unknown>>(stitch({ baseUrl: BASE }));
expectType<Stitch<unknown>>(stitch({ path: '/users' }));
// The thunk form of either is just as legal on its own.
expectType<Stitch<unknown>>(stitch({ url: () => `${BASE}/users` }));
expectType<Stitch<unknown>>(stitch({ baseUrl: () => BASE, path: '/users' }));

// ── Illegal: both spellings in ONE literal ──────────────────────────────────
// THE silent case: both absolute, so the joined result is fetchable and the engine never complains.
// `baseUrl` is dropped and the request goes to `a.test`.
expectError(stitch({ url: 'https://a.test/x', baseUrl: 'https://b.test' }));
// The relative-`url` slip the engine already catches at runtime — now caught at authoring time.
expectError(stitch({ url: '/users', baseUrl: BASE }));
// `path` is inert beside `url` for the same reason: `url` carries its own path.
expectError(stitch({ url: `${BASE}/users`, path: '/users' }));
// All three at once — the guard reports the offending siblings, not the `url`.
expectError(stitch({ url: `${BASE}/users`, baseUrl: BASE, path: '/users' }));
// Thunks do not launder it: the pairing is dead whatever the values resolve to.
expectError(stitch({ url: () => `${BASE}/users`, baseUrl: BASE }));
expectError(stitch({ url: `${BASE}/users`, baseUrl: () => BASE }));

// ── The same guard on every surface that authors a stitch ───────────────────
// `graphql()` — its `/graphql` endpoint default keys off BOTH `url` and `path` being absent, so a
// dead pairing here is exactly as silent as on `stitch()`.
expectType<Stitch<unknown>>(graphql({ baseUrl: BASE, document: DOC }));
expectType<Stitch<unknown>>(graphql({ url: `${BASE}/graphql`, document: DOC }));
expectError(graphql({ url: `${BASE}/graphql`, baseUrl: BASE, document: DOC }));
expectError(
    graphql({ url: `${BASE}/graphql`, path: '/graphql', document: DOC }),
);

// `download()` — the preset whose single most common spelling IS a bare `url`.
expectType<Stitch<DownloadResult>>(download({ url: URL_ }));
expectError(download({ url: URL_, baseUrl: 'https://files.example.com' }));
expectError(download({ url: URL_, path: '/report.csv' }));
expectError(
    download.stitch({ url: URL_, baseUrl: 'https://files.example.com' }),
);

// Seam members, both overloads.
const api = seam({ baseUrl: BASE });
expectType<Stitch<unknown>>(api.stitch({ path: '/users' }));
expectError(api.stitch({ url: `${BASE}/users`, baseUrl: BASE }));
expectError(api.stitch({ url: `${BASE}/users`, path: '/users' }));
expectError(api.graphql({ url: `${BASE}/gql`, baseUrl: BASE, document: DOC }));
// The non-inferring fallback overload carries the guard as well, and every `expectError` above is
// what proves it: without the re-application a config the INFERRING overload rejects would simply
// fall through to the fallback and typecheck after all. There is no separate assertion to write —
// on a genuinely loose `string | Partial<StitchConfig>` argument the guards distribute over the
// union and every arm resolves to `unknown`, which is the escape hatch the fallback exists to be.

// ── Legal across fragments: the last-writer-wins override, NOT dead config ───
// A seam supplies the origin; one member overrides the whole endpoint with an absolute `url`. The
// reconcile in `stitch.ts` clears the inherited `baseUrl`, so nothing here is inert.
expectType<Stitch<unknown>>(api.stitch({ url: 'https://other.test/health' }));
// The same thing spelled with an explicit `extends` fragment, in both directions.
expectType<Stitch<unknown>>(
    stitch({ extends: [{ baseUrl: BASE }], url: 'https://other.test/health' }),
);
expectType<Stitch<unknown>>(
    stitch({
        extends: [{ url: 'https://other.test/x' }],
        baseUrl: BASE,
        path: '/users',
    }),
);
// Two fragments disagreeing is likewise legal — the later one wins the whole slot.
expectType<Stitch<unknown>>(
    stitch({
        extends: [
            { baseUrl: BASE, path: '/users' },
            { url: 'https://other.test/x' },
        ],
    }),
);

// ── Residual limit, pinned rather than fixed ────────────────────────────────
// A fragment typed as `Partial<StitchConfig>` rather than inferred from its literal has OPTIONAL
// properties, which satisfy no probe, so it reads as supplying nothing and the pairing inside it is
// not reported. This is the same fail-open the sibling guards document as their first residual
// limit; the literal-level case, which is the one people write, errors precisely (above).
const widened: Partial<StitchConfig> = {
    url: `${BASE}/users`,
    baseUrl: BASE,
};
expectAssignable<Partial<StitchConfig>>(widened);
expectType<Stitch<unknown>>(stitch({ extends: [widened] }));

// The same fail-open reached a second way, and worth naming because it looks like it should work:
// supplying an EXPLICIT result generic (`stitch<T>({ … })`) fills `TExplicit` only, so the second
// type parameter `C` falls back to its declared default `Partial<StitchConfig>` instead of being
// inferred from the literal — all-optional again, so no probe matches and the guard goes inert.
// This is a property of the guard IDIOM, not of this guard: `MultipartOnlyOnMultipartBody` and
// `GraphqlOnlyOnGraphqlSurface` were verified to have the identical hole
// (`stitch<{ id: string }>({ wire: { multipart: 'dot' } })` compiles too). Pinned here as a
// decision on record rather than fixed — closing it means making `C` inferable alongside an
// explicit `TExplicit`, which is a change to every overload in the family, not to this rule.
expectType<Stitch<{ id: string }>>(
    stitch<{ id: string }>({ url: '/u', baseUrl: BASE }),
);

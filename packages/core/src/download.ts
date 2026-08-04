// The `stitchapi/download` surface subpath (ADR 0005 Decision 8): a buffered binary GET that
// resolves to `{ blob, filename }`. The surface forces `GET` + `responseType: 'blob'`, buffers the
// whole body into a `Blob` (reporting byte progress as it arrives when a caller passes
// `onProgress` — Decision 9), and names it from `Content-Disposition` (`filename*` preferred, then
// `filename`), falling back to the response URL's last path segment. It NEVER writes to disk —
// returning a `Blob` keeps it browser-first; saving is the caller's choice. Distinct from `stream`:
// `download` buffers; `stream` hands back live chunks.
//
// Bundle-frugal (Decision 10): reached only through the `download` subpath; `import { stitch }`
// pulls in none of it.
import type { InputOf } from './infer';
import { seam as makeSeam } from './seam';
import { makeStitch } from './stitch';
import type { Surface, SurfaceOutcome } from './surface';
import {
    type NoRequestShapeOnDownload,
    type NoUnknownConfigKeys,
    type Seam,
    type SeamOptions,
    type Stitch,
    type StitchConfig,
    type StitchInput,
    isSeam,
} from './types';

/** What a `download` stitch resolves to: the buffered body and its parsed filename (when known). */
export interface DownloadResult {
    blob: Blob;
    filename?: string;
}

// The `filename*` extended-value pattern (RFC 8187): the charset and language are bounded to their
// RFC token classes — `mime-charsetc` and the language-tag alphabet — rather than a permissive
// `[^']*`. Both classes exclude `*`, `=`, and whitespace, so the run can't span arbitrary header
// text and stop only on a far-away quote. That matters because the regex is searched (unanchored)
// against an attacker-controlled header: a permissive run would scan to the end and fail at every
// `filename*=` start, which is the O(n²) polynomial-ReDoS trap. The bounded classes keep it linear.
const FILENAME_STAR =
    /filename\*\s*=\s*[A-Za-z0-9!#$%&+\-^_`{}~]*'[A-Za-z0-9-]*'([^;]+)/i;

// Parse a filename from a `Content-Disposition` header. RFC 5987/8187 `filename*` (percent-encoded,
// with a charset) is preferred over a plain `filename` (quoted or a bare token).
function filenameFromDisposition(cd: string | undefined): string | undefined {
    if (cd === undefined) return undefined;
    const ext = FILENAME_STAR.exec(cd)?.[1]?.trim();
    if (ext !== undefined && ext !== '') {
        try {
            return decodeURIComponent(ext);
        } catch {
            return ext; // malformed percent-encoding: hand back the raw value
        }
    }
    const m = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(cd);
    const plain = (m?.[1] ?? m?.[2])?.trim();
    return plain !== undefined && plain !== '' ? plain : undefined;
}

// Fall back to the last path segment of the (final, post-redirect) response URL.
function filenameFromUrl(url: string | undefined): string | undefined {
    if (url === undefined) return undefined;
    let pathname: string;
    try {
        pathname = new URL(url).pathname;
    } catch {
        return undefined; // not an absolute URL
    }
    const segments = pathname.split('/').filter((s) => s !== '');
    const last = segments[segments.length - 1];
    if (last === undefined) return undefined;
    try {
        return decodeURIComponent(last);
    } catch {
        return last;
    }
}

/**
 * The download surface. No `stream` hook → it is a BUFFERED surface (rides the normal engine path,
 * not concurrency-exempt). `buildRequest` forces a blob GET; `interpret` names the buffered Blob.
 *
 * The request shape is the surface's, not the caller's: `method` is FIXED at `GET` and the response
 * is always read as a blob, and `NoRequestShapeOnDownload` makes authoring either a compile error
 * so the override is never silent. The response decoding is the load-bearing one — `interpret`
 * casts `res.body` to a `Blob`, so any other response type would make that cast a lie. To download
 * the result of a POST, use a plain `stitch()` with `wire: { response: 'blob' }`; the only thing
 * given up is the `Content-Disposition` filename parsing.
 *
 * Note the two spellings below are two LAYERS, not a leftover rename. `buildRequest` returns an
 * `AdapterRequest`, whose wire-format fields are still flat (`responseType`) because that contract
 * keeps the XHR/fetch vocabulary at the boundary that meets it (CONTRACT.md P22). The guard reads
 * the AUTHORING config one layer up, where the same choice is spelled `wire.response`.
 *
 * The literal `id: 'download'` (rather than `Surface`'s widened `string`) is load-bearing: it is
 * what lets `RequestShapeFixedByDownload` recognise this surface in `stitch({ kind: downloadSurface })`.
 */
export const downloadSurface: Surface<StitchInput, DownloadResult> & {
    readonly id: 'download';
} = {
    id: 'download',
    buildRequest: (_cfg, _input, base) => ({
        ...base,
        method: 'GET',
        responseType: 'blob',
    }),
    interpret: (res): SurfaceOutcome<DownloadResult> => {
        const data: DownloadResult = { blob: res.body as Blob };
        const filename =
            filenameFromDisposition(res.headers['content-disposition']) ??
            filenameFromUrl(res.url);
        if (filename !== undefined) data.filename = filename;
        return { ok: true, data };
    },
};

/** download members bound to a seam. `stitch(config)` creates a download member of `seam`; `seam`
 *  is the underlying handle for lifecycle/principal (`.as`/`.flush`/`.close`). */
export interface DownloadSeamApi {
    readonly stitch: <
        const C extends Partial<StitchConfig> = Partial<StitchConfig>,
    >(
        config: C & NoUnknownConfigKeys<C> & NoRequestShapeOnDownload<C>,
    ) => Stitch<DownloadResult, InputOf<C>>;
    readonly seam: Seam;
}

// Standalone download stitch: the call argument is inferred from `config.input`, the result fixed
// to `{ blob, filename }`. The `as` retypes the loose `makeStitch` result (`Stitch<…, StitchInput>`)
// to the declared `InputOf<C>` call-arg type: now that `InputOf` reads `extends`-fragment schemas
// (#76) it is no longer a clean supertype of `StitchInput` under an unresolved `C`, so this loose
// body needs the same retype `stitch()`/`bind` get for free from their inferring overloads. Sound —
// the runtime stitch is byte-identical; only the static call-arg richness is restored (the type
// tests check every concrete config).
const downloadStitch = <
    const C extends Partial<StitchConfig> = Partial<StitchConfig>,
>(
    // The surface is download by construction here, so the guard applies unconditionally rather
    // than keying off `kind` the way `stitch`'s `RequestShapeFixedByDownload` must.
    config: C & NoUnknownConfigKeys<C> & NoRequestShapeOnDownload<C>,
): Stitch<DownloadResult, InputOf<C>> =>
    makeStitch<DownloadResult>({
        ...config,
        kind: downloadSurface,
    }) as unknown as Stitch<DownloadResult, InputOf<C>>;

// Bind download members to a seam through the seam's surface-agnostic `stitch({ kind })`.
function bindSeam(s: Seam): DownloadSeamApi {
    // Implemented loose and `as`-cast to the declared member type — the `Seam['graphql']` idiom in
    // seam.ts. A generic impl whose parameter is `C & NoRequestShapeOnDownload<C>` cannot be checked
    // against a member of that same shape: TypeScript instantiates the impl's `C` with the target's
    // whole intersection, so the two `InputOf<C>` return types stop matching. Sound — the runtime is
    // one `s.stitch` call, and the type tests pin every concrete config.
    const stitch = ((config: Partial<StitchConfig>) =>
        s.stitch<DownloadResult>({
            ...config,
            kind: downloadSurface,
        })) as DownloadSeamApi['stitch'];
    return { stitch, seam: s };
}

/**
 * The download surface's authoring helper — callable for the terse form (`download(config)`) plus:
 * - `download.stitch(config)` — a standalone download stitch (alias of the callable).
 * - `download.bind(existingSeam)` — bind download members to an existing seam.
 * - `download.bind(options)` — a new seam whose members default to download.
 * - `download.surface` — the download {@link Surface} identity.
 */
export const download = Object.assign(downloadStitch, {
    surface: downloadSurface,
    stitch: downloadStitch,
    bind: (arg: Seam | SeamOptions): DownloadSeamApi =>
        bindSeam(isSeam(arg) ? arg : makeSeam(arg)),
});

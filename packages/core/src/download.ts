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

// Parse a filename from a `Content-Disposition` header. RFC 5987 `filename*` (percent-encoded, with
// a charset) is preferred over a plain `filename` (quoted or a bare token).
function filenameFromDisposition(cd: string | undefined): string | undefined {
    if (cd === undefined) return undefined;
    const ext = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(cd)?.[1]?.trim();
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
 */
export const downloadSurface: Surface<StitchInput, DownloadResult> = {
    id: 'download',
    buildRequest: (_cfg, _input, base) => ({
        ...base,
        method: 'GET',
        responseType: 'blob',
    }),
    interpret: (res): SurfaceOutcome<DownloadResult> => {
        const value: DownloadResult = { blob: res.body as Blob };
        const filename =
            filenameFromDisposition(res.headers['content-disposition']) ??
            filenameFromUrl(res.url);
        if (filename !== undefined) value.filename = filename;
        return { ok: true, value };
    },
};

/** download members bound to a seam. `stitch(config)` creates a download member of `seam`; `seam`
 *  is the underlying handle for lifecycle/principal (`.as`/`.flush`/`.close`). */
export interface DownloadSeamApi {
    readonly stitch: <
        const C extends Partial<StitchConfig> = Partial<StitchConfig>,
    >(
        config: C,
    ) => Stitch<DownloadResult, InputOf<C>>;
    readonly seam: Seam;
}

// Standalone download stitch: the call argument is inferred from `config.input`, the result fixed
// to `{ blob, filename }`. The `as` retypes the loose `makeStitch` result (`Stitch<…, StitchInput>`)
// to the declared `InputOf<C>` call-arg type: now that `InputOf` reads `extends`-fragment schemas
// (#76) it is no longer a clean supertype of `StitchInput` under an unresolved `C`, so this loose
// body needs the same retype `stitch()`/`seam` get for free from their inferring overloads. Sound —
// the runtime stitch is byte-identical; only the static call-arg richness is restored (the type
// tests check every concrete config).
const downloadStitch = <
    const C extends Partial<StitchConfig> = Partial<StitchConfig>,
>(
    config: C,
): Stitch<DownloadResult, InputOf<C>> =>
    makeStitch<DownloadResult>({
        ...config,
        kind: downloadSurface,
    }) as unknown as Stitch<DownloadResult, InputOf<C>>;

// Bind download members to a seam through the seam's surface-agnostic `stitch({ kind })`.
function bindSeam(s: Seam): DownloadSeamApi {
    const stitch = <
        const C extends Partial<StitchConfig> = Partial<StitchConfig>,
    >(
        config: C,
    ): Stitch<DownloadResult, InputOf<C>> =>
        s.stitch<DownloadResult>({
            ...config,
            kind: downloadSurface,
        }) as unknown as Stitch<DownloadResult, InputOf<C>>;
    return { stitch, seam: s };
}

/**
 * The download surface's authoring helper — callable for the terse form (`download(config)`) plus:
 * - `download.stitch(config)` — a standalone download stitch (alias of the callable).
 * - `download.seam(existingSeam)` — bind download members to an existing seam.
 * - `download.seam(options)` — a new seam whose members default to download.
 * - `download.surface` — the download {@link Surface} identity.
 */
export const download = Object.assign(downloadStitch, {
    surface: downloadSurface,
    stitch: downloadStitch,
    seam: (arg: Seam | SeamOptions): DownloadSeamApi =>
        bindSeam(isSeam(arg) ? arg : makeSeam(arg)),
});

// @stitchapi/hono — Hono middleware + helpers for StitchAPI.
//
// Three pieces, each a thin bridge between StitchAPI's `seam` (ADR 0002) and Hono's Fetch-based
// request model:
//
//   • `stitch()`         — middleware that puts a (optionally principal-bound) seam on `c.var.stitch`
//                          so handlers call `c.get('stitch').stitch('/path')()`. The app owns the
//                          seam's lifecycle (`seam.close()`); the middleware only borrows it.
//   • `streamStitchSse()`— stream a streaming/SSE stitch's `.stream()` to the client as SSE, via
//                          Hono's `streamSSE`, aborting the upstream stream on client disconnect.
//   • `stitchError`      — one namespace for "a stitch failed, turn it into HTTP": `.is(err)` narrows,
//                          `.map(err)` returns a Hono `HTTPException` (502 by default, so an
//                          upstream's status is never leaked), `.handler()` is the `onError`.
//
// Edge/multi-runtime by construction: every import is from `hono` or `stitchapi`, never `node:*`,
// so the package runs unchanged on Node, Cloudflare Workers, Deno, Bun and Vercel Edge.
export {
    stitch,
    STITCH_VAR,
    type HonoRequestSeam,
    type StitchEnv,
    type HonoStitchMiddlewareOptions,
} from './middleware';

export {
    streamStitchSse,
    type StitchEventSource,
    type StreamStitchSseOptions,
} from './sse';

// The error family is ONE namespace, not three verb-prefixed names — `stitchError.is` /
// `.map` / `.handler`, the same spelling every other `@stitchapi` host adapter exports (ADR
// 0012; the export-surface analogue of the `secrets` and token-grammar folds in core). The
// implementations stay plain module functions in `./error` so the namespace is a thin facade:
// nothing here welds all three onto a consumer that reaches one.
export {
    stitchError,
    type StitchErrorLike,
    type StitchErrorOptions,
} from './error';

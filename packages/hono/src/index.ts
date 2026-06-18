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
//   • `stitchError()` /  — map a thrown `StitchError` to a Hono `HTTPException` (502 by default, so
//     `stitchOnError()`    an upstream's status is never leaked), as a one-off or an `onError`.
//
// Edge/multi-runtime by construction: every import is from `hono` or `stitchapi`, never `node:*`,
// so the package runs unchanged on Node, Cloudflare Workers, Deno, Bun and Vercel Edge.
export {
    stitch,
    STITCH_VAR,
    type RequestSeam,
    type StitchEnv,
    type StitchMiddlewareOptions,
} from './middleware';

export {
    streamStitchSse,
    type StitchEventSource,
    type StreamStitchSseOptions,
} from './sse';

export {
    stitchError,
    stitchOnError,
    isStitchError,
    type StitchErrorLike,
    type StitchErrorOptions,
} from './error';

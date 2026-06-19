// @stitchapi/elysia — an Elysia plugin + helpers for StitchAPI.
//
// Three pieces, each a thin bridge between StitchAPI's `seam` (ADR 0002) and Elysia's Web-standard
// request model:
//
//   • `stitch()`         — a plugin (`.use(stitch({ seam, principal? }))`) that `.derive`s a
//                          request-scoped seam onto the context (`ctx.stitch`), so handlers call
//                          `({ stitch }) => stitch.stitch('/path')()`. The app owns the seam's
//                          lifecycle (`seam.close()`); the plugin only borrows it. It also registers
//                          an `.onError` (see below) unless you opt out.
//   • `streamStitchSse()`— stream a streaming/SSE stitch's `.stream()` to the client as SSE, as a
//                          Web-standard `Response` you return straight from a handler, aborting the
//                          upstream stream on client disconnect.
//   • `stitchOnError()` / — map a thrown `StitchError` to an HTTP `Response` (502 by default, so an
//     `stitchErrorResponse()` upstream's status is never leaked), as an `.onError` or a one-off.
//
// Bun-first but runtime-agnostic by construction: every import is from `elysia` or `stitchapi`,
// never `node:*`, so the package runs unchanged on Bun, Node, Deno and the edge.
export {
    stitch,
    type RequestSeam,
    type StitchPlugin,
    type StitchPluginOptions,
} from './plugin';

export {
    streamStitchSse,
    type StitchEventSource,
    type StreamStitchSseOptions,
} from './sse';

export {
    stitchErrorResponse,
    stitchOnError,
    isStitchError,
    type StitchErrorLike,
    type StitchErrorOptions,
} from './error';

export type { PrincipalContext, StitchContext, StitchEnvLike } from './context';

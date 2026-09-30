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
//   • `stitchError`      — one namespace for "a stitch failed, turn it into HTTP": `.is(err)` narrows,
//                          `.map(err)` returns an HTTP `Response` (502 by default, so an upstream's
//                          status is never leaked), `.handler()` is the `.onError`.
//
// Bun-first but runtime-agnostic by construction: every import is from `elysia` or `stitchapi`,
// never `node:*`, so the package runs unchanged on Bun, Node, Deno and the edge.
export {
    stitch,
    type ElysiaRequestSeam,
    type ElysiaStitchPluginOptions,
    type StitchPlugin,
} from './plugin';

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

export type {
    ErrorContextLike,
    PrincipalContext,
    StitchContext,
} from './context';

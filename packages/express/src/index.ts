// @stitchapi/express — Express middleware + helpers for StitchAPI.
//
// Express has no plugin/lifecycle/logger structure to bridge (cf. @stitchapi/fastify), so this is the
// shallow binding: three thin pieces between StitchAPI's `seam` (ADR 0002) and Express's req/res:
//
//   • `stitch()`          — middleware that puts a (optionally principal-bound) seam on `req.stitch`
//                           (and `res.locals.stitch`) so handlers call `req.stitch.stitch('/path')()`.
//                           The app owns the seam's lifecycle (`seam.close()`); the middleware only
//                           borrows it. `currentStitch(req)` reads it back as a typed value.
//   • `streamStitchSse()` — stream a streaming/SSE stitch's `.stream()` to `res` as SSE, aborting the
//                           upstream iterator on client disconnect.
//   • `stitchError`       — one namespace for "a stitch failed, turn it into HTTP": `.is(err)`
//                           narrows, `.handler()` is an Express error middleware mapping a thrown
//                           `StitchError` to JSON (502 by default, so an upstream's status is never
//                           leaked) and `next(err)`-ing everything else.
//
// Importing this module augments Express's `Request` with a typed `req.stitch`.
export {
    stitch,
    currentStitch,
    type ExpressRequestSeam,
    type ExpressStitchMiddlewareOptions,
} from './middleware';

export {
    streamStitchSse,
    type StitchEventSource,
    type StreamStitchSseOptions,
} from './sse';

// The error family is ONE namespace, not two verb-prefixed names — `stitchError.is` /
// `.handler`, the same spelling every other `@stitchapi` host adapter exports (ADR 0012; the
// export-surface analogue of the `secrets` and token-grammar folds in core). Express has no
// `.map`: its middleware writes onto the mutable `res` rather than returning a mapped value,
// so there is no artifact to hand back — see the namespace's own JSDoc. The implementations
// stay plain module functions in `./error` so the namespace is a thin facade.
export {
    stitchError,
    type StitchErrorLike,
    type StitchErrorOptions,
} from './error';

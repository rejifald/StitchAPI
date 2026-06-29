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
//   • `stitchErrorHandler()` — an Express error middleware mapping a thrown `StitchError` to JSON
//                           (502 by default, so an upstream's status is never leaked), `next(err)`-ing
//                           everything else.
//
// Importing this module augments Express's `Request` with a typed `req.stitch`.
export {
    stitch,
    currentStitch,
    type RequestSeam,
    type StitchMiddlewareOptions,
} from './middleware';

export {
    streamStitchSse,
    type StitchEventSource,
    type StreamStitchSseOptions,
} from './sse';

export {
    stitchErrorHandler,
    isStitchError,
    type StitchErrorLike,
    type StitchErrorHandlerOptions,
} from './error';

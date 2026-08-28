export {
    stitchPlugin,
    currentStitch,
    type FastifyStitchPluginOptions,
    type FastifyStitchPluginSeamOptions,
    type FastifyStitchPluginConfigOptions,
    type FastifyRequestSeam,
} from './plugin';
export { streamStitchSse, type StreamStitchSseOptions } from './sse';
// The canonical event-stream intake, re-exported from the core barrel (one shared shape
// across every host adapter — no local unions).
export type { StitchEventSource } from 'stitchapi';
// The error family is ONE namespace, not two verb-prefixed names — `stitchError.is` /
// `.handler`, the same spelling every other `@stitchapi` host adapter exports (ADR 0012; the
// export-surface analogue of the `secrets` and token-grammar folds in core). Fastify has no
// `.map`: the handler writes onto the mutable `reply` rather than returning a mapped value, so
// there is no artifact to hand back — see the namespace's own JSDoc. The plugin's `errorHandler`
// option keeps Fastify's own spelling (P18's mirror clause). The implementations stay plain
// module functions in `./error-handler` so the namespace is a thin facade.
export {
    stitchError,
    type StitchErrorLike,
    type StitchErrorOptions,
} from './error-handler';
export {
    fastifyLoggerSink,
    type FastifyLoggerLike,
    type FastifyLoggerSinkOptions,
} from './logger';

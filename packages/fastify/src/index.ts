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
export {
    stitchErrorHandler,
    isStitchError,
    type StitchErrorLike,
    type StitchErrorOptions,
} from './error-handler';
export {
    fastifyLoggerSink,
    type FastifyLoggerLike,
    type FastifyLoggerSinkOptions,
} from './logger';

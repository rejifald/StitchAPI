export {
    stitchPlugin,
    currentStitch,
    type StitchPluginOptions,
    type StitchPluginSeamOptions,
    type StitchPluginConfigOptions,
    type FastifyRequestSeam,
    // Deprecated alias (kept through 1.0.0-rc, removed at GA) — see ADR 0012.
    type StitchHost,
} from './plugin';
export { sendStitchSse, type SendStitchSseOptions } from './sse';
export {
    stitchErrorHandler,
    isStitchError,
    type StitchErrorLike,
    type StitchErrorHandlerOptions,
} from './error-handler';
export {
    fastifyLoggerSink,
    type FastifyLoggerLike,
    type FastifyLoggerSinkOptions,
} from './logger';

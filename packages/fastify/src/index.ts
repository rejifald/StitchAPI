export {
    stitchPlugin,
    currentStitch,
    type StitchPluginOptions,
    type StitchPluginSeamOptions,
    type StitchPluginConfigOptions,
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

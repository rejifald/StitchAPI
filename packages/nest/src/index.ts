export {
    StitchModule,
    SeamRegistry,
    type StitchModuleOptions,
    type StitchModuleAsyncOptions,
    type StitchFeatureOptions,
    type StitchScopedFeatureOptions,
} from './module';
export {
    defineStitch,
    InjectStitch,
    type StitchDef,
    type AnyStitchDef,
    type StitchHost,
    type Injected,
} from './define-stitch';
export {
    nestLoggerSink,
    fromConfig,
    borrowStore,
    type ConfigServiceLike,
    type NestLoggerLike,
    type NestLoggerSinkOptions,
    // Deprecated aliases (kept through 1.0.0-rc, removed at GA) — see ADR 0012.
    loggerSink,
    type LoggerLike,
} from './bridges';
export { STITCH_SEAM, STITCH_STORE, STITCH_TRACE } from './tokens';
export {
    StitchExceptionFilter,
    toHttpException,
    isStitchError,
    type StitchError,
    type ToHttpExceptionOptions,
} from './exception-filter';
export { stitchSse, type MessageEventLike, type StitchSseOptions } from './sse';

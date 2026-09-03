export {
    StitchModule,
    SeamRegistry,
    type StitchModuleOptions,
    type StitchModuleAsyncOptions,
    type StitchFeatureOptions,
    type StitchScopedFeatureOptions,
    type NestFeatureSeamOptions,
} from './module';
export {
    defineStitch,
    InjectStitch,
    type StitchDef,
    type AnyStitchDef,
    type NestRequestSeam,
    type Injected,
} from './define-stitch';
export {
    nestLoggerSink,
    fromNestConfig,
    nestBorrowStore,
    type NestConfigServiceLike,
    type NestLoggerLike,
    type NestLoggerSinkOptions,
} from './bridges';
export { STITCH_SEAM, STITCH_STORE, STITCH_TRACE } from './tokens';
// The error family is ONE namespace, not two verb-prefixed names — `stitchError.is` / `.map`,
// the same spelling every other `@stitchapi` host adapter exports (ADR 0012; the export-surface
// analogue of the `secrets` and token-grammar folds in core). The handler stays the top-level
// `StitchExceptionFilter` **class**: Nest registers a filter INSTANCE through DI
// (`useGlobalFilters`, `{ provide: APP_FILTER, useClass }`), which is the idiom ADR 0012 rule 1
// blesses — so there is no `.handler` member here. The implementations stay plain module
// functions in `./exception-filter` so the namespace is a thin facade.
export {
    StitchExceptionFilter,
    stitchError,
    type StitchErrorLike,
    type StitchErrorOptions,
} from './exception-filter';
export {
    streamStitchSse,
    type MessageEventLike,
    type StitchEventSource,
    type StreamStitchSseOptions,
} from './sse';

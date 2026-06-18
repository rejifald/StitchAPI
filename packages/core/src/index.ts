export { stitch, drift } from './stitch';
export { graphql } from './graphql';
export { seam } from './seam';
export { httpSurface, graphqlSurface } from './surface';
export type { Surface, SurfaceOutcome } from './surface';
export {
    bearer,
    apiKey,
    basic,
    cookieSession,
    oauth2,
    env,
    optionalEnv,
    secretsFile,
    secretFrom,
} from './auth';
export type { SecretSource, AuthFailureInfo, RefreshResult } from './auth';
export { fetchAdapter } from './http-adapter';
export type { FetchAdapterOptions } from './http-adapter';
export { axiosAdapter } from './axios-adapter';
export type {
    AxiosLike,
    AxiosLikeConfig,
    AxiosLikeResponse,
} from './axios-adapter';
export { xhrAdapter } from './xhr-adapter';
export type { XhrLike, XhrLikeCtor, XhrProgress } from './xhr-adapter';
export {
    createTrace,
    consoleSink,
    fileSink,
    multiplex,
    loggerSink,
} from './trace';
export type { LoggerLike, LoggerSinkOptions, LogLevel } from './trace';
export { otlpTrace, otlpHttpExporter, toOtlpJson } from './otlp';
export type {
    SpanExporter,
    OtelSpan,
    OtelSpanEvent,
    SpanAttributes,
    OtlpOptions,
} from './otlp';
export { toValidator } from './validator';
export type { Issue, ValidationResult, Validator } from './validator';
export type { InferInput, InferOutput, SchemaLike } from './infer';
export { memoryStore } from './store';
// The default Clock (ADR 0010) — wall-clock + global timers. Inject a custom `Clock` (or a
// `manualClock()` from `stitchapi/testing`) via a stitch/seam `clock` to control time.
export { systemClock } from './util';
// The delegate-backoff error (issue #145): thrown on the awaited path and surfaced as an `error`
// event when `rateLimit.delegate` is on, so a host's outer gate owns the rate-limit backoff.
export { RateLimitError } from './resilience';
export * from './types';

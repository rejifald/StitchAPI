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
// Trace-redaction escape hatch: widen the secret-key denylist so a host's custom credential
// param name is scrubbed in every trace sink (start.url, OTLP url.full, input.query). `apiKey({ in:
// 'query', name })` registers its name here automatically; this is the manual hook for a credential
// the built-in set/stems don't catch. `isSecretKey` is the matching predicate (alias:
// `isSecretQueryKey`), exposed so a host can audit which of its query params / body keys the
// scrubbers already cover. `redactSecretsDeep` walks a plain value and replaces secret-named keys.
export {
    registerSecretQueryKey,
    isSecretKey,
    isSecretQueryKey,
    redactSecretsDeep,
} from './util';
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

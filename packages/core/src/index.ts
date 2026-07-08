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
export type {
    Secret,
    OptionalSecret,
    SecretSource,
    ApiKeyOptions,
    BasicOptions,
    OAuth2Options,
    OAuth2RefreshOptions,
    CookieSessionOptions,
    CookieSessionRefreshOptions,
    AuthFailureResult,
    RefreshResult,
} from './auth';
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
export type {
    LoggerLike,
    LoggerSinkOptions,
    LogLevel,
    TraceOptions,
} from './trace';
export { otlpSink, otlpHttpExporter, toOtlpJson } from './otlp';
export type {
    SpanExporter,
    OtelSpan,
    OtelSpanEvent,
    SpanAttributes,
    OtlpOptions,
    OtlpExporterOptions,
} from './otlp';
// Trace-redaction escape hatch: widen the secret-key denylist so a host's custom credential
// param name is scrubbed in every trace sink (start.url, OTLP url.full, input.query). `apiKey({ in:
// 'query', name })` registers its name here automatically; this is the manual hook for a credential
// the built-in set/stems don't catch. `isSecretKey` is the matching predicate, exposed so a host
// can audit which of its query params / body keys the scrubbers already cover. `redactSecretsDeep`
// walks a plain value and replaces secret-named keys.
export { registerSecretKey, isSecretKey, redactSecretsDeep } from './util';
export type { Issue, ValidationResult, Validator } from './validator';
// Standalone validation, uniform with what `input`/`output` consume: `validate(schema, value)`
// checks a value now; `compile(schema)` coerces once and returns a reusable checker. Both take any
// `SchemaLike` and return a `ValidationResult` — no reaching into a schema's `['~standard']`.
export { validate, compile } from './validate';
// The canonical schema contract a stitch accepts (a Standard Schema, https://standardschema.dev).
// Named export so schema adapters like `@stitchapi/json-schema` build against one documented type.
export type { StitchSchema } from './standard-schema';
export type { InferInput, InferOutput, SchemaLike } from './infer';
export { memoryStore } from './store';
// The default Clock (ADR 0010) — wall-clock + global timers. Inject a custom `Clock` (or a
// `manualClock()` from `stitchapi/testing`) via a stitch/seam `clock` to control time.
export { systemClock } from './util';
// `compact({ ...obj, key: value })` — a shallow copy with `undefined`-valued keys removed, typed so
// undefined-admitting keys come back optional. Pairs with `exactOptionalPropertyTypes`: it omits an
// absent optional without the `...(key !== undefined ? { key } : {})` spread dance.
export { compact } from './compact';
export type { Compact } from './compact';
// The delegate-backoff error (issue #145): thrown on the awaited path and surfaced as an `error`
// event when `throttle.delegate` is on, so a host's outer gate owns the rate-limit backoff.
export { RateLimitError } from './resilience';
export * from './types';

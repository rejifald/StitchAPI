export { stitch, drift } from './stitch';
export { graphql } from './graphql';
export { seam } from './seam';
// One decision, three scopes — but only ONE of them is a contract with anybody outside this
// package. `verdictOf` is what a surface author composes in front of their own body rules
// (ADR 0022 Decision 4), so it is public. `classifyStatus` (the status alone) answers the engine's
// transport-health question at two internal call sites, and `httpInterpret` is the http surface's
// own hook — reachable as `httpSurface.interpret` by anyone who genuinely wants it. Exporting
// either would put three names on the barrel for one decision and invite a surface author to
// compose the wrong one; the flag-failed-200 circuit bug was exactly that mistake made internally.
export { httpSurface, graphqlSurface, verdictOf } from './surface';
export type { Surface, SurfaceOutcome } from './surface';
// The auth surface lives on `stitchapi/auth` (ADR 0021) — the strategy factories
// (`bearer`/`apiKey`/`basic`/`oauth2`/`cookieSession`), the secret resolvers
// (`env`/`optionalEnv`/`secretsFile`/`secretFrom`) and their option types. Deliberately NOT
// re-exported here: a root re-export would put the factories back in this barrel and hand every
// consumer oauth2's token cache and cookieSession's login state machine again, which is the whole
// point of the split. `AuthStrategy`/`AuthContext`/`SecurityScheme` stay on the root — they type
// `StitchConfig.auth` — via `export * from './types'`, and `/auth` re-exports them for authoring.
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
// The OTLP trace pipeline, one namespace over one export path. `otlp.sink(opts?)` is the
// TraceSink you hand to `trace` — it maps a stitch's events to one OTel CLIENT span;
// `otlp.exporter(opts?)` is the default destination it builds, POSTing OTLP/JSON to
// `${endpoint}/v1/traces`; `otlp.json(spans)` is the serializer underneath both, public as the
// seam for a transport core does not ship (gRPC, a queue, a file) so a hand-rolled exporter uses
// the same wire mapping rather than re-deriving it.
//
// Same shape as `secrets` and the token grammars below, for the same reason: one name per
// dimension with the role at the call site, rather than the three names
// (`otlpSink`/`otlpHttpExporter`/`toOtlpJson`) it replaced — which repeated the subject noun in
// all three and varied only the role word, while hiding that they are three LAYERS of one
// pipeline (json feeds exporter feeds sink) rather than three sibling helpers.
export { otlp } from './otlp';
export type {
    SpanExporter,
    OtelSpan,
    OtelSpanEvent,
    SpanAttributes,
    OtlpOptions,
} from './otlp';
// The trace-redaction escape hatch, one namespace over one denylist. `secrets.register(name)`
// widens it so a host's custom credential param is scrubbed in every trace sink (start.url, OTLP
// url.full, input.query); `secrets.has(name)` is the matching predicate, so a host can audit which
// of its query params / body keys the scrubbers already cover; `secrets.redact(value)` walks a
// plain value and replaces secret-named keys, which is what `.inspect({ redact })` hands the
// caller. `apiKey({ in: 'query', name })` registers its name automatically; this is the manual
// hook for a credential the built-in set/stems don't catch.
//
// Same shape as the token grammars below, for the same reason: one name per dimension with the
// verb at the call site, rather than the three verb-prefixed functions
// (`registerSecretKey`/`isSecretKey`/`redactSecretsDeep`) it replaced — three names on the barrel
// for one decision. The caveat the old predicate's name invited (it answers about query params
// and body keys, NOT headers, which `redactHeaders` widens at the sink boundary) had to be
// repeated at each use; it is stated once on the namespace's own JSDoc instead.
export { secrets } from './util';
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
// The three house token grammars, one namespace each, every one a `parse`/`format` pair. The
// shape is `bytes`'s (`bytes.parse` / `bytes.format`): one name per dimension, the direction
// named at the call site, rather than a barrel of six verb-prefixed functions. `format` is the
// EXACT inverse of `parse` — `parse(format(v))` returns `v` unchanged, never a rounded
// approximation the way `ms(90_000)` → `'2m'` does — so a value may be encoded and read back.
//
// `duration` (CONTRACT.md P17): `5_000`, `'5s'`, `'1m'` → ms, and `90_000` → `'1.5m'`.
// Exported so a peer package that takes a consumer-authored duration parses it the same way
// core does, instead of mirroring the grammar and drifting from it.
export { duration } from './util';
// `size` (CONTRACT.md P25), the size analogue: `4096`, `'64kb'`, `'1mb'` → bytes (powers of
// 1024), and `1536` → `'1.5kb'`. Same reason it is public — a peer package with a byte cap
// parses it the way core does. NOT for the `Chars` family, which counts UTF-16 code units
// rather than bytes; the old `parseBytes` name carried that warning and this one does not, so
// it is stated on the namespace's own JSDoc instead.
export { size } from './util';
// `rate` (ADR 0023): `'2/s'`, `'10/m'` → `{ count, per }` (window length in ms), and back.
// Public for the same reason as the two above — a peer package with an authored rate (a
// distributed limiter) parses it the way core does. Its `parse` THROWS on a bad token where
// those two fall back, because `undefined` for a rate means "unlimited": see its JSDoc.
export { rate } from './util';
export type { Rate } from './util';
// `compact({ ...obj, key: value })` — a shallow copy with `undefined`-valued keys removed, typed so
// undefined-admitting keys come back optional. Pairs with `exactOptionalPropertyTypes`: it omits an
// absent optional without the `...(key !== undefined ? { key } : {})` spread dance.
export { compact } from './compact';
export type { Compact } from './compact';
// The delegate-backoff error (issue #145): thrown on the awaited path and surfaced as an `error`
// event when `throttle.delegate` is on, so a host's outer gate owns the rate-limit backoff.
export { RateLimitError } from './resilience';
export * from './types';

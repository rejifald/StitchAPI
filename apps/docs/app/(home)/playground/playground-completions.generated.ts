// @generated — do not edit by hand.
// Regenerate: pnpm --filter @stitchapi/docs run gen:completions
import type { Completion } from '@codemirror/autocomplete';

/** Config-key completions inside primitive({…}) call arguments. */
export const PLAYGROUND_COMPLETIONS: Record<string, Completion[]> = {
    stitch: [
        {
            label: 'name',
            type: 'property',
            detail: 'string',
            info: "Label used in events and traces; defaults to `path` or `'stitch'`.",
        },
        {
            label: 'kind',
            type: 'property',
            detail: "'http' | 'graphql'",
            info: "Request kind. `'http'` (default) or `'graphql'` for a POST `{ query, variables }`.",
        },
        {
            label: 'method',
            type: 'property',
            detail: 'string',
            info: 'HTTP method; defaults to `GET`.',
        },
        {
            label: 'bodyType',
            type: 'property',
            detail: "'json' | 'form' | 'multipart'",
            info: "Request body encoding. Default `'json'`.",
        },
        {
            label: 'responseType',
            type: 'property',
            detail: 'ResponseType',
            info: 'How to read the response body. Default: auto by content-type.',
        },
        {
            label: 'url',
            type: 'property',
            detail: 'string | (() => string)',
            info: 'Full request endpoint as one string — the atomic spelling, when a stitch is exactly one endpoint with no base to share. Templated (`{param}`, incl. the host) and `?query`-aware like `path`; may be a thunk for lazy/env resolution. Mutually exclusive with `baseUrl`/`path`: when both are set `url` wins, and across composed fragments the last fragment to write either spelling wins the whole slot.',
        },
        {
            label: 'baseUrl',
            type: 'property',
            detail: 'string | (() => string)',
            info: 'Origin for the request, as a string or a thunk resolved at call time. Ignored when `url` is set.',
        },
        {
            label: 'path',
            type: 'property',
            detail: 'string',
            info: 'Path appended to `baseUrl`; may include `{param}` slots and a `?query` string. Ignored when `url` is set.',
        },
        {
            label: 'headers',
            type: 'property',
            detail: 'Record<string, string>',
            info: 'Static default headers merged into every request.',
        },
        {
            label: 'query',
            type: 'property',
            detail: 'string',
            info: "GraphQL query string (`kind: 'graphql'`).",
        },
        {
            label: 'input',
            type: 'property',
            detail: 'InputSchemas',
            info: 'Schemas validating params, query, body, and headers before the request.',
        },
        {
            label: 'output',
            type: 'property',
            detail: 'Validator | DriftSpec',
            info: 'Response schema, or a  for leveled drift detection.',
        },
        {
            label: 'unwrap',
            type: 'property',
            detail: 'string',
            info: 'Dot-path selecting the part of the response to return.',
        },
        {
            label: 'transform',
            type: 'property',
            detail: '(body: unknown) => unknown',
            info: 'Reshape the raw body before unwrap and validation (e.g. scrape HTML to structured data).',
        },
        {
            label: 'paginate',
            type: 'property',
            detail: "{ /** * Given the previous page's raw body and how many pages were fetched, return the * input (merged over the original) for the next page, or `undefined` to stop. */ next: ( prevBody: unknown, pagesFetched: number, ) => StitchInput | undefined; /** Pull the array from each unwrapped page. Default: the value if it is an array. */ items?: (value: unknown) => unknown[]; /** Safety cap on pages. Default 50. */ max?: number; }",
            info: 'Auto-loop pages, aggregating items, with auth/retry/throttle applied to every page.',
        },
        {
            label: 'auth',
            type: 'property',
            detail: 'AuthStrategy',
            info: 'Auth strategy — the stitch holds the credential; the caller never sees it.',
        },
        {
            label: 'retry',
            type: 'property',
            detail: 'RetryOptions',
            info: 'Retry-and-backoff policy.',
        },
        {
            label: 'throttle',
            type: 'property',
            detail: 'ThrottleOptions',
            info: 'Rate and concurrency limits.',
        },
        {
            label: 'timeout',
            type: 'property',
            detail: 'TimeoutOptions',
            info: 'Total and per-attempt timeouts.',
        },
        {
            label: 'circuit',
            type: 'property',
            detail: 'CircuitOptions',
            info: 'Circuit breaker that fast-fails a repeatedly failing dependency.',
        },
        {
            label: 'idempotency',
            type: 'property',
            detail: 'IdempotencyOptions',
            info: "Inject a stable Idempotency-Key header on writes so safe retries don't duplicate.",
        },
        {
            label: 'arrayFormat',
            type: 'property',
            detail: "'indices' | 'brackets' | 'repeat'",
            info: "How arrays are serialised in the query string. - `'indices'` (default) — `ids%5B0%5D=1&ids%5B1%5D=2` - `'brackets'`          — `ids%5B%5D=1&ids%5B%5D=2` - `'repeat'`            — `ids=1&ids=2`",
        },
        {
            label: 'hooks',
            type: 'property',
            detail: 'Hooks',
            info: 'Request/response/error/retry lifecycle hooks.',
        },
        {
            label: 'extends',
            type: 'property',
            detail: '(Partial<StitchConfig> | Stitch | string)[]',
            info: 'Fragments to deep-merge under this config — strings, partials, or other stitches.',
        },
        {
            label: 'adapter',
            type: 'property',
            detail: 'Adapter',
            info: 'Test seam / custom transport.',
        },
        {
            label: 'store',
            type: 'property',
            detail: 'StitchStore',
            info: 'Pluggable state store for throttle + session. Default in-memory.',
        },
        {
            label: 'trace',
            type: 'property',
            detail: "TraceSink | 'console' | false",
            info: "Observability sink — **off by default**, because a stitch's only effect on the world is its call. Opt in with `'console'` (the colored stderr stream), a sink from `fileSink(path)` / `createTrace(...)` for JSONL on disk, or any custom . `false` forces it off even when the `STITCH_TRACE_*` env vars are set. Unset falls back to the env-driven sink, which is itself silent unless `STITCH_TRACE_CONSOLE` / `STITCH_TRACE_FILE` / `STITCH_EXPORT` opt in.",
        },
    ],
};

/** Member completions on the value returned by a primitive call. */
export const PLAYGROUND_INSTANCE_COMPLETIONS: Record<string, Completion[]> = {
    stitch: [
        {
            label: 'stream',
            type: 'method',
            detail: '(input?: StitchInput) => AsyncGenerator<StitchEvent<T>, void>',
        },
        {
            label: 'with',
            type: 'method',
            detail: '(partial: StitchInput) => Stitch<T>',
        },
        {
            label: '__config',
            type: 'property',
            detail: 'StitchConfig',
        },
        {
            label: '__stitch',
            type: 'property',
            detail: 'true',
        },
    ],
};

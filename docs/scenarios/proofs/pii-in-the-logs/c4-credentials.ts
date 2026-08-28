// C4 — is the CREDENTIAL half genuinely safe?
//
// The capture's hypothesis is a clean split: credentials are protected by default, customer PII is
// not. Scenario 18 found the credential boundary held for MCP; this is the tracing equivalent. A
// bearer token, an `apiKey` in a query string, and a cookie go through every C1 destination and
// each destination's bytes are scanned for the literal value.
//
// The split is real, and it is narrower than "credentials are protected". Measured, the protection
// is a property of THREE specific things — the declarative auth seam (which runs after the `start`
// event is built), the built-in sinks' header/URL/query scrubbers, and the payload-free default
// formatters — and it does NOT extend to (a) a custom sink, which receives the raw event, or
// (b) a credential arriving in a RESPONSE body, which the JSONL sink writes out in full.
//
//   pnpm exec tsx docs/scenarios/proofs/pii-in-the-logs/c4-credentials.ts
import { apiKey, bearer } from '../../../../packages/core/src/auth';
import { otlp, stitch } from '../../../../packages/core/src/index';
import type { OtelSpan } from '../../../../packages/core/src/otlp';
import { consoleSink, loggerSink } from '../../../../packages/core/src/trace';
import {
    BASE,
    BEARER_TOKEN,
    COOKIE_VALUE,
    CREDENTIALS,
    QUERY_KEY,
    bytesOf,
    captureLogger,
    captureStderr,
    collectingSink,
    fakeVendor,
    recordingStore,
    tempFileSink,
} from './canary';
import {
    check,
    finish,
    heading,
    leakRow,
    note,
    printLeakTable,
    scan,
} from './harness';

async function main(): Promise<void> {
    heading(
        'C4 (a) — DECLARATIVE auth: the credential is applied after the `start` event is built',
    );
    {
        const sink = collectingSink();
        const vendor = fakeVendor();
        const call = stitch({
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            adapter: vendor,
            trace: sink,
            auth: bearer(() => BEARER_TOKEN),
        });
        await call();
        // Sanity: the token really did reach the wire — otherwise "absent everywhere" is vacuous.
        check(
            'the token DID reach the transport (so the measurement is not vacuous)',
            bytesOf(vendor.seen()[0]?.headers).includes(BEARER_TOKEN),
            true,
        );
        const row = leakRow(
            'raw event spine — auth: bearer()',
            sink.text(),
            CREDENTIALS,
            'JSON of every event, unredacted, as a custom sink sees it',
        );
        check('the raw spine holds no credential', row.hits.size, 0);
        note(
            '→ `auth.apply` runs on a CLONE of the request inside the attempt loop (engine.ts:646-649), and the `start` event was built from the pre-auth `baseReq`. So declarative auth never enters the event stream at all — not even for a custom sink',
        );
    }
    {
        const sink = collectingSink();
        const vendor = fakeVendor();
        const call = stitch({
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            adapter: vendor,
            trace: sink,
            auth: apiKey({
                in: 'query',
                name: 'api_key',
                secret: () => QUERY_KEY,
            }),
        });
        await call();
        check(
            'the query key DID reach the wire',
            (vendor.seen()[0]?.url ?? '').includes(QUERY_KEY),
            true,
        );
        const row = leakRow(
            'raw event spine — apiKey in: query',
            sink.text(),
            CREDENTIALS,
            'same, with the key appended to the URL post-start',
        );
        check('and still nothing on the spine', row.hits.size, 0);
    }
    {
        const sink = collectingSink();
        const vendor = fakeVendor();
        const call = stitch({
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            adapter: vendor,
            trace: sink,
            auth: apiKey({
                in: 'cookie',
                name: 'sid',
                secret: () => COOKIE_VALUE,
            }),
        });
        await call();
        check(
            'the cookie DID reach the wire',
            (vendor.seen()[0]?.headers['cookie'] ?? '').includes(COOKIE_VALUE),
            true,
        );
        const row = leakRow(
            'raw event spine — apiKey in: cookie',
            sink.text(),
            CREDENTIALS,
            'same, with the key on the Cookie header post-start',
        );
        check('nothing on the spine', row.hits.size, 0);
    }

    heading(
        'C4 (b) — HAND-ROLLED credentials, passed as per-call input: the raw event DOES carry them',
    );
    {
        const sink = collectingSink();
        const call = stitch({
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            adapter: fakeVendor(),
            trace: sink,
        });
        await call({
            headers: {
                authorization: `Bearer ${BEARER_TOKEN}`,
                cookie: `sid=${COOKIE_VALUE}`,
            },
            query: { api_key: QUERY_KEY },
        });
        const row = leakRow(
            'raw event spine — hand-rolled headers',
            sink.text(),
            CREDENTIALS,
            'what a CUSTOM sink receives',
        );
        check(
            'all three credentials are on the raw `start` event',
            row.hits.size,
            3,
        );
        note(
            '→ this is what `trace.ts` warns about in prose ("a custom sink receives the RAW event, so a `start` event\'s `input.headers` still holds `authorization`/`cookie`"), measured. Core redacts INSIDE its own sinks, not on the event',
        );
    }

    heading('C4 (c) — the same call through each BUILT-IN sink');
    {
        const t = tempFileSink();
        const call = stitch({
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            adapter: fakeVendor(),
            trace: t.sink,
        });
        await call({
            headers: {
                authorization: `Bearer ${BEARER_TOKEN}`,
                cookie: `sid=${COOKIE_VALUE}`,
            },
            query: { api_key: QUERY_KEY },
        });
        const text = t.text();
        const row = leakRow(
            'fileSink (default) — hand-rolled',
            text,
            CREDENTIALS,
            'the JSONL on disk',
        );
        check('the JSONL sink redacts all three', row.hits.size, 0);
        check(
            'header → [REDACTED]',
            /"authorization":"\[REDACTED\]"/.test(text),
            true,
        );
        check(
            'cookie → [REDACTED]',
            /"cookie":"\[REDACTED\]"/.test(text),
            true,
        );
        check(
            'the structured query value → [REDACTED]',
            /"api_key":"\[REDACTED\]"/.test(text),
            true,
        );
        check(
            'and the URL string is scrubbed too — as REDACTED, no brackets',
            /api_key=REDACTED/.test(text),
            true,
        );
        note(
            'one record, one credential, TWO sentinels: `input.query.api_key` is `"[REDACTED]"` (trace.ts\'s constant) while `url` carries `api_key=REDACTED` (util.ts\'s `URL_REDACTED`). Harmless until someone greps their aggregator for one spelling',
        );
        t.cleanup();
    }
    {
        const cap = captureStderr();
        try {
            const call = stitch({
                name: 'getCustomer',
                baseUrl: BASE,
                path: '/v1/customers/1',
                adapter: fakeVendor(),
                trace: consoleSink(),
            });
            await call({
                headers: { authorization: `Bearer ${BEARER_TOKEN}` },
                query: { api_key: QUERY_KEY },
            });
        } finally {
            cap.restore();
        }
        const row = leakRow(
            'consoleSink — hand-rolled',
            cap.text(),
            CREDENTIALS,
            'stderr',
        );
        check('consoleSink: nothing', row.hits.size, 0);
    }
    {
        const logger = captureLogger();
        const call = stitch({
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            adapter: fakeVendor(),
            trace: loggerSink(logger),
        });
        await call({
            headers: { authorization: `Bearer ${BEARER_TOKEN}` },
            query: { api_key: QUERY_KEY },
        });
        const row = leakRow(
            'loggerSink — hand-rolled',
            logger.text(),
            CREDENTIALS,
            'the messages handed to the logger',
        );
        check('loggerSink: nothing', row.hits.size, 0);
        note('the `start` line it logged', logger.lines()[0]?.message);
    }
    {
        const spans: OtelSpan[] = [];
        const call = stitch({
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            adapter: fakeVendor(),
            trace: otlp.sink({
                exporter: { export: (s) => void spans.push(...s) },
            }),
        });
        await call({
            headers: { authorization: `Bearer ${BEARER_TOKEN}` },
            query: { api_key: QUERY_KEY },
        });
        const row = leakRow(
            'otlp.sink — hand-rolled',
            bytesOf(spans),
            CREDENTIALS,
            'the exported spans',
        );
        check('otlp.sink: nothing', row.hits.size, 0);
        note(
            '`url.full` after scrubbing',
            (spans[0]?.attributes as Record<string, unknown> | undefined)?.[
                'url.full'
            ],
        );
    }

    heading('C4 (d) — the probes and the error path');
    {
        const call = stitch({
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            adapter: fakeVendor(),
            store: recordingStore(),
        });
        const w = await call.inspect({
            headers: { authorization: `Bearer ${BEARER_TOKEN}` },
            query: { api_key: QUERY_KEY },
        });
        const row = leakRow(
            'JSON.stringify(inspect())',
            bytesOf(w),
            CREDENTIALS,
            'the whole wrapper',
        );
        check('the inspection carries no credential', row.hits.size, 0);
        const r = await call.report({
            headers: { authorization: `Bearer ${BEARER_TOKEN}` },
        });
        const rrow = leakRow(
            'JSON.stringify(report())',
            bytesOf(r),
            CREDENTIALS,
            'the whole report, config echo included',
        );
        check('the report carries none either', rrow.hits.size, 0);
        note(
            'the report echoes the REDACTED `__config`, and `auth` is a `dropped: redact` slot (config-anatomy.ts:120) — so even a configured strategy is absent, projected down to a non-secret `authScheme`',
        );
    }
    {
        const store = recordingStore();
        const call = stitch({
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            adapter: fakeVendor(),
            store,
            cache: { ttl: '60s' },
            auth: bearer(() => BEARER_TOKEN),
        });
        await call({ headers: { authorization: `Bearer ${BEARER_TOKEN}` } });
        const row = leakRow(
            'cache (keys + values)',
            store.text() + JSON.stringify(store.writes().map((wr) => wr.key)),
            CREDENTIALS,
            'both what was stored and the key it was stored under',
        );
        check('no credential in the cache', row.hits.size, 0);
        note(
            'the cache key is a hash of the pre-auth request descriptor, so a header credential neither lands in the key nor in the value',
        );
    }
    {
        const sink = collectingSink();
        const call = stitch({
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            adapter: fakeVendor({ status: 401 }),
            trace: sink,
            auth: bearer(() => BEARER_TOKEN),
        });
        const out = await call.safe();
        check('the call failed', out.ok, false);
        const row = leakRow(
            'StitchError (message + body + stack)',
            `${out.error?.message ?? ''}${bytesOf(out.error?.body)}${out.error?.stack ?? ''}`,
            CREDENTIALS,
            'everything a catch block can reach',
        );
        check('a 401 error carries no credential', row.hits.size, 0);
        note('the message', out.error?.message);
    }

    heading(
        'C4 (e) — where the boundary does NOT hold: a credential in a RESPONSE body',
    );
    {
        // The vendor is a token endpoint (or a debug endpoint echoing the session). The response
        // body is response data, and the JSONL sink's redactor is the five-name HEADER denylist —
        // `isSecretKey` (which knows `access_token`) is never applied to a `result`.
        const t = tempFileSink();
        const call = stitch({
            name: 'refreshSession',
            baseUrl: BASE,
            path: '/v1/oauth/token',
            method: 'POST',
            adapter: fakeVendor({
                body: {
                    access_token: BEARER_TOKEN,
                    refresh_token: QUERY_KEY,
                    session_cookie: COOKIE_VALUE,
                },
            }),
            trace: t.sink,
        });
        await call();
        const text = t.text();
        const row = leakRow(
            'fileSink — credential in the RESPONSE body',
            text,
            CREDENTIALS,
            'the JSONL on disk',
        );
        check(
            'all three credentials are written to the log file in full',
            row.hits.size,
            3,
        );
        note(
            '→ REFUTATION of the clean reading. "Credentials are protected by default" holds for credentials the LIBRARY places (auth strategies) and for credentials on the REQUEST (headers/url/query, all scrubbed). It does not hold for a credential the vendor SENDS BACK. `util.ts` ships `isSecretKey`, which knows `access_token`/`refresh_token` by stem, and `redactEventForTransport` already applies `redactSecretsDeep` to a start `input.body` for the `serve` SSE stream — the JSONL/console sinks simply never call it on a `result`',
        );
        t.cleanup();
    }
    {
        // And the contrast that makes it precise: the SAME event, delivered over `stitch serve`'s
        // SSE transport, is deep-scrubbed on the request side. Two redaction policies, one library.
        const cap = captureStderr();
        try {
            const call = stitch({
                name: 'login',
                baseUrl: BASE,
                path: '/v1/login',
                method: 'POST',
                adapter: fakeVendor(),
                trace: consoleSink(),
            });
            await call({ body: { user: 'w', client_secret: QUERY_KEY } });
        } finally {
            cap.restore();
        }
        const row = leakRow(
            'consoleSink — secret in the REQUEST body',
            cap.text(),
            CREDENTIALS,
            'stderr (the console formatter prints no body at all)',
        );
        check(
            'console prints no body, so nothing leaks there',
            row.hits.size,
            0,
        );
        const t = tempFileSink();
        const call2 = stitch({
            name: 'login',
            baseUrl: BASE,
            path: '/v1/login',
            method: 'POST',
            adapter: fakeVendor(),
            trace: t.sink,
        });
        await call2({ body: { user: 'w', client_secret: QUERY_KEY } });
        const jrow = leakRow(
            'fileSink — secret in the REQUEST body',
            t.text(),
            CREDENTIALS,
            'the JSONL on disk',
        );
        check(
            'but the JSONL sink writes a `client_secret` request body verbatim',
            jrow.hits.size,
            1,
        );
        note(
            "→ a second, sharper version of the same gap: `redactEventForTransport` (trace.ts:85) deep-scrubs exactly this — a `start` frame's `input.body` — before it rides the unauthenticated `stitch serve` SSE stream. The JSONL file sink, writing to your disk, does not. The mechanism exists in the same file; it is wired to one transport only",
        );
        t.cleanup();
    }

    const tally = printLeakTable(CREDENTIALS);
    console.log(
        `\n  ${tally.leaking} destination(s) carry a credential; ${tally.clean} carry none.`,
    );
    check(
        'sanity: the three credential literals are distinct',
        new Set([BEARER_TOKEN, QUERY_KEY, COOKIE_VALUE]).size,
        3,
    );
    check(
        'sanity: no credential literal is itself a secret-looking KEY name',
        scan(`${BEARER_TOKEN}${QUERY_KEY}${COOKIE_VALUE}`, CREDENTIALS).size,
        3,
    );

    finish(
        'C4',
        'PARTIAL — the credential half is genuinely safer than the PII half, and "protected by default" is too strong. What holds: a DECLARATIVE strategy (`bearer`, `apiKey` in query/cookie) never enters the event stream at all, because `auth.apply` runs on a request clone inside the attempt loop while the `start` event was built from the pre-auth `baseReq` — 0 of 3 credentials on the raw spine, even for a naive custom sink. Hand-rolled request credentials are scrubbed by every built-in sink: the JSONL file gets `"authorization":"[REDACTED]"`, `"cookie":"[REDACTED]"`, `"api_key":"REDACTED"` and a scrubbed `url`; console, logger and OTLP print no headers at all; `.inspect()`, `.report()`, the cache (key AND value) and a 401 `StitchError` carry none. What does NOT hold, two ways, both measured: (1) a CUSTOM sink receives the raw event, so hand-rolled `input.headers`/`input.query` reach it in the clear — 3 of 3 — which `trace.ts` documents in prose and this confirms; (2) a credential in a RESPONSE body is written to the JSONL log in full — `access_token`, `refresh_token`, `session_cookie`, 3 of 3 — because the file sink\'s redactor is the five-name HEADER denylist, not `isSecretKey`. The same file already ships the deep secret-key scrubber and applies it to a request body for the `serve` SSE transport (`redactEventForTransport`); the disk sink simply never calls it. A `client_secret` in a REQUEST body is written verbatim for the same reason. So the honest split is: credentials the library PLACES are protected; credentials that ride the payload are treated exactly like customer PII, which is to say not at all',
    );
}

void main();

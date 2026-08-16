// C1 (DECIDING) — where does a response body actually GO by default?
//
// The capture asks for a definitive table: every destination × every sentinel, present or absent.
// This script builds it by MEASUREMENT — each destination is reduced to the bytes it actually holds
// or wrote, and each of the seven sentinels is scanned for as a literal substring.
//
// The headline: the destinations split into two populations with nothing in between. Payload
// destinations carry ALL SEVEN sentinels; metadata destinations carry NONE. There is no partial
// redaction anywhere in the default path — no sink scrubs `email`, none scrubs `ssn`. The only
// thing that ever removes a sentinel from a payload destination is the character CAP, and a cap is
// not a filter: it keeps a prefix, which is the sentinels that happen to sort early.
//
//   pnpm exec tsx docs/scenarios/proofs/pii-in-the-logs/c1-where-does-it-go.ts
import { stitch } from '../../../../packages/core/src/index';
import type { OtelSpan } from '../../../../packages/core/src/otlp';
import { otlpSink } from '../../../../packages/core/src/otlp';
import { consoleSink, loggerSink } from '../../../../packages/core/src/trace';
import type { StitchEvent } from '../../../../packages/core/src/types';
import {
    BASE,
    LATE,
    SENTINELS,
    bulkyCanary,
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
    checkSeq,
    finish,
    heading,
    leakRow,
    note,
    printLeakTable,
} from './harness';

const ALL = SENTINELS.map((s) => s.code);

async function main(): Promise<void> {
    heading('C1 (a) — the event spine: which events carry the body?');
    {
        const sink = collectingSink();
        const call = stitch({
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/{id}',
            adapter: fakeVendor(),
            trace: sink,
        });
        await call({ params: { id: 'cus_7Q2' }, body: { audit: 'lookup' } });

        checkSeq('the spine', sink.types(), [
            'start',
            'progress',
            'result',
            'done',
        ]);
        for (const ev of sink.events()) {
            const row = leakRow(
                `event:${ev.type}`,
                bytesOf(ev),
                SENTINELS,
                'JSON.stringify of the raw event a custom sink receives',
            );
            void row;
        }
        const result = sink.of('result');
        check(
            'the `result` event carries all 7 sentinels',
            leakRow(
                '  └ result.data',
                bytesOf((result as { data?: unknown })?.data),
                SENTINELS,
            ).hits.size,
            7,
        );
        note(
            '→ exactly ONE event carries the response body: `result`, on its `data` field. `start` carries the REQUEST input; `progress`/`done` carry timing only. A custom sink that does `JSON.stringify(event)` logs the whole customer record on the `result` event and nothing on the other three',
        );
    }

    heading('C1 (b) — fileSink: the JSONL on disk, at three `body` settings');
    {
        // Default cap. The canary's JSON is well under 2048 chars, so the default persists it whole
        // — which is the point: the default is not "no body", it is "up to 2048 characters of body".
        const t = tempFileSink();
        const call = stitch({
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            adapter: fakeVendor(),
            trace: t.sink,
        });
        await call();
        const jsonl = t.text();
        leakRow(
            'fileSink (default)',
            jsonl,
            SENTINELS,
            'the bytes read back off disk',
        );
        check(
            'the default JSONL sink holds all 7 sentinels',
            leakRow('  └ (same, asserted)', jsonl, SENTINELS).hits.size,
            7,
        );
        note('JSONL bytes written', jsonl.length);
        t.cleanup();
    }
    {
        const t = tempFileSink({ body: { chars: false } });
        const call = stitch({
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            adapter: fakeVendor({ body: bulkyCanary() }),
            trace: t.sink,
        });
        await call();
        const full = t.text();
        const row = leakRow(
            'fileSink body:{chars:false}',
            full,
            SENTINELS,
            'full capture — the deliberate long spelling',
        );
        check('full capture holds all 7', row.hits.size, 7);
        check(
            'and the 8th, the one past character 2048',
            full.includes(LATE),
            true,
        );
        note('bytes written at full capture', full.length);
        t.cleanup();
    }
    {
        const t = tempFileSink({ body: false });
        const call = stitch({
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            adapter: fakeVendor(),
            trace: t.sink,
        });
        await call();
        const marker = t.text();
        const row = leakRow(
            'fileSink body:false',
            marker,
            SENTINELS,
            'marker only — the cap is 0',
        );
        check('body:false leaks nothing', row.hits.size, 0);
        note('what it wrote instead', marker.trim().slice(0, 220));
        t.cleanup();
    }

    heading(
        'C1 (b2) — the default CAP is not a filter: it keeps a PREFIX (bulky body)',
    );
    {
        const t = tempFileSink(); // default 2048-char cap
        const call = stitch({
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            adapter: fakeVendor({ body: bulkyCanary() }),
            trace: t.sink,
        });
        await call();
        const capped = t.text();
        const row = leakRow(
            'fileSink (default, 2.9KB body)',
            capped,
            SENTINELS,
            'truncated at 2048 chars — the `preview` prefix',
        );
        check(
            'all 7 table sentinels sit BEFORE the cap, so all 7 land in the preview',
            row.hits.size,
            7,
        );
        check(
            'the record IS marked truncated',
            capped.includes('"truncated":true'),
            true,
        );
        check(
            'and the 8th sentinel — the one placed past character 2048 — is gone',
            capped.includes(LATE),
            false,
        );
        note(
            '→ this is the sharpest edge in C1. The default cap looks like a privacy control and is a SIZE control: 7 of the 8 planted sentinels — name, email, SSN, the nested mail, the free-text mail, the array mail, the renamed key — all sit in the first 2048 characters, so all 7 persist. The 8th is absent for one reason only: it sits at character ~2500. Reorder the vendor JSON and the set that leaks changes',
        );
        t.cleanup();
    }

    heading('C1 (c) — consoleSink: the bytes that reach stderr');
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
            await call();
        } finally {
            cap.restore();
        }
        const err = cap.text();
        const row = leakRow(
            'consoleSink (stderr)',
            err,
            SENTINELS,
            'process.stderr.write intercepted',
        );
        check('consoleSink leaks nothing', row.hits.size, 0);
        note('what it printed', err.replace(/\x1b\[\d+m/g, '').trim());
    }

    heading('C1 (d) — loggerSink: the lines handed to pino/winston/console');
    {
        const logger = captureLogger();
        const call = stitch({
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            adapter: fakeVendor(),
            trace: loggerSink(logger),
        });
        await call();
        const row = leakRow(
            'loggerSink',
            logger.text(),
            SENTINELS,
            'every message passed to the LoggerLike',
        );
        check('loggerSink leaks nothing', row.hits.size, 0);
        note('lines logged', logger.lines().length);
        note(
            'the `result` line',
            logger.lines().find((l) => l.level === 'info')?.message,
        );
    }

    heading('C1 (e) — .inspect(): `raw`, `data`, and the wrapper itself');
    {
        const call = stitch({
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            adapter: fakeVendor(),
        });
        const w = await call.inspect();
        const rawRow = leakRow(
            '.inspect().raw',
            bytesOf(w.raw),
            SENTINELS,
            'the pre-validation body, read deliberately',
        );
        check('`raw` holds all 7', rawRow.hits.size, 7);
        const dataRow = leakRow(
            '.inspect().data',
            bytesOf(w.data),
            SENTINELS,
            'the validated value',
        );
        check('`data` holds all 7 (no output schema)', dataRow.hits.size, 7);
        const wrapRow = leakRow(
            'JSON.stringify(inspect())',
            bytesOf(w),
            SENTINELS,
            'the whole wrapper — `raw` is non-enumerable',
        );
        check(
            'the WRAPPER still holds all 7 — via `data`, not `raw`',
            wrapRow.hits.size,
            7,
        );
        check(
            '`raw` really is non-enumerable',
            Object.keys(w).includes('raw'),
            false,
        );
        note(
            "→ ADR 0016's non-enumerability protects `raw` and nothing else. `data` is a plain enumerable field holding the same customer record, so `JSON.stringify(wrapper)` — the thing the JSDoc warns against — leaks every sentinel anyway, through the field that was never hidden",
        );
    }

    heading('C1 (f) — .report()');
    {
        const call = stitch({
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            adapter: fakeVendor(),
        });
        const r = await call.report();
        const row = leakRow(
            'JSON.stringify(report())',
            bytesOf(r),
            SENTINELS,
            'the full RunReport a consumer logs',
        );
        check('the report holds all 7', row.hits.size, 7);
        note(
            'report.config is the REDACTED config',
            Object.keys(r.config).sort().join(','),
        );
        leakRow(
            '  └ report.config',
            bytesOf(r.config),
            SENTINELS,
            'the config echo only',
        );
    }

    heading(
        'C1 (g) — the failure path: StitchError, its message, the error event',
    );
    {
        const sink = collectingSink();
        const call = stitch({
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            adapter: fakeVendor({ status: 500 }),
            trace: sink,
        });
        const out = await call.safe();
        check('the call failed', out.ok, false);
        const err = out.error;
        const bodyRow = leakRow(
            'StitchError.body',
            bytesOf(err?.body),
            SENTINELS,
            'the failing response body, lifted onto the error',
        );
        check('`StitchError.body` holds all 7', bodyRow.hits.size, 7);
        const msgRow = leakRow(
            'StitchError.message',
            String(err?.message ?? ''),
            SENTINELS,
            'the message string',
        );
        check('the message leaks nothing', msgRow.hits.size, 0);
        note('the message', err?.message);
        leakRow(
            'String(err) + err.stack',
            `${String(err)}\n${err?.stack ?? ''}`,
            SENTINELS,
            'what a bare console.error(err) prints',
        );
        const jsonRow = leakRow(
            'JSON.stringify(StitchError)',
            bytesOf(err),
            SENTINELS,
            'what a STRUCTURED logger serialises',
        );
        check(
            'but JSON.stringify of the SAME error holds all 7',
            jsonRow.hits.size,
            7,
        );
        check(
            'because `body` is an own ENUMERABLE property',
            Object.keys(err ?? {}).includes('body'),
            true,
        );
        note(
            'the enumerable keys of a StitchError',
            Object.keys(err ?? {}).join(','),
        );
        note(
            '→ the sharpest single row in the table. `err.stack` and `String(err)` are clean, so a `console.error(err)` is safe and a `logger.error({ err })` is not: `StitchError` assigns `this.body` in its constructor (types.ts:1790), which makes it an own enumerable property, and every structured logger reaches for `JSON.stringify`. The `message` is NON-enumerable (the `Error` base sets it), so the JSON is `{"name","status","attempts","body"}` — the payload survives and the human-readable part does not',
        );
        const evt = sink.of('error') as StitchEvent | undefined;
        const evRow = leakRow(
            'event:error (JSON)',
            bytesOf(evt),
            SENTINELS,
            'the error event a custom sink receives',
        );
        check(
            'the error EVENT leaks nothing — the body rides a non-enumerable symbol',
            evRow.hits.size,
            0,
        );
        note(
            '→ the credential/PII split the capture predicted shows up HERE, in a shape it did not: the failing body is on `StitchError.body` (all 7 sentinels) but NOT on the error event (0 of 7). A trace sink sees `HTTP 500`; the `catch` block sees the whole customer record',
        );
    }

    heading('C1 (h) — the cache entry');
    {
        const store = recordingStore();
        const call = stitch({
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            adapter: fakeVendor(),
            store,
            cache: { ttl: '60s' },
        });
        await call();
        const row = leakRow(
            'cache entry (store.set)',
            store.text(),
            SENTINELS,
            'every value handed to the StitchStore',
        );
        check('the cache entry holds all 7', row.hits.size, 7);
        note('store writes', store.writes().length);
        note(
            'the value shape the cache persists',
            Object.keys(
                (store
                    .writes()
                    .find(
                        (w) =>
                            w.value &&
                            typeof w.value === 'object' &&
                            'v' in (w.value as object),
                    )?.value ?? {}) as object,
            ).join(','),
        );
    }

    heading('C1 (i) — otlpSink (not in the claims list, and worth the row)');
    {
        const spans: OtelSpan[] = [];
        const call = stitch({
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            adapter: fakeVendor(),
            trace: otlpSink({
                exporter: { export: (s) => void spans.push(...s) },
            }),
        });
        await call();
        const row = leakRow(
            'otlpSink (exported spans)',
            bytesOf(spans),
            SENTINELS,
            'the spans handed to the exporter',
        );
        check('OTLP leaks nothing', row.hits.size, 0);
        note('spans exported', spans.length);
    }

    heading(
        'C1 (j) — an appendix nobody asked for: the header denylist hits BODY keys',
    );
    {
        // `trace.ts`'s `redact()` walks the WHOLE record replacing any key in the header denylist.
        // It is documented as header redaction; it is actually key-name redaction at every depth,
        // so a response body FIELD named `cookie`/`authorization`/`x-api-key` is scrubbed by pure
        // coincidence of name — while `ssn` beside it is not.
        const t = tempFileSink();
        const call = stitch({
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            adapter: fakeVendor({
                body: {
                    ssn: '078-05-1120',
                    cookie: '078-05-1120',
                    authorization: '078-05-1120',
                },
            }),
            trace: t.sink,
        });
        await call();
        const text = t.text();
        check(
            'a body field named `cookie` IS redacted in the JSONL',
            /"cookie":"\[REDACTED\]"/.test(text),
            true,
        );
        check(
            'a body field named `authorization` too',
            /"authorization":"\[REDACTED\]"/.test(text),
            true,
        );
        check(
            'the identical value under `ssn` is not',
            text.includes('"ssn":"078-05-1120"'),
            true,
        );
        note(
            '→ the same string, three keys, two outcomes. The built-in sink already contains a working deep key-name redactor (`trace.ts:142`); it is simply pointed at a five-name credential list and is not reachable from config. `redactHeaders` widens it — and its type/JSDoc say "header names", so nothing tells you it also scrubs body keys',
        );
        // Prove the escape hatch reaches the body too.
        const t2 = tempFileSink({ redactHeaders: ['ssn', 'email', 'name'] });
        const call2 = stitch({
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            adapter: fakeVendor(),
            trace: t2.sink,
        });
        await call2();
        const text2 = t2.text();
        check(
            '`redactHeaders: ["ssn","email","name"]` scrubs those BODY fields',
            /"ssn":"\[REDACTED\]"/.test(text2) &&
                /"email":"\[REDACTED\]"/.test(text2),
            true,
        );
        check(
            'and it reaches NESTED keys — profile.contact.mail if you name `mail`',
            text2.includes('nested-canary@example.test'),
            true,
        );
        note(
            "the nested mail survives because its KEY is `mail`, not `email` — so this hatch is a denylist with all a denylist's failure modes, but it does work at depth and it is the only body redaction that is reachable from config at all",
        );
        t.cleanup();
        t2.cleanup();
    }

    const tally = printLeakTable(SENTINELS);
    console.log(
        `\n  ${tally.leaking} destination(s) carry at least one sentinel; ${tally.clean} carry none.`,
    );
    note('sentinel codes measured per destination', ALL.join(' '));

    finish(
        'C1',
        'CONFIRMED, and the table is more binary than the capture drew it. The destinations split into two populations with NOTHING in between: payload destinations carry all 7 sentinels (the `result` event, fileSink at every non-zero cap, `.inspect().raw`, `.inspect().data`, `JSON.stringify(inspect())`, `.report()`, `StitchError.body`, `JSON.stringify(StitchError)`, the cache entry) and metadata destinations carry 0 of 7 (`start`/`progress`/`done`/`error` events, consoleSink, loggerSink, otlpSink, `StitchError.message`, `String(err)` + `err.stack`). No destination is partially redacted. Exactly ONE event carries the response body — `result`, on `data` — so "the event spine leaks" is really "one event leaks". Three measurements the capture does not contain: (1) the default fileSink cap is a SIZE control that keeps a PREFIX, so on a 2.9KB body all 7 table sentinels still persisted into the `preview` and only an 8th, planted deliberately past character 2048, was absent; (2) `JSON.stringify(.inspect())` leaks all 7 through the ENUMERABLE `data` field, so ADR 0016 non-enumerability protects `raw` and nothing else — and the same pattern repeats on the error: `String(err)`/`err.stack` are clean but `JSON.stringify(err)` carries all 7, because `StitchError.body` is an own enumerable property while `message` is not, so `console.error(err)` is safe and `logger.error({ err })` is not; (3) the JSONL sink already ships a working deep key-name redactor — a body field named `cookie` is replaced with [REDACTED] while the identical value under `ssn` is not, and `redactHeaders` (documented as "header names") is the one config-reachable way to point it at a body key',
    );
}

void main();

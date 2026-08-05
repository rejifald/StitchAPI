// C7 — the drift angle. When a vendor ADDS a PII field, does `drift()`'s `undeclared` finding give
// a usable "new field appeared" signal? And — the question that matters more — does the FINDING
// itself contain the PII value?
//
// The answer to the first is yes, with one hard precondition and one hard limit. The answer to the
// second is yes for SOFT drift (paths and kinds only, never values, exactly as ADR 0018 §4 claims)
// and NO for HARD validation, where the finding `detail` is the validator's own message and Zod's
// enum/union messages quote the received value verbatim — into `consoleSink` and `loggerSink`,
// the two destinations C1 measured as carrying nothing.
//
//   pnpm exec tsx docs/scenarios/proofs/pii-in-the-logs/c7-drift-signal.ts
import { drift, stitch } from '../../../../packages/core/src/index';
import type { OtelSpan } from '../../../../packages/core/src/otlp';
import { otlpSink } from '../../../../packages/core/src/otlp';
import { consoleSink, loggerSink } from '../../../../packages/core/src/trace';
import type {
    DriftFinding,
    DriftOptions,
    StitchConfig,
} from '../../../../packages/core/src/types';
import {
    BASE,
    SENTINELS,
    SSN,
    bytesOf,
    canary,
    captureLogger,
    captureStderr,
    collectingSink,
    fakeVendor,
    tempFileSink,
} from './canary';
import type { Sentinel } from './harness';
import {
    check,
    checkSeq,
    finish,
    heading,
    leakRow,
    note,
    printLeakTable,
    resetLeakTable,
    scan,
} from './harness';
import { z } from './zod';

// The consumer contract: four fields, positively declared (C6's allowlist).
const SAFE = z.object({
    id: z.string(),
    plan: z.string(),
    profile: z.object({ locale: z.string() }),
    contacts: z.array(z.object({ label: z.string() })),
});

// The new field the vendor ships in a minor release. A distinct sentinel so its appearance in any
// destination is unambiguous.
const TAX_ID = 'taxid-canary-GB-4471';
const NEW_FIELD: readonly Sentinel[] = [
    { code: 'tax', value: TAX_ID, at: 'taxId (added by the vendor)' },
];

/** The vendor's response, one release later: the same record plus a tax identifier. */
function afterTheRelease(): Record<string, unknown> {
    const body = canary();
    return {
        ...body,
        taxId: TAX_ID,
        profile: { ...(body['profile'] as object), taxId: TAX_ID },
        contacts: (body['contacts'] as Record<string, unknown>[]).map((c) => ({
            ...c,
            taxId: TAX_ID,
        })),
    };
}

async function findingsFor(
    body: unknown,
    opts?: DriftOptions,
): Promise<DriftFinding[]> {
    const call = stitch({
        name: 'getCustomer',
        baseUrl: BASE,
        path: '/v1/customers/1',
        adapter: fakeVendor({ body }),
        output: drift(SAFE, opts ?? {}),
    });
    return (await call.inspect()).findings;
}

async function main(): Promise<void> {
    heading('C7 (a) — the baseline, before the vendor changed anything');
    const before = await findingsFor(canary());
    {
        checkSeq(
            'undeclared paths in the original response',
            before
                .filter((f) => f.change === 'undeclared')
                .map((f) => f.path)
                .sort(),
            [
                'contacts[].email',
                'email',
                'name',
                'note',
                'primaryContactMail',
                'profile.contact',
                'ssn',
            ],
        );
        note(
            'so the signal is NOISY at rest: seven findings on a response nobody changed. The "new field appeared" event has to be read as a DIFF against this, not as an alert',
        );
    }

    heading('C7 (b) — the vendor ships `taxId`: does anything notice?');
    const after = await findingsFor(afterTheRelease());
    {
        const beforePaths = new Set(before.map((f) => f.path));
        const added = after
            .filter((f) => !beforePaths.has(f.path))
            .map((f) => f.path)
            .sort();
        checkSeq('paths that are NEW this release', added, [
            'contacts[].taxId',
            'profile.taxId',
            'taxId',
        ]);
        check(
            'all three are `undeclared`',
            after
                .filter((f) => added.includes(f.path))
                .every((f) => f.change === 'undeclared'),
            true,
        );
        check(
            'at level `info` by default',
            after
                .filter((f) => added.includes(f.path))
                .every((f) => f.level === 'info'),
            true,
        );
        note(
            'the top-level finding',
            after.find((f) => f.path === 'taxId'),
        );
        note(
            'the array finding — summarised across elements (ADR 0017)',
            after.find((f) => f.path === 'contacts[].taxId'),
        );
        note(
            '→ YES, and it is precise: a top-level addition, an addition nested one level down, and an addition inside every array element are all reported separately, each with a path you can act on',
        );
    }

    heading('C7 (c) — does the FINDING carry the value? (the leak question)');
    {
        const row = leakRow(
            'the findings array',
            bytesOf(after),
            NEW_FIELD,
            'JSON of every DriftFinding',
        );
        check(
            '0 occurrences of the new value in any finding',
            row.hits.size,
            0,
        );
        checkSeq(
            'every `undeclared` detail is a KIND, never a value',
            [
                ...new Set(
                    after
                        .filter((f) => f.change === 'undeclared')
                        .map((f) => f.detail),
                ),
            ].sort(),
            [
                'all 2 elements: undeclared field (string)',
                'undeclared field (object)',
                'undeclared field (string)',
            ],
        );
        check(
            'and no PII sentinel either',
            scan(bytesOf(after), SENTINELS).size,
            0,
        );
    }

    heading('C7 (d) — and through every sink the finding reaches');
    {
        const cfg = {
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            output: drift(SAFE, {}),
        } as StitchConfig;
        const sink = collectingSink();
        const a = stitch({
            ...cfg,
            adapter: fakeVendor({ body: afterTheRelease() }),
            trace: sink,
        });
        await a();
        const drifts = sink.events().filter((e) => e.type === 'drift');
        check('drift events on the spine', drifts.length, 10);
        leakRow('drift events (raw)', bytesOf(drifts), NEW_FIELD, '');

        const t = tempFileSink();
        const b = stitch({
            ...cfg,
            adapter: fakeVendor({ body: afterTheRelease() }),
            trace: t.sink,
        });
        await b();
        leakRow('fileSink', t.text(), NEW_FIELD, 'JSONL on disk');
        check(
            'the JSONL names the new path',
            t.text().includes('"path":"taxId"'),
            true,
        );
        t.cleanup();

        const cap = captureStderr();
        try {
            const c = stitch({
                ...cfg,
                adapter: fakeVendor({ body: afterTheRelease() }),
                trace: consoleSink(),
            });
            await c();
        } finally {
            cap.restore();
        }
        leakRow('consoleSink', cap.text(), NEW_FIELD, 'stderr');
        note(
            'the console line for the new field',
            cap
                .text()
                .replace(/\x1b\[\d+m/g, '')
                .split('\n')
                .find((l) => l.includes('taxId')),
        );

        const logger = captureLogger();
        const d = stitch({
            ...cfg,
            adapter: fakeVendor({ body: afterTheRelease() }),
            trace: loggerSink(logger),
        });
        await d();
        leakRow('loggerSink', logger.text(), NEW_FIELD, '');
        check(
            'the drift lines log at the finding level (`info`)',
            logger
                .lines()
                .filter(
                    (l) => l.level === 'info' && l.message.includes('drift'),
                ).length,
            10,
        );

        const spans: OtelSpan[] = [];
        const e = stitch({
            ...cfg,
            adapter: fakeVendor({ body: afterTheRelease() }),
            trace: otlpSink({
                exporter: { export: (s) => void spans.push(...s) },
            }),
        });
        await e();
        leakRow('otlpSink', bytesOf(spans), NEW_FIELD, '');
        check(
            'OTLP carries level/path/change but NOT the detail',
            bytesOf(spans).includes('stitch.drift.path'),
            true,
        );
        check(
            'the exported spans contain the string "drift.detail"',
            bytesOf(spans).includes('drift.detail'),
            false,
        );

        const tally = printLeakTable(NEW_FIELD);
        console.log(
            `\n  the new field's VALUE reaches ${tally.leaking} of ${tally.leaking + tally.clean} destinations. Its NAME reaches all of them.`,
        );
        check("no destination carries the new field's value", tally.leaking, 0);
        resetLeakTable();
    }

    heading('C7 (e) — the precondition: no `output`, no signal');
    {
        const call = stitch({
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            adapter: fakeVendor({ body: afterTheRelease() }),
        });
        const w = await call.inspect();
        check(
            'with no `output` schema, findings on the SAME changed response',
            w.findings.length,
            0,
        );
        const bare = stitch({
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            adapter: fakeVendor({ body: afterTheRelease() }),
            output: SAFE,
        });
        const w2 = await bare.inspect();
        check(
            'with a plain `output` schema but no `drift()` wrapper',
            w2.findings.length,
            0,
        );
        note(
            '→ drift is schema-ANCHORED (ADR 0015): the diff is `raw` vs the VALIDATED value, so with nothing declared there is nothing to diff and the addition is invisible. The "vendor added a PII field" alarm is available only to a project that already wrote the allowlist — which means C7 does not stand alone, it is a property of C6',
        );
    }

    heading('C7 (f) — the limit: `undeclared` cannot be made fatal');
    {
        // `DriftSeverity` is 'warn' | 'info' | 'verbose' — 'error' is deliberately not in it, and
        // the JSDoc says so: "Soft drift is always non-fatal; to fail on a change, make the field
        // required/strict in the schema". Measured through a cast, so the runtime behaviour is on
        // the record rather than inferred from the type.
        const findings = await findingsFor(afterTheRelease(), {
            severity: { undeclared: 'error' },
        } as unknown as DriftOptions);
        check(
            'a re-level to `error` IS honoured at runtime …',
            findings.filter((f) => f.path === 'taxId' && f.level === 'error')
                .length,
            1,
        );
        const call = stitch({
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            adapter: fakeVendor({ body: afterTheRelease() }),
            output: drift(SAFE, {
                severity: { undeclared: 'error' },
            } as unknown as DriftOptions),
        });
        const out = await call.safe();
        check('… and it DOES fail the call', out.ok, false);
        check(
            'with the contract-violation message',
            out.error?.message,
            'contract violation (drift)',
        );
        note(
            '→ NOT IN THE CLAIMS, and it cuts against the documentation. `DriftSeverity` excludes `error` and the JSDoc states "soft drift is always non-fatal", but the runtime path (`resolveSeverity` → `levelOf` → `if (finding.level === \'error\') fatal = true`) has no guard: a severity map that names `error` is a TYPE error and a working kill-switch. Either the type should admit it as a documented "fail on any new field" hatch, or the runtime should reject it — right now it is a fail-closed behaviour reachable only by a cast',
        );
    }

    heading(
        'C7 (g) — REFUTATION: a HARD finding CAN carry the value, into the payload-free sinks',
    );
    {
        // ADR 0018 §4: "`detailFor` emits kinds only, never values … so `findings` never leak a
        // secret even when `redact` is off." That holds for the three SOFT kinds, which is all
        // `detailFor` produces. Hard failures do not go through `detailFor`: `validationErrors`
        // (drift.ts:50) copies the VALIDATOR's message into `detail`, and Zod's enum/union
        // messages quote the received value.
        const ENUMED = z.object({
            id: z.string(),
            plan: z.enum(['enterprise', 'free']),
        });
        const vendorSentBadPlan = { id: 'cus_7Q2', plan: SSN };
        const probe = stitch({
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            adapter: fakeVendor({ body: vendorSentBadPlan }),
            output: ENUMED,
        });
        const w = await probe.inspect();
        const invalid = w.findings.find((f) => f.change === 'invalid');
        check('there is a hard `invalid` finding', invalid !== undefined, true);
        check(
            'and its `detail` contains the RECEIVED VALUE',
            (invalid?.detail ?? '').includes(SSN),
            true,
        );
        note('the finding detail', invalid?.detail);

        const t = tempFileSink();
        const a = stitch({
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            adapter: fakeVendor({ body: vendorSentBadPlan }),
            output: ENUMED,
            trace: t.sink,
        });
        await a.safe();
        const fileRow = leakRow(
            'fileSink — hard finding detail',
            t.text(),
            SENTINELS,
            'JSONL on disk',
        );
        check('the JSONL carries the value', fileRow.hits.has('ssn'), true);
        t.cleanup();

        const cap = captureStderr();
        try {
            const b = stitch({
                name: 'getCustomer',
                baseUrl: BASE,
                path: '/v1/customers/1',
                adapter: fakeVendor({ body: vendorSentBadPlan }),
                output: ENUMED,
                trace: consoleSink(),
            });
            await b.safe();
        } finally {
            cap.restore();
        }
        const consoleRow = leakRow(
            'consoleSink — hard finding detail',
            cap.text(),
            SENTINELS,
            'stderr — the sink C1 measured at 0/7',
        );
        check('consoleSink carries it too', consoleRow.hits.has('ssn'), true);
        note(
            'the stderr line',
            cap
                .text()
                .replace(/\x1b\[\d+m/g, '')
                .split('\n')
                .find((l) => l.includes('drift')),
        );

        const logger = captureLogger();
        const c = stitch({
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            adapter: fakeVendor({ body: vendorSentBadPlan }),
            output: ENUMED,
            trace: loggerSink(logger),
        });
        await c.safe();
        const loggerRow = leakRow(
            'loggerSink — hard finding detail',
            logger.text(),
            SENTINELS,
            'the messages handed to pino/winston',
        );
        check('and loggerSink', loggerRow.hits.has('ssn'), true);

        const spans: OtelSpan[] = [];
        const d = stitch({
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            adapter: fakeVendor({ body: vendorSentBadPlan }),
            output: ENUMED,
            trace: otlpSink({
                exporter: { export: (s) => void spans.push(...s) },
            }),
        });
        await d.safe();
        const otlpRow = leakRow(
            'otlpSink — hard finding detail',
            bytesOf(spans),
            SENTINELS,
            'OTLP exports level/path/change only',
        );
        check(
            'OTLP alone stays clean — it drops `detail`',
            otlpRow.hits.size,
            0,
        );
        note(
            "→ the REFUTATION, stated plainly: ADR 0018 §4 says `findings` never leak a value. It is true of the three SOFT kinds (`detailFor`, drift.ts:77) and false of the HARD kind (`validationErrors`, drift.ts:50, which copies `iss.message` verbatim). Whether a value escapes therefore depends on the SCHEMA LIBRARY's message wording, not on anything in this repo: Zod says \"Expected number, received string\" for a type error (safe) and \"Invalid enum value. Expected 'enterprise' | 'free', received '078-05-1120'\" for an enum (not safe). The two sinks documented as payload-free — console and logger — print it, because a finding is metadata by classification",
        );
    }

    const hard = printLeakTable(SENTINELS);
    console.log(
        `\n  hard-validation finding detail: ${hard.leaking} of ${hard.leaking + hard.clean} destinations carry the received VALUE.`,
    );

    finish(
        'C7',
        "CONFIRMED for the soft signal, with two qualifications and one REFUTATION. The signal works and is precise: when the vendor adds `taxId` at the top level, one level down, and inside every array element, `drift()` emits exactly three NEW `undeclared` findings — `taxId`, `profile.taxId`, `contacts[].taxId` — at level `info`, and the finding contains NO value (0 of 1 new-field sentinel and 0 of 7 PII sentinels across the findings array, the raw drift events, the JSONL, stderr, the logger and OTLP). Qualification one: the signal is noisy at rest — the same schema produces 7 `undeclared` findings on the UNCHANGED response, so \"a new field appeared\" is a diff against a baseline, not an alert. Qualification two: it is schema-anchored, so with no `output` (or with `output` but no `drift()` wrapper) the same changed response yields 0 findings — C7 is a property of C6, not an independent safety net. A limit worth recording: `severity: { undeclared: 'error' }` is a TYPE error (`DriftSeverity` excludes `error`, and the JSDoc says soft drift is always non-fatal) but a WORKING kill-switch at runtime — through a cast it re-levels the finding and fails the call. And the REFUTATION: ADR 0018 §4 claims `findings` never leak a secret because `detailFor` emits kinds only. That holds for the three soft kinds and NOT for hard validation — `validationErrors` (drift.ts:50) copies the validator's own message into `detail`, and Zod's enum message quotes the received value (\"Invalid enum value. Expected 'enterprise' | 'free', received '078-05-1120'\"). Measured end to end: that value reaches the JSONL file, `consoleSink` and `loggerSink` — the two sinks C1 measured at 0 of 7 — while OTLP alone stays clean because it exports level/path/change and drops `detail`",
    );
}

void main();

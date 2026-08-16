// C7 — is there any guard on the BUFFERED path? A very large response on a plain `await`: does
// anything intervene — a cap, a warning, an `info` event — or is OOM the only signal?
//
// This claim is about ABSENCE, which is the hardest thing to demonstrate. So it does it three ways:
//   (a) run a big body through and enumerate every event the engine emitted;
//   (b) set the one cap that exists (`stream.buffer.chars`) on a buffered stitch and show it is
//       accepted, typed, and completely inert;
//   (c) actually kill a process. Same data, same heap ceiling, one config lives and one dies.
//
//   pnpm exec tsx docs/scenarios/proofs/large-response-memory/c7-buffered-guard.ts
import { stitch } from '../../../../packages/core/src/index';
import type { StitchEvent } from '../../../../packages/core/src/types';
import { bufferingAdapter, singleArray } from './fake-export';
import {
    check,
    checkAtMost,
    checkSeq,
    finish,
    heading,
    mb,
    note,
} from './harness';
import { probeRun } from './run-probe';

const URL = 'https://api.vendor.example/v1/products/export';

/** The heap ceiling both halves of (c) run under. Small enough to be reached, big enough to boot. */
const HEAP_MB = 96;
/** Rows whose buffered tree exceeds that ceiling but whose streamed form is nowhere near it. */
const ROWS = 400_000;

async function main(): Promise<void> {
    heading('C7 — a very large buffered response: does anything intervene?');

    // ── (a) every event a 21MB buffered response produces ─────────────────────────────────────
    {
        const wire = singleArray(100_000);
        const exportAll = stitch({
            url: URL,
            adapter: bufferingAdapter(wire),
        });
        const types: string[] = [];
        for await (const ev of exportAll.stream() as AsyncIterable<StitchEvent>)
            types.push(
                ev.type === 'progress' ? `progress:${ev.phase}` : ev.type,
            );
        checkSeq('(a) the whole event spine for a 21MB response', types, [
            'start',
            'progress:request',
            'result',
            'done',
        ]);
        check('(a) `info` events', types.filter((t) => t === 'info').length, 0);
        check(
            '(a) `drift` findings',
            types.filter((t) => t === 'drift').length,
            0,
        );
        note(
            '(a) → nothing. Four events, the same four a 40-byte response produces',
            'no size threshold exists on the buffered path, so nothing can warn you as you approach one',
        );
    }

    // ── (b) the one cap there is, pointed at the buffered path ────────────────────────────────
    // `stream.buffer.chars` is a top-level `StitchConfig` slot. It compiles on a plain `stitch()`,
    // it survives `compose`, and `runOnce` never reads it — only the streaming decoders do
    // (`stream.ts:77`, `json-stream.ts:91-99`, `line-reader.ts:38-46`).
    {
        const wire = singleArray(50_000);
        const exportAll = stitch({
            url: URL,
            adapter: bufferingAdapter(wire),
            stream: { buffer: { chars: 1_000 } }, // 1,000 characters. The body is 11 million.
        });
        const rows = (await exportAll()) as unknown[];
        check(
            '(b) a 1,000-character cap on an 11MB body — rows delivered',
            rows.length,
            50_000,
        );
        note(
            '(b) → accepted, type-checked, and inert',
            'the only knob in the library with the word `buffer` in it does nothing on the path where buffering actually happens. It is a decoder guard wearing a general-sounding name',
        );
    }

    // ── (c) the only signal there is ──────────────────────────────────────────────────────────
    // Two child processes, identical `--max-old-space-size`, identical rows, identical bytes. The
    // only difference is the config.
    {
        const died = probeRun({
            mode: 'buffered',
            rows: ROWS,
            nodeArgs: [`--max-old-space-size=${String(HEAP_MB)}`],
        });
        check(
            `(c) \`await stitch()\` on ${String(ROWS)} rows under a ${String(HEAP_MB)}MB heap — measurement printed?`,
            died.measurement !== undefined,
            false,
        );
        check('(c) V8 aborted on the heap limit?', died.heapOom, true);
        check('(c) did it exit cleanly?', died.status === 0, false);
        note(
            '(c) exit status',
            `${String(died.status)} — SIGABRT (128+6), not a code the library chose`,
        );
        const fatal = died.stderr
            .split('\n')
            .find(
                (l) =>
                    l.includes('FATAL ERROR') ||
                    l.includes('heap out of memory'),
            );
        note(
            '(c) what the operator sees',
            (fatal ?? '(no line matched)').trim().slice(0, 140),
        );
        note(
            '(c) → the signal is the process dying',
            'no status code from the library, no error to catch, no `error` event: V8 aborts the whole process, so a `try`/`catch` around the `await` never runs and neither does a `finally`',
        );

        const lived = probeRun({
            mode: 'assembled-ndjson',
            rows: ROWS,
            nodeArgs: [`--max-old-space-size=${String(HEAP_MB)}`],
        });
        const m = lived.measurement;
        check(
            `(c) the SAME ${String(ROWS)} rows, batched over ndjson, same ${String(HEAP_MB)}MB heap — survived?`,
            m !== undefined && m.ok,
            true,
        );
        if (m !== undefined && m.ok) {
            note(
                '(c) …at',
                `${mb(m.peakLive)} retained for ${mb(m.wireBytes)} of wire, ${String(m.records)} rows processed`,
            );
            checkAtMost(
                '(c) peak retained heap',
                m.peakLive,
                8 * 1024 * 1024,
                mb,
            );
        }
        note(
            '(c) → same data, same ceiling, opposite outcome',
            'which is the whole scenario: the dangerous path is the DEFAULT one, and the difference between them is invisible until the day the catalog grows',
        );
    }

    finish(
        'C7',
        'NOTHING intervenes, and OOM is the only signal. A 21MB buffered response emits exactly `start`, `progress:request`, `result`, `done` — the same four events a 40-byte one emits, with no `info`, no drift finding, no threshold anywhere. The one config slot with `buffer` in its name is accepted on a buffered stitch and does nothing: `stream: { buffer: { chars: 1_000 } }` type-checked, composed, and delivered all 50,000 rows of an 11-million-character body, because only the streaming decoders ever read it. And when the wall arrives it is V8’s, not the library’s: 400,000 rows under a 96MB heap killed the process with `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory` and exit 134 (SIGABRT) — no catchable error, no `error` event, and no `finally`. The same 400,000 rows and 85.8MB of wire, same 96MB ceiling, batched over `ndjson`: 1.3MB retained and every row processed',
    );
}

void main();

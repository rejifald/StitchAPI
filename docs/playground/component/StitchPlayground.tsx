/**
 * <StitchPlayground/> — the docs playground UI shell.
 *
 * SCAFFOLD ONLY. The code-execution engine is DEFERRED (see ../REQUIREMENTS.md).
 * This shell is built entirely against the `CodeRunner` contract from ./runner.ts,
 * so it renders today with the `mockRunner` and will light up for real the moment
 * an in-house `CodeRunner` is dropped in — no UI changes required.
 *
 * Deliberately dependency-light for now:
 *   - editor = a plain <textarea>. The CodeMirror 6 integration point is marked
 *     `EDITOR INTEGRATION POINT` below; swapping it in is a localized change.
 *   - no syntax highlight / autocomplete yet — that arrives with CM6.
 *
 * Targets the future Fumadocs (Next.js/React) app. NOT compiled by the stitchapi
 * library build (tsconfig `include` is `src/**\/*.ts`). Requires `react` (and later
 * `@codemirror/*`) once relocated into the docs app.
 */
import { type CodeRunner, type RunResult, mockRunner } from './runner';
import { buildRunView } from './output-format';

import { useCallback, useMemo, useRef, useState } from 'react';

export interface StitchPlaygroundProps {
    /** Initial editor contents. */
    initialCode?: string;
    /**
     * The execution engine.
     *
     * RUNNER INTEGRATION POINT — wire order (first truthy wins):
     *   1. Caller supplies a `dispatchRunner(opts)` result (D1) — the real engine
     *      that does the §3 surface scan and routes to browser / server runner.
     *   2. Caller supplies any other `CodeRunner` (e.g. a bare browserWorkerRunner).
     *   3. No runner supplied → falls back to `mockRunner` (canned output for dev/
     *      snapshot testing). The shell is fully usable in this mode.
     *
     * Once D1 lands, the docs app wires it like:
     *   import { dispatchRunner } from '../contracts/dispatch';
     *   import { browserWorkerRunner } from '../runtime/browser-worker-runner';
     *   const runner = dispatchRunner({ browser: browserWorkerRunner });
     *   <StitchPlayground runner={runner} />
     */
    runner?: CodeRunner;
    /** Globals exposed to the snippet (the browser `stitch` build goes here). */
    scope?: Record<string, unknown>;
    /** Editor height in px. */
    height?: number;
    /** Read-only display (docs example you can't edit). */
    readOnly?: boolean;
}

const DEFAULT_SNIPPET = `// Edit and run. Output appears below.
const user = await stitch('https://reqres.in/api/users/2');
console.log(user);
`;

export function StitchPlayground({
    initialCode = DEFAULT_SNIPPET,
    runner = mockRunner,
    scope,
    height = 220,
    readOnly = false,
}: StitchPlaygroundProps) {
    const [code, setCode] = useState(initialCode);
    const [result, setResult] = useState<RunResult | null>(null);
    const [running, setRunning] = useState(false);
    const abortRef = useRef<AbortController | null>(null);

    const isDeferred = runner.id === 'deferred';

    const run = useCallback(async () => {
        abortRef.current?.abort();
        const ac = new AbortController();
        abortRef.current = ac;
        setRunning(true);
        try {
            const res = await runner.run({ code, scope, signal: ac.signal });
            if (!ac.signal.aborted) setResult(res);
        } finally {
            if (!ac.signal.aborted) setRunning(false);
        }
    }, [code, runner, scope]);

    const stop = useCallback(() => abortRef.current?.abort(), []);
    const reset = useCallback(() => {
        setCode(initialCode);
        setResult(null);
    }, [initialCode]);

    const status = useMemo(() => {
        if (isDeferred) return 'engine deferred';
        if (running) return 'running…';
        if (result?.error) return `error · ${result.error.phase}`;
        if (result) return `done · ${result.durationMs}ms`;
        return 'ready';
    }, [isDeferred, running, result]);

    return (
        <div className="stitch-playground" data-runner={runner.id}>
            <div className="stitch-playground__toolbar">
                <span className="stitch-playground__status">{status}</span>
                <div className="stitch-playground__actions">
                    {running ? (
                        <button type="button" onClick={stop}>
                            Stop
                        </button>
                    ) : (
                        <button
                            type="button"
                            onClick={run}
                            disabled={isDeferred}
                        >
                            Run
                        </button>
                    )}
                    <button type="button" onClick={reset} disabled={running}>
                        Reset
                    </button>
                </div>
            </div>

            {/* EDITOR INTEGRATION POINT — replace this <textarea> with CodeMirror 6
                (lang: TS/JSX, theme synced to the docs light/dark mode). Keep the
                `code`/`setCode` controlled-value contract and nothing else changes. */}
            <textarea
                className="stitch-playground__editor"
                style={{ height, width: '100%', fontFamily: 'monospace' }}
                value={code}
                spellCheck={false}
                readOnly={readOnly}
                onChange={(e) => setCode(e.target.value)}
                aria-label="StitchAPI playground editor"
            />

            <StitchOutput result={result} deferred={isDeferred} />
        </div>
    );
}

/**
 * Output panel — renders:
 *   · ordered console logs
 *   · resolved value (pretty-printed)
 *   · structured error (showing error.reason when present)
 *   · notices strip (e.g. "ran `keychain` shimmed")
 *   · Mermaid DAG built from result.trace via traceToMermaid
 *
 * Streaming note: CodeRunner.run() is single-shot — it resolves once with a
 * fully assembled RunResult. The `isStreaming` flag (derived from trace entries
 * with `.stream`) marks results that *contained* chunked/SSE/LLM data, rendered
 * with a visual hint below. True incremental UI streaming (chunk-by-chunk display
 * as the response arrives) requires a contract extension (e.g. an async iterable
 * on CodeRunner or RunResult). The frozen CodeRunner contract does not provide
 * this. See the U1 implementation report — flagged for the contract owner (D1/R1).
 */
function StitchOutput({
    result,
    deferred,
}: {
    result: RunResult | null;
    deferred: boolean;
}) {
    if (deferred) {
        return (
            <div className="stitch-playground__output stitch-playground__output--deferred">
                ⏳ Execution engine not wired up yet. This shell is running
                against the mock or deferred runner — see{' '}
                <code>docs/playground/REQUIREMENTS.md</code>.
            </div>
        );
    }
    if (!result)
        return (
            <div className="stitch-playground__output">
                Run a snippet to see output.
            </div>
        );

    const view = buildRunView(result);

    return (
        <div className="stitch-playground__output">
            {/* ── Logs ─────────────────────────────────────────────────── */}
            {view.logs.map((line, i) => (
                <div
                    key={i}
                    data-level={result.logs[i]?.level}
                    className="stitch-playground__log"
                >
                    {line}
                </div>
            ))}

            {/* ── Error ────────────────────────────────────────────────── */}
            {view.errorText !== null && (
                <pre className="stitch-playground__error">
                    {view.errorText}
                </pre>
            )}

            {/* ── Resolved value ───────────────────────────────────────── */}
            {view.errorText === null && view.valueText !== null && (
                <pre className="stitch-playground__value">
                    {view.valueText}
                </pre>
            )}

            {/* ── Notices strip ────────────────────────────────────────── */}
            {view.notices.length > 0 && (
                <div className="stitch-playground__notices" role="note">
                    {view.notices.map((n, i) => (
                        <div key={i} className="stitch-playground__notice">
                            ⚠ {n}
                        </div>
                    ))}
                </div>
            )}

            {/* ── Mermaid DAG ──────────────────────────────────────────── */}
            {result.trace && result.trace.length > 0 && (
                <div className="stitch-playground__dag">
                    {/* Streaming badge: shown when the trace contains a stream entry.
                        NOTE: This marks a result that *included* streaming data — it
                        does NOT mean the panel updated incrementally as chunks arrived.
                        Incremental rendering needs a streaming contract extension. */}
                    {view.isStreaming && (
                        <span className="stitch-playground__dag-streaming-badge">
                            streaming
                        </span>
                    )}
                    {/* The Mermaid flowchart is rendered by the docs framework's
                        <Mermaid> component (Fumadocs / MDX). We emit the raw graph
                        string into a <pre data-mermaid> block; the framework's script
                        picks it up and renders the SVG DAG. */}
                    <pre
                        className="stitch-playground__mermaid"
                        data-mermaid="true"
                    >
                        {view.mermaid}
                    </pre>
                </div>
            )}
        </div>
    );
}

export default StitchPlayground;

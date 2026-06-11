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
import { type CodeRunner, type RunEvent, type RunResult, mockRunner } from './runner';
import { applyEvent, buildRunView, emptyRunView, type RunView } from './output-format';

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
    // Incremental view state — updated as RunEvents arrive via onEvent.
    // null = no run started yet; non-null = a run is in progress or complete.
    const [view, setView] = useState<RunView | null>(null);
    const [running, setRunning] = useState(false);
    const abortRef = useRef<AbortController | null>(null);

    const isDeferred = runner.id === 'deferred';

    const run = useCallback(async () => {
        abortRef.current?.abort();
        const ac = new AbortController();
        abortRef.current = ac;
        setRunning(true);
        // Reset incremental view to empty so the output panel shows a fresh slate.
        setView(emptyRunView());
        setResult(null);
        try {
            // RUNNER INTEGRATION POINT — incremental rendering is active when the
            // runner emits onEvent (Wave 4+). Each event is folded into React state
            // via applyEvent so the output panel updates immediately as logs, chunks,
            // traces, and notices arrive. On resolve, the final RunResult is reconciled
            // via buildRunView so value/error/durationMs always reflect the authoritative
            // final state. Runners that never call onEvent (e.g. mockRunner) fall back
            // to showing the final result only, with no intermediate updates.
            const onEvent = (event: RunEvent) => {
                if (ac.signal.aborted) return;
                setView((prev) => applyEvent(prev ?? emptyRunView(), event));
            };
            const res = await runner.run({ code, scope, signal: ac.signal, onEvent });
            if (!ac.signal.aborted) {
                // Reconcile: final result wins for value/error/durationMs/logs/notices.
                setResult(res);
                setView(buildRunView(res));
            }
        } finally {
            if (!ac.signal.aborted) setRunning(false);
        }
    }, [code, runner, scope]);

    const stop = useCallback(() => abortRef.current?.abort(), []);

    const status = useMemo(() => {
        if (isDeferred) return 'engine deferred';
        if (running) return 'running…';
        if (result?.error) return `error · ${result.error.phase}`;
        if (result) return `done · ${result.durationMs}ms`;
        return 'ready';
    }, [isDeferred, running, result]);

    // Reset view and result together when resetting the editor.
    const reset = useCallback(() => {
        setCode(initialCode);
        setResult(null);
        setView(null);
    }, [initialCode]);

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

            <StitchOutput view={view} result={result} deferred={isDeferred} running={running} />
        </div>
    );
}

/**
 * Output panel — renders incrementally as RunEvents arrive via onEvent, and
 * reconciles with the final RunResult on resolve.
 *
 * Rendering strategy:
 *   · During a run: `view` is updated by `applyEvent` for every RunEvent the runner
 *     emits, so logs, streamed chunks, trace DAG, and notices appear immediately.
 *   · After a run: `view` is replaced by `buildRunView(result)` so value/error/
 *     durationMs always reflect the authoritative final state.
 *   · Runners that do not emit onEvent (e.g. mockRunner, DeferredRunner) never call
 *     the callback; the panel simply shows the final result after run() resolves.
 *
 * The `result` prop is still accepted for the `data-level` log attribute lookup
 * (log level is not part of RunView's flat string array, only the formatted text).
 * During streaming it is null; the level attr is omitted until final reconcile.
 */
function StitchOutput({
    view,
    result,
    deferred,
    running,
}: {
    view: RunView | null;
    result: RunResult | null;
    deferred: boolean;
    running: boolean;
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
    if (!view && !running)
        return (
            <div className="stitch-playground__output">
                Run a snippet to see output.
            </div>
        );
    if (!view)
        return (
            <div className="stitch-playground__output">
                running…
            </div>
        );

    return (
        <div className="stitch-playground__output">
            {/* ── Logs ─────────────────────────────────────────────────── */}
            {view.logs.map((line, i) => (
                <div
                    key={i}
                    data-level={result?.logs[i]?.level}
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

            {/* ── Resolved value / streamed text ───────────────────────── */}
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
            {/* Show the DAG as soon as any trace event has been folded in. */}
            {view.mermaid && !view.mermaid.includes('_empty') && (
                <div className="stitch-playground__dag">
                    {/* Streaming badge: shown when any chunk event arrived or any
                        trace entry carries `.stream`. Active during and after the run. */}
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

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
import type { SimKnobs } from '../contracts/sim';
import {
    type RunView,
    applyEvent,
    buildRunView,
    emptyRunView,
} from './output-format';
import {
    type CodeRunner,
    type RunEvent,
    type RunResult,
    mockRunner,
} from './runner';

import {
    type ReactNode,
    useCallback,
    useEffect,
    useId,
    useRef,
    useState,
} from 'react';

/**
 * Props passed to a custom editor (the EDITOR INTEGRATION POINT). A renderer
 * keeps the controlled `value`/`onChange` contract; the rest is layout.
 */
export interface EditorRenderProps {
    value: string;
    onChange: (next: string) => void;
    readOnly: boolean;
    height: number;
}

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
    /**
     * Optional content for the start of the toolbar (e.g. the docs example
     * switcher tabs). When present it replaces the standalone status label there,
     * and the run status moves next to the Run/Reset actions.
     */
    tabs?: ReactNode;
    /**
     * Baseline simulator knobs applied to every request a run makes — the
     * "Response knobs" panel. Forwarded to `runner.run` as `RunRequest.knobs`;
     * an explicit `?__…` in the snippet still wins. Absent → unmodified responses.
     */
    knobs?: SimKnobs;
    /** Editor height in px. */
    height?: number;
    /** Read-only display (docs example you can't edit). */
    readOnly?: boolean;
    /**
     * Custom editor (e.g. a CodeMirror integration). Receives the controlled
     * `value`/`onChange` plus `readOnly`/`height`. Defaults to a plain
     * <textarea> so the shell stays dependency-free.
     */
    renderEditor?: (props: EditorRenderProps) => ReactNode;
    /**
     * Custom renderer for a single console log line (e.g. highlight JSON output).
     * Receives the formatted line + its level. Defaults to the raw text.
     */
    renderLog?: (text: string, level: string) => ReactNode;
    /**
     * Custom renderer for the WHOLE log stream as one block (e.g. a readonly
     * code editor with line numbers). Receives each formatted line plus the
     * level of the entry it belongs to. Takes precedence over {@link renderLog}
     * for the logs section; the error block, notices strip, and trace DAG stay
     * as their own styled blocks beneath it. Absent → per-line {@link renderLog}.
     */
    renderLogs?: (entries: { text: string; level: string }[]) => ReactNode;
    /**
     * Optional panel rendered in the bottom-right slot, beside the editor and
     * below the console (e.g. the docs "Server knobs"). When provided, the body
     * becomes a three-pane grid; when omitted, the console spans the full right
     * column. Titled by {@link asideLabel}.
     */
    aside?: ReactNode;
    /** Title bar text for the {@link aside} pane. */
    asideLabel?: string;
}

const DEFAULT_SNIPPET = `// Edit and run. Output appears below.
const user = await stitch('https://reqres.in/api/users/2');
console.log(user);
`;

/* Inline icons keep this shell dependency-light (no icon package). Sized in CSS
   via `.stitch-playground__actions svg`. */
function PlayIcon() {
    return (
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M8 5v14l11-7z" />
        </svg>
    );
}
function StopIcon() {
    return (
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" rx="1.5" />
        </svg>
    );
}
function ResetIcon() {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <polyline points="1 4 1 10 7 10" />
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
        </svg>
    );
}

export function StitchPlayground({
    initialCode = DEFAULT_SNIPPET,
    runner = mockRunner,
    scope,
    knobs,
    tabs,
    height = 220,
    readOnly = false,
    renderEditor,
    renderLog,
    renderLogs,
    aside,
    asideLabel = 'Server knobs',
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
            const res = await runner.run({
                code,
                scope,
                knobs,
                signal: ac.signal,
                onEvent,
            });
            if (!ac.signal.aborted) {
                // Reconcile: final result wins for value/error/durationMs/logs/notices.
                setResult(res);
                setView(buildRunView(res));
            }
        } finally {
            // Only the *current* run owns the button state. Keying off
            // `abortRef.current === ac` (not `ac.signal.aborted`) distinguishes
            // the two ways this run can end aborted: an explicit Stop leaves
            // `abortRef.current` pointing at `ac`, so we flip `running` off and
            // return the button to "Run" / re-enable Reset; a *superseding* run
            // has already replaced `abortRef.current` with its own controller
            // and set `running` true again, so we must leave it alone.
            if (abortRef.current === ac) {
                abortRef.current = null;
                setRunning(false);
            }
        }
    }, [code, runner, scope, knobs]);

    const stop = useCallback(() => abortRef.current?.abort(), []);

    // Reset view and result together when resetting the editor.
    const reset = useCallback(() => {
        setCode(initialCode);
        setResult(null);
        setView(null);
    }, [initialCode]);

    return (
        <div className="stitch-playground" data-runner={runner.id}>
            <div className="stitch-playground__toolbar">
                {/* Tabs (e.g. the docs example switcher) sit at the start of the
                    toolbar; the run controls sit at the end. */}
                {tabs && (
                    <div className="stitch-playground__toolbar-start">
                        {tabs}
                    </div>
                )}
                <div className="stitch-playground__actions">
                    {running ? (
                        <button
                            type="button"
                            onClick={stop}
                            className="stitch-playground__btn stitch-playground__btn--run"
                        >
                            <StopIcon />
                            Stop
                        </button>
                    ) : (
                        <button
                            type="button"
                            onClick={run}
                            disabled={isDeferred}
                            className="stitch-playground__btn stitch-playground__btn--run"
                        >
                            <PlayIcon />
                            Run
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={reset}
                        disabled={running}
                        className="stitch-playground__btn stitch-playground__btn--reset"
                    >
                        <ResetIcon />
                        Reset
                    </button>
                </div>
            </div>

            {/* Pane layout: Code (left, full height) · Console (right). When an
                `aside` is supplied (the docs "Server knobs"), it takes the
                bottom-right slot and the console shrinks to the top-right.
                Stacks to one column on narrow viewports — see playground.css. */}
            <div
                className="stitch-playground__body"
                data-has-aside={aside ? 'true' : undefined}
            >
                <section
                    className="stitch-playground__pane stitch-playground__pane--editor"
                    aria-label="Code"
                >
                    <div className="stitch-playground__pane-head">Code</div>
                    {/* EDITOR INTEGRATION POINT — `renderEditor` swaps in a real
                        editor (e.g. CodeMirror 6) while keeping the `code`/`setCode`
                        controlled contract; the default is a dependency-free
                        <textarea>. */}
                    {renderEditor ? (
                        renderEditor({
                            value: code,
                            onChange: setCode,
                            readOnly,
                            height,
                        })
                    ) : (
                        <textarea
                            className="stitch-playground__editor"
                            style={{
                                height,
                                width: '100%',
                                fontFamily: 'monospace',
                            }}
                            value={code}
                            spellCheck={false}
                            readOnly={readOnly}
                            onChange={(e) => setCode(e.target.value)}
                            aria-label="StitchAPI playground editor"
                        />
                    )}
                </section>

                <StitchOutput
                    view={view}
                    result={result}
                    deferred={isDeferred}
                    running={running}
                    renderLog={renderLog}
                    renderLogs={renderLogs}
                />

                {/* The aside owns its full chrome (header bar + body), so it can
                    fold actions like "Clear" into its own header. */}
                {aside && (
                    <section
                        className="stitch-playground__pane stitch-playground__pane--aside"
                        aria-label={asideLabel}
                    >
                        {aside}
                    </section>
                )}
            </div>
        </div>
    );
}

/**
 * Console pane — the log stream plus errors, shim notices, and the trace DAG.
 * It does NOT render the snippet's return value: the playground is logs-first
 * (snippets `console.log` what they want to show), so a returned value is not
 * surfaced. Renders incrementally as RunEvents arrive via onEvent and reconciles
 * with the final RunResult on resolve.
 *
 * Rendering strategy:
 *   · During a run: `view` is updated by `applyEvent` for every RunEvent the runner
 *     emits, so logs, streamed chunks, trace DAG, and notices appear immediately.
 *   · After a run: `view` is replaced by `buildRunView(result)` so error/durationMs
 *     always reflect the authoritative final state.
 *   · Runners that do not emit onEvent (e.g. mockRunner, DeferredRunner) never call
 *     the callback; the pane simply shows the final result after run() resolves.
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
    renderLog,
    renderLogs,
}: {
    view: RunView | null;
    result: RunResult | null;
    deferred: boolean;
    running: boolean;
    renderLog?: (text: string, level: string) => ReactNode;
    renderLogs?: (entries: { text: string; level: string }[]) => ReactNode;
}) {
    let body: ReactNode;
    if (deferred) {
        body = (
            <div className="stitch-playground__output stitch-playground__output--deferred">
                ⏳ Execution engine not wired up yet. This shell is running
                against the mock or deferred runner — see{' '}
                <code>docs/playground/REQUIREMENTS.md</code>.
            </div>
        );
    } else if (!view && !running) {
        body = (
            <div className="stitch-playground__output stitch-playground__output--placeholder">
                Run a snippet to see console output.
            </div>
        );
    } else if (!view) {
        body = (
            <div className="stitch-playground__output stitch-playground__output--placeholder">
                running…
            </div>
        );
    } else {
        // When `renderLogs` is supplied the whole log stream renders as one block
        // (e.g. a readonly editor with line numbers); the error / notices / DAG
        // then sit in their own scrollable strip beneath it. Otherwise the logs
        // render per-line and everything flows in one scroll surface.
        const useEditor = !!renderLogs && view.logs.length > 0;

        const logsBlock = useEditor ? (
            <div className="stitch-playground__logs-editor">
                {renderLogs(
                    view.logs.map((text, i) => ({
                        text,
                        level: result?.logs[i]?.level ?? 'log',
                    })),
                )}
            </div>
        ) : (
            view.logs.map((line, i) => {
                const level = result?.logs[i]?.level ?? 'log';
                return (
                    <div
                        key={i}
                        data-level={result?.logs[i]?.level}
                        className="stitch-playground__log"
                    >
                        {renderLog ? renderLog(line, level) : line}
                    </div>
                );
            })
        );

        const hasDag = !!view.mermaid && !view.mermaid.includes('_empty');
        const hasExtras =
            view.errorText !== null || view.notices.length > 0 || hasDag;

        const extras = (
            <>
                {/* ── Error ──────────────────────────────────────────── */}
                {view.errorText !== null && (
                    <pre className="stitch-playground__error">
                        {view.errorText}
                    </pre>
                )}

                {/* ── Notices strip ──────────────────────────────────── */}
                {view.notices.length > 0 && (
                    <div className="stitch-playground__notices" role="note">
                        {view.notices.map((n, i) => (
                            <div key={i} className="stitch-playground__notice">
                                ⚠ {n}
                            </div>
                        ))}
                    </div>
                )}

                {/* ── Mermaid DAG ────────────────────────────────────── */}
                {/* Show the DAG as soon as any trace event has been folded in. */}
                {hasDag && (
                    <div className="stitch-playground__dag">
                        {/* Streaming badge: shown when any chunk event arrived or any
                            trace entry carries `.stream`. Active during and after the run. */}
                        {view.isStreaming && (
                            <span className="stitch-playground__dag-streaming-badge">
                                streaming
                            </span>
                        )}
                        {/* The Mermaid flowchart is rendered to an inline SVG on the
                            client by <MermaidDiagram> (mermaid is loaded lazily inside
                            its effect so nothing touches `document` during SSR). On a
                            parse/render failure it falls back to the raw graph string. */}
                        <MermaidDiagram chart={view.mermaid} />
                    </div>
                )}
            </>
        );

        body = (
            <div
                className={
                    'stitch-playground__output' +
                    (useEditor ? ' stitch-playground__output--editor' : '')
                }
            >
                {logsBlock}
                {/* In editor mode the extras get their own scrollable strip so the
                    log editor keeps the bulk of the pane; otherwise they flow inline. */}
                {hasExtras &&
                    (useEditor ? (
                        <div className="stitch-playground__output-extras">
                            {extras}
                        </div>
                    ) : (
                        extras
                    ))}
            </div>
        );
    }

    return (
        <section
            className="stitch-playground__pane stitch-playground__pane--console"
            aria-label="Console"
        >
            <div className="stitch-playground__pane-head">Console</div>
            {body}
        </section>
    );
}

/**
 * Renders a Mermaid `flowchart TD` string to an inline SVG, entirely on the
 * client. `mermaid` reaches for `document`/`window`, so it is NEVER imported at
 * module scope — it is loaded lazily with `await import('mermaid')` *inside* the
 * effect, which only runs in the browser. That keeps the component SSR-safe (the
 * server render emits the empty container) and keeps mermaid out of the initial
 * bundle until a DAG actually needs drawing.
 *
 * Robustness contract:
 *   · Each render gets a DOM-id-safe, unique `renderId` (a stripped `useId()`
 *     plus a per-render counter) so mermaid's injected temp element never
 *     collides across re-renders.
 *   · A `cancelled` flag guards the async result so an unmounted / superseded
 *     effect can't write a stale SVG into the live container.
 *   · On any failure we `console.warn`, best-effort remove mermaid's orphaned
 *     temp node, and fall back to the raw graph string in a styled
 *     `.stitch-playground__mermaid` <pre> written INTO the same container — so
 *     the DAG panel can never break a run's output, and a later valid graph
 *     recovers (the container stays mounted, so the effect's ref is stable).
 */
function MermaidDiagram({ chart }: { chart: string }) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    // useId() is stable across renders and unique per instance, but contains
    // characters (':') that aren't valid in a DOM id — strip them. The counter
    // makes each successive render's id unique so mermaid's temp element never
    // collides with a previous (possibly still-unwinding) render.
    const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
    const renderCount = useRef(0);

    useEffect(() => {
        let cancelled = false;
        const el = containerRef.current;
        if (!el) return;

        const n = (renderCount.current += 1);
        const renderId = `mmd-${uid}-${n}`;

        // Drop to the raw graph string in a styled <pre>, IN PLACE — the
        // container stays mounted, so a subsequent valid `chart` re-runs the
        // effect and overwrites this with the SVG (a transient parse failure is
        // not sticky). `textContent` keeps the untrusted graph string inert.
        const showFallback = () => {
            const pre = document.createElement('pre');
            pre.className = 'stitch-playground__mermaid';
            pre.textContent = chart;
            el.replaceChildren(pre);
        };

        (async () => {
            // Lazy, browser-only import — keeps mermaid out of SSR and the
            // initial bundle.
            const mermaid = (await import('mermaid')).default;
            try {
                const isDark =
                    typeof document !== 'undefined' &&
                    document.documentElement.classList.contains('dark');
                mermaid.initialize({
                    startOnLoad: false,
                    theme: isDark ? 'dark' : 'default',
                    securityLevel: 'strict',
                });
                const { svg, bindFunctions } = await mermaid.render(
                    renderId,
                    chart,
                );
                // Bail if the effect was torn down / superseded while awaiting.
                if (cancelled || containerRef.current !== el) return;
                el.innerHTML = svg;
                bindFunctions?.(el);
            } catch (err) {
                console.warn('[StitchPlayground] mermaid render failed', err);
                // mermaid can leave an orphan temp node carrying the render id
                // when it throws mid-render — best-effort cleanup.
                document.getElementById(renderId)?.remove();
                if (cancelled || containerRef.current !== el) return;
                showFallback();
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [chart, uid]);

    // The container is ALWAYS mounted so the effect's ref stays stable across
    // re-renders; mermaid writes the SVG (or the fallback <pre>) into it.
    return (
        <div
            ref={containerRef}
            className="stitch-playground__mermaid-svg"
            role="img"
            aria-label="Call graph of the run"
        />
    );
}

export default StitchPlayground;

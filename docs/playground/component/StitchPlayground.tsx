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

import { useCallback, useMemo, useRef, useState } from 'react';

export interface StitchPlaygroundProps {
    /** Initial editor contents. */
    initialCode?: string;
    /**
     * The execution engine. Defaults to the mock so the shell is usable before
     * the in-house engine exists. Wire the real `CodeRunner` here later.
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
 * Output panel. Today: logs + value + error. Future (with the real engine): a
 * response card, retry/throttle/drift annotations, and a Mermaid DAG rendered
 * from `result.trace` — this is where the in-house engine earns its keep over a
 * generic playground's console pane (see ../RATIONALE.md).
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

    return (
        <div className="stitch-playground__output">
            {result.logs.map((l, i) => (
                <div
                    key={i}
                    data-level={l.level}
                    className="stitch-playground__log"
                >
                    {l.args
                        .map((a) =>
                            typeof a === 'string' ? a : JSON.stringify(a),
                        )
                        .join(' ')}
                </div>
            ))}
            {result.error ? (
                <pre className="stitch-playground__error">
                    {result.error.name}: {result.error.message}
                </pre>
            ) : result.value !== undefined ? (
                <pre className="stitch-playground__value">
                    {typeof result.value === 'string'
                        ? result.value
                        : JSON.stringify(result.value, null, 2)}
                </pre>
            ) : null}
            {/* TODO(engine): render result.trace as a Mermaid build-stitch DAG. */}
        </div>
    );
}

export default StitchPlayground;

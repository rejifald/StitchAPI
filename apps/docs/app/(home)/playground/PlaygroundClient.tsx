'use client';

import { CodeEditor } from './CodeEditor';
import { PLAYGROUND_EXAMPLES } from './playground-examples';

import { StitchPlayground } from '@stitchapi/sandbox/component/StitchPlayground';
import { dispatchRunner } from '@stitchapi/sandbox/contracts/dispatch';
import {
    type WorkerLike,
    makeBrowserWorkerRunner,
} from '@stitchapi/sandbox/runtime/browser-runner';
import { DynamicCodeBlock } from 'fumadocs-ui/components/dynamic-codeblock';
import { useMemo, useState } from 'react';

/** Same-origin module Worker emitted by `build:sandbox` into /public/sandbox. */
const WORKER_URL = '/sandbox/sandbox-worker.mjs';

/** True when a formatted log line is a pretty-printed object/array, so it can be
 *  highlighted as JSON; prose logs stay plain text. */
function jsonLog(text: string): boolean {
    const t = text.trim();
    if (t[0] !== '{' && t[0] !== '[') return false;
    try {
        JSON.parse(t);
        return true;
    } catch {
        return false;
    }
}

/**
 * Client wrapper that wires the in-house sandbox engine into the UI shell, plus
 * a CodeMirror editor (`renderEditor`) and a Fumadocs `DynamicCodeBlock` for the
 * highlighted result (`renderValue`). The heavy lifting lives in the engine;
 * the shell only knows the `CodeRunner` contract + the two render hooks.
 */
export function PlaygroundClient() {
    // Build the runner once, on the client. A fresh Worker per run is what gives
    // SEC-36/37 (no cross-run global bleed) for free. A real DOM Worker
    // structurally satisfies WorkerLike — the cast only bridges the DOM's
    // stricter MessageEvent typing.
    const runner = useMemo(
        () =>
            dispatchRunner({
                browser: makeBrowserWorkerRunner({
                    workerFactory: () =>
                        new Worker(WORKER_URL, {
                            type: 'module',
                        }) as unknown as WorkerLike,
                }),
            }),
        [],
    );

    // Defaults to the first preset (the complete tour). Switching presets
    // remounts <StitchPlayground> via `key` so its editor re-seeds from the
    // chosen `initialCode`; the runner above is stable across the remount.
    const [exampleId, setExampleId] = useState(PLAYGROUND_EXAMPLES[0].id);
    const active =
        PLAYGROUND_EXAMPLES.find((e) => e.id === exampleId) ??
        PLAYGROUND_EXAMPLES[0];

    return (
        <>
            <div
                className="stitch-playground-examples"
                role="tablist"
                aria-label="Example complexity"
            >
                {PLAYGROUND_EXAMPLES.map((ex) => (
                    <button
                        key={ex.id}
                        type="button"
                        role="tab"
                        aria-selected={ex.id === exampleId}
                        data-active={ex.id === exampleId}
                        className="stitch-playground-examples__tab"
                        title={ex.description}
                        onClick={() => setExampleId(ex.id)}
                    >
                        {ex.label}
                    </button>
                ))}
                <span className="stitch-playground-examples__hint">
                    {active.description}
                </span>
            </div>

            <StitchPlayground
                key={active.id}
                initialCode={active.code}
                runner={runner}
                renderEditor={(props) => <CodeEditor {...props} />}
                renderValue={(text) => (
                    <div className="stitch-playground__result">
                        <span className="stitch-playground__result-label">
                            returned
                        </span>
                        <DynamicCodeBlock lang="json" code={text} />
                    </div>
                )}
                renderLog={(text) =>
                    jsonLog(text) ? (
                        <DynamicCodeBlock lang="json" code={text} />
                    ) : (
                        text
                    )
                }
            />
        </>
    );
}

export default PlaygroundClient;

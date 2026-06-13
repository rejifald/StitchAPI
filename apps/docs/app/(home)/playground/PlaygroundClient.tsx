'use client';

import { CodeEditor } from './CodeEditor';

import { StitchPlayground } from '@stitchapi/sandbox/component/StitchPlayground';
import { dispatchRunner } from '@stitchapi/sandbox/contracts/dispatch';
import {
    type WorkerLike,
    makeBrowserWorkerRunner,
} from '@stitchapi/sandbox/runtime/browser-runner';
import { DynamicCodeBlock } from 'fumadocs-ui/components/dynamic-codeblock';
import { useMemo } from 'react';

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
export function PlaygroundClient({ initialCode }: { initialCode?: string }) {
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

    return (
        <StitchPlayground
            initialCode={initialCode}
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
    );
}

export default PlaygroundClient;

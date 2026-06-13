'use client';

import {
    instanceCompletionSource,
    playgroundCompletionSource,
} from './playground-completions';

import { autocompletion } from '@codemirror/autocomplete';
import {
    javascript,
    localCompletionSource,
    scopeCompletionSource,
} from '@codemirror/lang-javascript';
import type { EditorRenderProps } from '@stitchapi/sandbox/component/StitchPlayground';
import CodeMirror from '@uiw/react-codemirror';
import { useEffect, useMemo, useState } from 'react';
import { stitch } from 'stitchapi';

/** Track the docs theme — Fumadocs toggles a `dark` class on <html>. */
function useIsDark(): boolean {
    const [dark, setDark] = useState(false);
    useEffect(() => {
        const el = document.documentElement;
        const update = () => setDark(el.classList.contains('dark'));
        update();
        const obs = new MutationObserver(update);
        obs.observe(el, { attributes: true, attributeFilter: ['class'] });
        return () => obs.disconnect();
    }, []);
    return dark;
}

/**
 * Globals available inside every playground snippet.
 * scopeCompletionSource walks these keys to offer completions as the user types.
 */
const PLAYGROUND_SCOPE = {
    stitch,
    console,
    JSON,
    Math,
    fetch,
    Promise,
    Array,
    Object,
    Error,
    setTimeout,
    clearTimeout,
};

/**
 * CodeMirror 6 editor for the playground — TS/JSX highlighting, line numbers,
 * theme synced to the docs light/dark mode. Implements the StitchPlayground
 * `renderEditor` contract (controlled `value`/`onChange`).
 */
export function CodeEditor({
    value,
    onChange,
    readOnly,
    height,
}: EditorRenderProps) {
    const dark = useIsDark();

    const extensions = useMemo(
        () => [
            javascript({ typescript: true, jsx: true }),
            autocompletion({
                // localCompletionSource: identifiers already in the editor
                // scopeCompletionSource: stitch + JS globals the snippet can reach
                override: [
                    localCompletionSource,
                    scopeCompletionSource(PLAYGROUND_SCOPE),
                    playgroundCompletionSource,
                    instanceCompletionSource,
                ],
                activateOnTyping: true,
            }),
        ],
        [],
    );

    return (
        <CodeMirror
            className="stitch-playground__cm"
            value={value}
            height={`${height}px`}
            theme={dark ? 'dark' : 'light'}
            editable={!readOnly}
            readOnly={readOnly}
            extensions={extensions}
            basicSetup={{
                lineNumbers: true,
                foldGutter: false,
                highlightActiveLine: !readOnly,
                autocompletion: false,
            }}
            onChange={onChange}
        />
    );
}

export default CodeEditor;

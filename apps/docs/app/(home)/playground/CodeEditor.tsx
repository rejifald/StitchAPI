'use client';

import { javascript } from '@codemirror/lang-javascript';
import type { EditorRenderProps } from '@stitchapi/sandbox/component/StitchPlayground';
import CodeMirror from '@uiw/react-codemirror';
import { useEffect, useState } from 'react';

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
    return (
        <CodeMirror
            className="stitch-playground__cm"
            value={value}
            height={`${height}px`}
            theme={dark ? 'dark' : 'light'}
            editable={!readOnly}
            readOnly={readOnly}
            extensions={[javascript({ typescript: true, jsx: true })]}
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

'use client';

import { signalConsoleTheme } from './codemirror-theme';

import { javascript } from '@codemirror/lang-javascript';
import CodeMirror, {
    Decoration,
    EditorState,
    EditorView,
    RangeSetBuilder,
    type ReactCodeMirrorRef,
    StateField,
    lineNumbers,
} from '@uiw/react-codemirror';
import { useEffect, useMemo, useRef } from 'react';

/** One formatted console line plus the level of the entry it belongs to. */
export interface ConsoleLine {
    text: string;
    level: string;
}

/* Cached per-level line decorations — a multi-line entry shares one object for
   every line it spans. `log` (and unknown levels) are left to the highlighter. */
const LINE_DECO: Record<string, Decoration> = {
    info: Decoration.line({ class: 'cm-log-line cm-log-info' }),
    warn: Decoration.line({ class: 'cm-log-line cm-log-warn' }),
    error: Decoration.line({ class: 'cm-log-line cm-log-error' }),
    debug: Decoration.line({ class: 'cm-log-line cm-log-debug' }),
};

/**
 * A StateField that paints each document line with its log level's color, so the
 * per-level colors of the structured console survive in the editor view.
 * `levelsPerLine` is indexed by document line (0-based). Decorations are rebuilt
 * on every doc change so they track a growing/streamed log buffer; the field is
 * re-created (fresh closure) whenever the levels change — see the useMemo below.
 */
function lineLevelField(levelsPerLine: string[]) {
    const build = (state: EditorState) => {
        const builder = new RangeSetBuilder<Decoration>();
        const n = Math.min(state.doc.lines, levelsPerLine.length);
        for (let i = 0; i < n; i++) {
            const deco = LINE_DECO[levelsPerLine[i]];
            if (deco) {
                const from = state.doc.line(i + 1).from;
                builder.add(from, from, deco);
            }
        }
        return builder.finish();
    };
    return StateField.define({
        create: build,
        update: (deco, tr) =>
            tr.docChanged ? build(tr.state) : deco.map(tr.changes),
        provide: (f) => EditorView.decorations.from(f),
    });
}

/**
 * Readonly CodeMirror rendering the console log stream with per-entry line
 * numbers and a conservative JSON-friendly highlight (see {@link
 * signalConsoleTheme}). Per-line info/warn/error/debug colors are applied via
 * {@link lineLevelField}. Errors, notices, and the trace DAG are rendered by the
 * shell beneath this editor.
 */
export function ConsoleEditor({ lines }: { lines: ConsoleLine[] }) {
    const value = useMemo(() => lines.map((l) => l.text).join('\n'), [lines]);

    // Expand entry-levels to DOC-line levels: a multi-line entry (e.g. a
    // pretty-printed object) paints every one of its lines with the entry level.
    const levelsPerLine = useMemo(() => {
        const out: string[] = [];
        for (const l of lines) {
            const count = l.text.split('\n').length;
            for (let i = 0; i < count; i++) out.push(l.level);
        }
        return out;
    }, [lines]);

    // Per-entry gutter labels: number each log ENTRY (one console.* call), not
    // each physical row. A multi-line entry (e.g. a pretty-printed object) shows
    // its number on the first row and a blank gutter on its continuation rows, so
    // an object reads as one entry instead of inflating the line count.
    const gutterLabels = useMemo(() => {
        const labels: string[] = [];
        let entryNo = 0;
        for (const l of lines) {
            const rows = l.text.split('\n').length;
            entryNo += 1;
            labels.push(String(entryNo));
            for (let i = 1; i < rows; i++) labels.push('');
        }
        return labels;
    }, [lines]);

    // Auto-scroll: keep the newest line in view as output arrives, but only while
    // the viewer is already near the bottom — a manual scroll up to read earlier
    // output is not yanked back down on the next log line.
    const editorRef = useRef<ReactCodeMirrorRef>(null);
    const stickToBottom = useRef(true);
    // Set true around our own pin so the resulting scroll event doesn't get
    // mistaken for the user scrolling away (which would wrongly un-stick).
    const selfScroll = useRef(false);

    const extensions = useMemo(
        () => [
            javascript({ typescript: true }),
            EditorView.lineWrapping,
            lineNumbers({
                formatNumber: (lineNo) => gutterLabels[lineNo - 1] ?? '',
            }),
            lineLevelField(levelsPerLine),
        ],
        [levelsPerLine, gutterLabels],
    );

    // Re-evaluate "parked at the bottom" only on USER scrolls, so auto-scroll
    // pauses when they scroll up to read earlier output and resumes when they
    // return to the bottom.
    useEffect(() => {
        const view = editorRef.current?.view;
        if (!view) return;
        const sd = view.scrollDOM;
        const onScroll = () => {
            if (selfScroll.current) {
                selfScroll.current = false;
                return;
            }
            stickToBottom.current =
                sd.scrollHeight - sd.scrollTop - sd.clientHeight < 32;
        };
        sd.addEventListener('scroll', onScroll, { passive: true });
        return () => sd.removeEventListener('scroll', onScroll);
    }, []);

    // After the doc grows, pin to the newest line when stuck to bottom. The rAF
    // lets CodeMirror measure the new content height before we scroll.
    useEffect(() => {
        if (!stickToBottom.current || value.length === 0) return;
        const view = editorRef.current?.view;
        if (!view) return;
        const raf = requestAnimationFrame(() => {
            const sd = view.scrollDOM;
            selfScroll.current = true;
            sd.scrollTop = sd.scrollHeight;
        });
        return () => cancelAnimationFrame(raf);
    }, [value]);

    return (
        <CodeMirror
            ref={editorRef}
            className="stitch-console-editor"
            value={value}
            theme={signalConsoleTheme}
            editable={false}
            readOnly
            extensions={extensions}
            basicSetup={{
                // Our own per-entry gutter is added via `extensions` above.
                lineNumbers: false,
                foldGutter: false,
                highlightActiveLine: false,
                highlightActiveLineGutter: false,
                autocompletion: false,
                // The buffer is mixed prose + JSON, not a program — the default
                // highlight would grey out `//` URLs and flag prose as invalid.
                // We supply our own conservative highlight via `theme` instead.
                syntaxHighlighting: false,
                searchKeymap: false,
                highlightSelectionMatches: false,
            }}
        />
    );
}

export default ConsoleEditor;

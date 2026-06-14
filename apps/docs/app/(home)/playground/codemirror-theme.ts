/**
 * Signal-aligned CodeMirror 6 theme for the playground editor.
 *
 * Every color is a CSS custom property from the design-token layer
 * (tokens.css / global.css), so the editor tracks light/dark on its own —
 * no `dark` branch needed — and its syntax colors match the static `.tok-*`
 * code panels (keyword → brand, function/type → accent, comment → faint…).
 */
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { EditorView } from '@uiw/react-codemirror';

/* Editor chrome: surface, gutters, cursor, selection, tooltips. */
const editorChrome = EditorView.theme({
    '&': {
        color: 'var(--color-fd-foreground)',
        backgroundColor: 'var(--color-fd-background)',
    },
    '.cm-content': {
        caretColor: 'var(--brand)',
        fontFamily: 'var(--font-mono)',
    },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--brand)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
        { backgroundColor: 'var(--brand-soft)' },
    '.cm-activeLine': {
        backgroundColor: 'color-mix(in srgb, var(--brand) 6%, transparent)',
    },
    '.cm-gutters': {
        backgroundColor: 'var(--color-fd-background)',
        color: 'var(--text-faint)',
        border: 'none',
    },
    '.cm-activeLineGutter': {
        backgroundColor: 'transparent',
        color: 'var(--text-muted)',
    },
    '.cm-tooltip': {
        backgroundColor: 'var(--color-fd-popover)',
        border: '1px solid var(--color-fd-border)',
        color: 'var(--color-fd-foreground)',
    },
    '.cm-tooltip-autocomplete ul li[aria-selected]': {
        backgroundColor: 'var(--brand)',
        color: 'var(--brand-ink)',
    },
});

/* Syntax: maps lezer highlight tags onto the Signal `--syn-*` tokens. */
const signalHighlight = HighlightStyle.define([
    {
        tag: [t.comment, t.lineComment, t.blockComment],
        color: 'var(--syn-comment)',
        fontStyle: 'italic',
    },
    {
        tag: [
            t.keyword,
            t.controlKeyword,
            t.operatorKeyword,
            t.definitionKeyword,
            t.moduleKeyword,
            t.modifier,
            t.self,
            t.null,
        ],
        color: 'var(--syn-keyword)',
    },
    {
        tag: [
            t.function(t.variableName),
            t.function(t.propertyName),
            t.labelName,
            t.typeName,
            t.className,
            t.namespace,
        ],
        color: 'var(--syn-func)',
    },
    {
        tag: [
            t.string,
            t.special(t.string),
            t.regexp,
            t.number,
            t.integer,
            t.float,
            t.bool,
            t.atom,
            t.unit,
        ],
        color: 'var(--syn-string)',
    },
    {
        tag: [
            t.propertyName,
            t.attributeName,
            t.variableName,
            t.definition(t.variableName),
        ],
        color: 'var(--syn-name)',
    },
    {
        tag: [
            t.punctuation,
            t.separator,
            t.bracket,
            t.squareBracket,
            t.paren,
            t.brace,
            t.angleBracket,
            t.derefOperator,
            t.operator,
            t.compareOperator,
            t.arithmeticOperator,
            t.logicOperator,
        ],
        color: 'var(--syn-punct)',
    },
    { tag: [t.meta, t.escape], color: 'var(--accent)' },
    { tag: t.invalid, color: '#ff6b4a' },
]);

export const signalCodeMirrorTheme = [
    editorChrome,
    syntaxHighlighting(signalHighlight),
];

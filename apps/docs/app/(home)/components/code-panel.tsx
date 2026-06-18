'use client';

import { FoldToggleBar } from '@/components/fold-toggle';
import { cn } from '@/lib/cn';

import { Fragment, useState } from 'react';

const KEYWORDS = new Set([
    'const',
    'let',
    'await',
    'for',
    'of',
    'return',
    'import',
    'from',
    'new',
]);

type Tok = { className?: string; text: string };

/** Lightweight, dependency-free tokenizer for the static code panels. */
function tokenizeLine(line: string): Tok[] {
    const toks: Tok[] = [];

    // A whole-line comment, or a trailing comment that isn't part of a URL.
    const commentMatch = line.match(/(^|[^:])(\/\/.*)$/);
    let code = line;
    let comment: string | null = null;
    if (commentMatch && commentMatch[2]) {
        const idx = line.lastIndexOf(commentMatch[2]);
        code = line.slice(0, idx);
        comment = line.slice(idx);
    }

    const re =
        /('[^']*'|"[^"]*"|\b\d+\b|[A-Za-z_$][A-Za-z0-9_$]*|\s+|[^\w\s])/g;
    let m: RegExpExecArray | null;
    const pending: { value: string }[] = [];

    while ((m = re.exec(code)) !== null) {
        pending.push({ value: m[0] });
    }

    pending.forEach((tok, i) => {
        const v = tok.value;
        if (/^\s+$/.test(v)) {
            toks.push({ text: v });
            return;
        }
        if (/^['"]/.test(v)) {
            toks.push({ className: 'tok-str', text: v });
        } else if (/^\d+$/.test(v)) {
            toks.push({ className: 'tok-str', text: v });
        } else if (KEYWORDS.has(v)) {
            toks.push({ className: 'tok-key', text: v });
        } else if (/^[A-Za-z_$]/.test(v)) {
            // A call target: next non-space token is "(".
            const next = pending
                .slice(i + 1)
                .find((t) => !/^\s+$/.test(t.value));
            toks.push({
                className: next?.value === '(' ? 'tok-fn' : undefined,
                text: v,
            });
        } else {
            toks.push({ className: 'tok-punc', text: v });
        }
    });

    if (comment) toks.push({ className: 'tok-com', text: comment });
    return toks;
}

const FOLD_START = /\/\/\s*\[!code fold:start\]/;
const FOLD_END = /\/\/\s*\[!code fold:end\]/;

type Segment = { folded: boolean; lines: string[] };

/**
 * Split code into folded / unfolded runs on `// [!code fold:start|end]` marker
 * lines (the markers themselves are dropped) — the same sigils the docs MDX
 * blocks use (see lib/transformer-fold.ts), so the affordance is identical.
 */
function splitFold(code: string): { segments: Segment[]; hasFold: boolean } {
    const lines = code.replace(/\n$/, '').split('\n');
    const segments: Segment[] = [];
    let folding = false;
    let hasFold = false;
    for (const line of lines) {
        if (FOLD_START.test(line)) {
            folding = true;
            hasFold = true;
            continue;
        }
        if (FOLD_END.test(line)) {
            folding = false;
            continue;
        }
        const last = segments.at(-1);
        if (last && last.folded === folding) last.lines.push(line);
        else segments.push({ folded: folding, lines: [line] });
    }
    return { segments, hasFold };
}

function Line({ line, newline }: { line: string; newline: boolean }) {
    return (
        <span>
            {tokenizeLine(line).map((t, ti) =>
                t.className ? (
                    <span key={ti} className={t.className}>
                        {t.text}
                    </span>
                ) : (
                    <span key={ti}>{t.text}</span>
                ),
            )}
            {newline ? '\n' : ''}
        </span>
    );
}

/**
 * Render tokenized lines, wrapping each folded run in a `[data-fold-region]`
 * span — the shared CSS in global.css collapses it behind the toggle.
 */
function Code({ code }: { code: string }) {
    const { segments } = splitFold(code);
    const total = segments.reduce((n, s) => n + s.lines.length, 0);
    let gi = 0;
    return (
        <>
            {segments.map((seg, si) => {
                const lines = seg.lines.map((line) => {
                    const idx = gi++;
                    return (
                        <Line
                            key={idx}
                            line={line}
                            newline={idx < total - 1}
                        />
                    );
                });
                return seg.folded ? (
                    <span key={si} data-fold-region="">
                        {lines}
                    </span>
                ) : (
                    <Fragment key={si}>{lines}</Fragment>
                );
            })}
        </>
    );
}

export function CodePanel({
    filename,
    code,
    className,
}: {
    filename: string;
    code: string;
    className?: string;
}) {
    const { hasFold } = splitFold(code);
    const [open, setOpen] = useState(false);
    return (
        <div
            className={cn(
                'overflow-hidden rounded-xl border border-fd-border bg-fd-card shadow-lg',
                className,
            )}
            data-fold-collapsed={
                hasFold ? (open ? 'false' : 'true') : undefined
            }
        >
            <div className="flex items-center gap-2 border-b border-fd-border bg-fd-muted/40 px-4 py-2.5">
                <span className="size-3 rounded-full bg-fd-border" />
                <span className="size-3 rounded-full bg-fd-border" />
                <span className="size-3 rounded-full bg-fd-border" />
                <span className="ml-2 font-mono text-xs text-fd-muted-foreground">
                    {filename}
                </span>
            </div>
            <pre className="code-panel overflow-x-auto px-4 py-4 font-mono text-[13px] leading-relaxed text-fd-foreground">
                <code>
                    <Code code={code} />
                </code>
            </pre>
            {hasFold && (
                <FoldToggleBar open={open} onToggle={() => setOpen((v) => !v)} />
            )}
        </div>
    );
}

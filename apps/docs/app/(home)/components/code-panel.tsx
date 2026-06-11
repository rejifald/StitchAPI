import { cn } from '@/lib/cn';

import type { ReactNode } from 'react';

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

export function Code({ children }: { children: string }) {
    const lines = children.replace(/\n$/, '').split('\n');
    return (
        <>
            {lines.map((line, li) => (
                <span key={li}>
                    {tokenizeLine(line).map((t, ti) =>
                        t.className ? (
                            <span key={ti} className={t.className}>
                                {t.text}
                            </span>
                        ) : (
                            <span key={ti}>{t.text}</span>
                        ),
                    )}
                    {li < lines.length - 1 ? '\n' : ''}
                </span>
            ))}
        </>
    );
}

export function CodePanel({
    filename,
    children,
    className,
}: {
    filename: string;
    children: ReactNode;
    className?: string;
}) {
    return (
        <div
            className={cn(
                'overflow-hidden rounded-xl border border-fd-border bg-fd-card shadow-lg',
                className,
            )}
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
                <code>{children}</code>
            </pre>
        </div>
    );
}

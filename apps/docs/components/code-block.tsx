'use client';

import { FoldToggleBar } from '@/components/fold-toggle';

import { CodeBlock, Pre } from 'fumadocs-ui/components/codeblock';
import { type ComponentProps, useState } from 'react';

// `data-fold` is set on the `<pre>` by lib/transformer-fold.ts when a block has
// a foldable region; it isn't part of the intrinsic `pre` prop types.
type PreProps = ComponentProps<'pre'> & { 'data-fold'?: string };

/**
 * MDX `pre` override. A code block whose Shiki output carries a fold region
 * (see lib/transformer-fold.ts) is wrapped so a "Show full example" bar sits
 * flush against its bottom edge: the wrapper owns the border + rounding and the
 * inner Fumadocs `<figure>` is stripped of its own (see global.css `.code-fold`).
 * Every other block renders exactly like the Fumadocs default — same markup, no
 * wrapper — so tabs, titles, and line numbers are untouched.
 */
export function FoldableCodeBlock({ children, ...props }: PreProps) {
    const foldable = props['data-fold'] !== undefined;
    const [open, setOpen] = useState(false);

    const block = (
        <CodeBlock {...props}>
            <Pre>{children}</Pre>
        </CodeBlock>
    );

    if (!foldable) return block;

    return (
        // `data-fold-collapsed` drives the CSS that hides `[data-fold-region]`;
        // that span lives deep inside <CodeBlock>, so this must be an ancestor.
        <div
            data-fold-collapsed={open ? 'false' : 'true'}
            className="code-fold my-4 overflow-hidden rounded-xl border border-fd-border bg-fd-card shadow-sm"
        >
            {block}
            <FoldToggleBar open={open} onToggle={() => setOpen((v) => !v)} />
        </div>
    );
}

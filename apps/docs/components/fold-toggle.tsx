'use client';

import { ChevronDown } from 'lucide-react';

import { cn } from '@/lib/cn';

/**
 * The footer bar that toggles a foldable code block's hidden setup. Shared by
 * the docs MDX code blocks (components/code-block.tsx) and the landing-page
 * code panel (app/(home)/components/code-panel.tsx) so the affordance reads the
 * same everywhere. It renders flush against the bottom of its container — the
 * container owns the border + rounding and clips this with `overflow-hidden`,
 * so the only seam is this bar's own top border.
 */
export function FoldToggleBar({
    open,
    onToggle,
}: {
    open: boolean;
    onToggle: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className={cn(
                'flex w-full items-center justify-center gap-1.5 border-t border-fd-border',
                'bg-fd-muted/40 py-1.5 text-xs font-medium text-fd-muted-foreground',
                'transition-colors hover:bg-fd-muted hover:text-fd-foreground',
            )}
        >
            <ChevronDown
                className={cn(
                    'size-3.5 transition-transform',
                    open && 'rotate-180',
                )}
            />
            {open ? 'Hide full example' : 'Show full example'}
        </button>
    );
}

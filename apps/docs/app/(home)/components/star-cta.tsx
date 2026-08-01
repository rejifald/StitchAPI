import { SecondaryButton } from './primitives';

import { gitConfig } from '@/lib/shared';

import { Star } from 'lucide-react';

const repoUrl = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;

/**
 * The star ask, as a button. Deliberately count-free: below a few dozen stars
 * the number argues against the ask, so the CTA carries the reason instead of
 * the digits. Switch the count on later — see the note in `StarCard`.
 */
export function StarButton({ className }: { className?: string }) {
    return (
        <SecondaryButton href={repoUrl} external className={className}>
            <Star className="size-4 text-stitch" />
            Star on GitHub
        </SecondaryButton>
    );
}

/**
 * The same ask with its rationale, sized for the docs sidebar footer. The
 * headline echoes the home page's `0 runtime deps` metric on purpose.
 */
export function StarCard() {
    return (
        <div className="rounded-xl border border-fd-border bg-fd-card p-4">
            <p className="text-sm font-semibold text-fd-foreground">
                Zero dependencies. One star?
            </p>
            <p className="mt-1.5 text-xs leading-relaxed text-fd-muted-foreground">
                StitchAPI is Apache-2.0 and built in the open. A star is how the
                next person finds it.
            </p>
            <StarButton className="mt-3 w-full px-3 py-2 text-xs" />
        </div>
    );
}

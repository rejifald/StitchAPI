import { GithubIcon } from './primitives';

import { cn } from '@/lib/cn';
import { appName, gitConfig } from '@/lib/shared';

import { Star } from 'lucide-react';

const repoUrl = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;

/**
 * Live stargazer count, fetched server-side and cached for an hour (ISR).
 * Returns `null` on any network/API failure so the button degrades to a plain
 * "Star" CTA — the fetch must never block or break the render that hosts it.
 */
async function fetchStarCount(): Promise<number | null> {
    try {
        const res = await fetch(
            `https://api.github.com/repos/${gitConfig.user}/${gitConfig.repo}`,
            {
                headers: { Accept: 'application/vnd.github+json' },
                // Stars move slowly and the unauthenticated API is rate-limited
                // (60 req/h/IP), so refresh at most hourly rather than per request.
                next: { revalidate: 3600 },
            },
        );
        if (!res.ok) return null;
        const data = (await res.json()) as { stargazers_count?: unknown };
        return typeof data.stargazers_count === 'number'
            ? data.stargazers_count
            : null;
    } catch {
        return null;
    }
}

/** Compact count: `938 → "938"`, `1234 → "1.2k"`, `12345 → "12k"`. */
function formatCount(n: number): string {
    if (n < 1000) return String(n);
    const k = n / 1000;
    return `${k >= 10 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}k`;
}

/**
 * "Star on GitHub" call-to-action with a live stargazer count. An async server
 * component: the count is resolved during render (cached hourly) so there is no
 * client-side fetch, loading flash, or per-visitor API call. Pass `className`
 * to place it — it is used both in the hero and in the persistent site nav.
 */
export async function GithubStarButton({ className }: { className?: string }) {
    const count = await fetchStarCount();
    const formatted = count === null ? null : formatCount(count);

    return (
        <a
            href={repoUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={
                count === null
                    ? `Star ${appName} on GitHub`
                    : `Star ${appName} on GitHub — ${count.toLocaleString('en-US')} stars`
            }
            className={cn(
                'group inline-flex items-center gap-2 rounded-xl border border-fd-border bg-fd-card px-4 py-2.5 text-sm font-semibold text-fd-foreground transition-colors hover:bg-fd-accent',
                className,
            )}
        >
            <GithubIcon className="size-4" />
            <span>Star</span>
            <span
                className={cn(
                    'inline-flex items-center gap-1 text-fd-muted-foreground',
                    formatted !== null &&
                        'border-l border-fd-border pl-2 tabular-nums',
                )}
            >
                <Star
                    aria-hidden="true"
                    className="size-3.5 fill-accent text-accent transition-transform group-hover:scale-110"
                />
                {formatted}
            </span>
        </a>
    );
}

import { resolvePrerequisites } from '@/lib/prerequisites';

import { Compass } from 'lucide-react';
import Link from 'next/link';
import { Fragment } from 'react';

/**
 * "New to stitches? Start here" — the upstream counterpart to a page's `See also`
 * footer. Given a page's `prerequisites` frontmatter (internal hrefs), it resolves
 * each to its real title from source and renders a quiet one-line note near the
 * TOP of the page, so a reader who lands cold can step back to the foundational
 * concept before diving in.
 *
 * Deliberately low-chrome: a muted line with a thin left rule, no filled
 * background, so it reads as a wayfinding aside the eye can skip — not a banner
 * that competes with the title. Renders nothing when a page declares no
 * (resolvable) prerequisites, so it is safe to drop into every page renderer.
 */
export function Prerequisites({ hrefs }: { hrefs?: string[] }) {
    const items = resolvePrerequisites(hrefs);
    if (items.length === 0) return null;

    return (
        <aside
            aria-label="Prerequisites"
            className="text-fd-muted-foreground border-stitch-border mb-8 border-l-2 pl-3 text-sm leading-relaxed"
        >
            <Compass
                className="mr-1.5 inline size-3.5 -translate-y-px"
                aria-hidden
            />
            New to stitches? Start here:{' '}
            {items.map((item, index) => (
                <Fragment key={item.href}>
                    {index > 0 ? ' · ' : null}
                    <Link
                        href={item.href}
                        className="text-stitch-strong underline-offset-2 hover:underline"
                    >
                        {item.title}
                    </Link>
                </Fragment>
            ))}
        </aside>
    );
}

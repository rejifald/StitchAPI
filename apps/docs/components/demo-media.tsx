'use client';

import { cn } from '@/lib/cn';

import { useEffect, useState } from 'react';

const ALT =
    'StitchAPI demo — a stitch streaming, validating, retrying, and answering an agent';

/**
 * Follows the site's `.dark` class (next-themes toggles it on <html>) —
 * a MutationObserver rather than `prefers-color-scheme`, so a manual
 * theme switch swaps the asset too. Returns null before first paint on
 * the client so only the active theme's video ever mounts (a hidden
 * `display:none` video would still download and decode).
 */
function useIsDark() {
    const [dark, setDark] = useState<boolean | null>(null);
    useEffect(() => {
        const el = document.documentElement;
        const update = () => setDark(el.classList.contains('dark'));
        update();
        const observer = new MutationObserver(update);
        observer.observe(el, { attributes: true, attributeFilter: ['class'] });
        return () => observer.disconnect();
    }, []);
    return dark;
}

/**
 * Theme-aware embed of the generated demo clip (the committed
 * demo[-dark]-clip.mp4 pair in docs/media — see docs/media/README.md;
 * the build copies them into public/media via copy-demo-media.mjs).
 *
 * A <video>, not an animated webp/gif, on purpose: video is hardware-
 * decoded and drops frames to stay on schedule, while animated-image
 * frames are delta-encoded and can't be skipped — on weaker machines the
 * decoder falls behind and the loop turns progressively choppy. The
 * README (where GitHub forbids repo-hosted <video>) keeps the webp.
 */
export function DemoMedia({
    className,
    width = 1280,
}: {
    className?: string;
    width?: number;
}) {
    const dark = useIsDark();
    const height = Math.round((width * 9) / 16);
    if (dark === null) {
        // reserve the box pre-hydration so the layout doesn't jump
        return (
            <span
                className={cn('block w-full', className)}
                style={{ aspectRatio: '16 / 9', maxWidth: width }}
            />
        );
    }
    return (
        <video
            key={dark ? 'dark' : 'light'}
            src={`/media/demo${dark ? '-dark' : ''}-clip.mp4`}
            width={width}
            height={height}
            autoPlay
            muted
            loop
            playsInline
            preload="auto"
            aria-label={ALT}
            className={cn(
                'w-full rounded-xl border border-fd-border shadow-lg',
                className,
            )}
            // React can omit the muted attribute from SSR/first paint,
            // which blocks autoplay — set it imperatively to be safe.
            ref={(el) => {
                if (el) {
                    el.muted = true;
                    el.play().catch(() => {});
                }
            }}
        />
    );
}

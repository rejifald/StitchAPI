import { cn } from '@/lib/cn';

const ALT =
    'StitchAPI demo — a stitch streaming, validating, retrying, and answering an agent';

/**
 * Theme- and DPR-aware embed of the generated demo media (the committed
 * webp pairs in docs/media — see docs/media/README.md; the build copies
 * them into public/media via scripts/copy-demo-media.mjs).
 *
 * Light/dark follows the site's `.dark` class — a selector variant, not
 * `prefers-color-scheme`, so a manual theme toggle switches the asset
 * too. Within each theme the browser picks the 1x or @2x file from the
 * srcSet density descriptors, so non-retina screens never download the
 * 4×-pixel version.
 */
export function DemoMedia({
    className,
    width = 1280,
}: {
    className?: string;
    width?: number;
}) {
    const height = Math.round((width * 9) / 16);
    const img = (variant: '' | '-dark', cls: string) => (
        <img
            src={`/media/demo${variant}.webp`}
            srcSet={`/media/demo${variant}.webp 1x, /media/demo${variant}@2x.webp 2x`}
            width={width}
            height={height}
            alt={ALT}
            loading="lazy"
            className={cn('rounded-xl border border-fd-border shadow-lg', cls)}
        />
    );
    return (
        <span className={cn('block', className)}>
            {img('', '[.dark_&]:hidden')}
            {img('-dark', 'hidden [.dark_&]:block')}
        </span>
    );
}

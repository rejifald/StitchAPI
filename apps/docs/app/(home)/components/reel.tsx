import { cn } from '@/lib/cn';

/**
 * A vertical "drum" reel: a fixed 1.5em window that holds on each item, then
 * slides to the next on the brand ease. The track stacks the items plus a
 * duplicate of the first at the tail, so the keyframe loop ends on a frame
 * identical to the start and the reset is seamless.
 *
 * Mechanics are pure CSS (`.reel__*` + `@keyframes reel-spin-*` in global.css);
 * the keyframe is selected by item count via `data-count`, so a reel of N
 * items needs a matching `reel-spin-N` keyframe. Decorative on its own — the
 * caller marks the animated line `aria-hidden` and supplies a static fallback.
 */
export function Reel({
    items,
    className,
}: {
    items: string[];
    className?: string;
}) {
    // Duplicate the first item at the tail so the keyframe loop ends on a frame
    // identical to the start — the reset back to 0% is therefore invisible.
    const frames = [...items, items[0]];

    return (
        <span className={cn('reel__window', className)}>
            <span className="reel__track" data-count={items.length}>
                {frames.map((item, i) => (
                    <span key={i} className="reel__item">
                        {item}
                    </span>
                ))}
            </span>
        </span>
    );
}

import { cn } from '@/lib/cn';
import { RINGS, RIPPLE_VIEWBOX, ringPath } from '@/lib/ripple';

/**
 * The StitchAPI "ripple" motif from the banners — concentric, *imperfect*
 * fingerprint/topographic contours (not perfect circles) that gently breathe.
 * Shapes are generated deterministically (no randomness) so server and client
 * render identically.
 */

export function BrandBackdrop({ variant }: { variant: 'hero' | 'cta' }) {
    return (
        <div
            className={cn('brand-backdrop', `brand-backdrop--${variant}`)}
            aria-hidden
        >
            <div className="brand-backdrop__glow" />
            <svg
                className="brand-backdrop__rings"
                viewBox={RIPPLE_VIEWBOX}
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
            >
                {RINGS.map((ring, i) => (
                    <path
                        key={ring.r}
                        className="ripple-ring"
                        d={ringPath(ring.r, i)}
                        stroke="currentColor"
                        strokeWidth={1.25}
                        strokeOpacity={ring.o}
                        strokeDasharray={ring.dash}
                        strokeLinecap="round"
                        style={{ animationDelay: `${i * -0.55}s` }}
                    />
                ))}
            </svg>
        </div>
    );
}

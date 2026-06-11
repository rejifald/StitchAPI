import { cn } from '@/lib/cn';

/**
 * The StitchAPI "ripple" motif from the banners — concentric, *imperfect*
 * fingerprint/topographic contours (not perfect circles) that gently breathe.
 * Shapes are generated deterministically (no randomness) so server and client
 * render identically.
 */

const CENTER = 500;
const SAMPLES = 80;
const RINGS = [
    { r: 58, o: 0.4, dash: '1 8' },
    { r: 108, o: 0.36, dash: '2 9' },
    { r: 160, o: 0.32, dash: '1 7' },
    { r: 214, o: 0.28, dash: '3 11' },
    { r: 270, o: 0.24, dash: '1 9' },
    { r: 328, o: 0.2, dash: '2 12' },
    { r: 388, o: 0.16, dash: '1 8' },
    { r: 450, o: 0.13, dash: '4 14' },
    { r: 514, o: 0.1, dash: '1 11' },
    { r: 580, o: 0.07, dash: '2 13' },
];

// Smooth closed path through points via a Catmull-Rom → cubic-bezier conversion.
function smoothClosedPath(points: [number, number][]): string {
    const n = points.length;
    const f = (v: number) => Math.round(v * 100) / 100;
    let d = `M ${f(points[0][0])} ${f(points[0][1])}`;
    for (let i = 0; i < n; i++) {
        const p0 = points[(i - 1 + n) % n];
        const p1 = points[i];
        const p2 = points[(i + 1) % n];
        const p3 = points[(i + 2) % n];
        const c1x = p1[0] + (p2[0] - p0[0]) / 6;
        const c1y = p1[1] + (p2[1] - p0[1]) / 6;
        const c2x = p2[0] - (p3[0] - p1[0]) / 6;
        const c2y = p2[1] - (p3[1] - p1[1]) / 6;
        d += ` C ${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(p2[0])} ${f(p2[1])}`;
    }
    return `${d} Z`;
}

// One imperfect ring: a base radius warped by a few low-frequency harmonics,
// slightly flattened vertically so the whorl reads a touch wider than tall.
function ringPath(baseR: number, i: number): string {
    const amp = 0.02 + i * 0.006; // outer contours wander more
    const pts: [number, number][] = [];
    for (let k = 0; k < SAMPLES; k++) {
        const a = (k / SAMPLES) * Math.PI * 2;
        const wobble =
            Math.sin(a + i * 0.9 + 0.6) * amp +
            Math.sin(a * 2 + i * 1.7 + 1.2) * amp * 0.7 +
            Math.sin(a * 3 + i * 0.5 + 0.3) * amp * 0.45 +
            Math.sin(a * 5 + i * 2.3) * amp * 0.2;
        const r = baseR * (1 + wobble);
        pts.push([CENTER + r * Math.cos(a), CENTER + r * 0.88 * Math.sin(a)]);
    }
    return smoothClosedPath(pts);
}

export function BrandBackdrop({ variant }: { variant: 'hero' | 'cta' }) {
    return (
        <div
            className={cn('brand-backdrop', `brand-backdrop--${variant}`)}
            aria-hidden
        >
            <div className="brand-backdrop__glow" />
            <svg
                className="brand-backdrop__rings"
                viewBox="0 0 1000 1000"
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

import {
    logomarkBracketPaths,
    logomarkCloudPaths,
    logomarkSeamPaths,
    logomarkViewBox,
} from '@/components/logo';
import { RINGS, RIPPLE_VIEWBOX, ringPath } from '@/lib/ripple';
import { appName, siteUrl } from '@/lib/shared';

import { ImageResponse } from 'next/og';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// One Open Graph card for every route (`/og/home`, `/og/docs/...`, `/og/blog/...`),
// drawn in the Signal brand of the README banner (docs/media/baner_dark.png):
// the dark surface with a brand-blue radial glow, the dashed ripple rings, and
// the real lockup. Colors are the dark-theme values from app/tokens.css, the
// ripple and the logomark come from the same modules the site renders, and the
// type is the site's: Schibsted Grotesk for display, Hanken Grotesk for body.
//
// Every text block has a line budget that fits 1200×630 together, so long copy
// can never run into the next block:
//
//   title        ≤ 2 lines, font size stepped down as the title gets longer
//   description  ≤ 3 lines, ellipsis past that
//   header/footer never shrink
//
// and the middle block is the only one allowed to shrink, with overflow hidden,
// so a title that measures wider than expected still cannot paint over the
// footer.

const WIDTH = 1200;
const HEIGHT = 630;

// Signal, dark theme (app/tokens.css `.dark`).
const color = {
    bg: '#0a0d13',
    text: '#e9edf4',
    textMuted: '#98a2b3',
    brand: '#4c8dff',
    brandStrong: '#6ba1ff',
    accent: '#f6a823',
};

// Static instances of the site's fonts (OFL, see assets/og-fonts/). The image
// renderer can't use next/font and doesn't handle variable fonts.
const fontDir = join(process.cwd(), 'assets/og-fonts');
let fontsPromise: Promise<[Buffer, Buffer]> | undefined;
function loadFonts() {
    fontsPromise ??= Promise.all([
        readFile(join(fontDir, 'SchibstedGrotesk-Bold.ttf')),
        readFile(join(fontDir, 'HankenGrotesk-Regular.ttf')),
    ]);
    return fontsPromise;
}

// At 72px Schibsted fits ~27 characters per line, so two lines hold ~54; past
// that the size steps down rather than wrapping to a third line. Past ~96
// characters even 48px needs a third line, and the clamp ends the title with
// an ellipsis.
function titleFontSize(title: string): number {
    if (title.length <= 50) return 72;
    if (title.length <= 64) return 62;
    if (title.length <= 80) return 54;
    return 48;
}

function Lockup() {
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '18px' }}>
            <svg
                width="66"
                height="52"
                viewBox={logomarkViewBox}
                xmlns="http://www.w3.org/2000/svg"
            >
                {logomarkCloudPaths.map((d) => (
                    <path key={d} d={d} fill={color.brand} />
                ))}
                {logomarkBracketPaths.map((d) => (
                    <path key={d} d={d} fill={color.text} />
                ))}
                {logomarkSeamPaths.map((d) => (
                    <path key={d} d={d} fill={color.accent} />
                ))}
            </svg>
            <div
                style={{
                    fontFamily: 'Schibsted Grotesk',
                    fontSize: '40px',
                    letterSpacing: '-0.8px',
                    color: color.text,
                }}
            >
                {appName}
            </div>
        </div>
    );
}

// The ripple centred right of the copy, with the glow behind it — the banner's
// backdrop, moved off the text.
function Backdrop() {
    const cx = 930;
    const cy = 300;
    const size = 1100;
    return (
        <>
            <div
                style={{
                    position: 'absolute',
                    left: `${cx - 520}px`,
                    top: `${cy - 400}px`,
                    width: '1040px',
                    height: '800px',
                    backgroundImage: `radial-gradient(50% 50% at 50% 50%, rgba(76,141,255,0.22), rgba(76,141,255,0) 70%)`,
                }}
            />
            <svg
                width={size}
                height={size}
                viewBox={RIPPLE_VIEWBOX}
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                style={{
                    position: 'absolute',
                    left: `${cx - size / 2}px`,
                    top: `${cy - size / 2}px`,
                }}
            >
                {RINGS.map((ring, i) => (
                    <path
                        key={ring.r}
                        d={ringPath(ring.r, i)}
                        stroke={color.brandStrong}
                        strokeWidth={2}
                        strokeOpacity={ring.o}
                        strokeDasharray={ring.dash}
                        strokeLinecap="round"
                    />
                ))}
            </svg>
        </>
    );
}

function OgCard({
    title,
    description,
    section,
}: {
    title: string;
    description?: string;
    section?: string;
}) {
    return (
        <div
            style={{
                position: 'relative',
                display: 'flex',
                flexDirection: 'column',
                width: '100%',
                height: '100%',
                padding: '60px 72px',
                backgroundColor: color.bg,
                color: color.text,
                fontFamily: 'Hanken Grotesk',
            }}
        >
            <Backdrop />
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    flexShrink: 0,
                }}
            >
                <Lockup />
                {section ? (
                    <div
                        style={{
                            fontFamily: 'Schibsted Grotesk',
                            fontSize: '22px',
                            letterSpacing: '3px',
                            textTransform: 'uppercase',
                            color: color.accent,
                        }}
                    >
                        {section}
                    </div>
                ) : null}
            </div>
            <div
                style={{
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center',
                    flexGrow: 1,
                    flexShrink: 1,
                    minHeight: 0,
                    overflow: 'hidden',
                    gap: '22px',
                    paddingTop: '24px',
                    paddingBottom: '24px',
                }}
            >
                <div
                    style={{
                        display: 'block',
                        fontFamily: 'Schibsted Grotesk',
                        fontSize: `${titleFontSize(title)}px`,
                        lineHeight: 1.1,
                        letterSpacing: `${-0.03 * titleFontSize(title)}px`,
                        lineClamp: 2,
                    }}
                >
                    {title}
                </div>
                {description ? (
                    <div
                        style={{
                            display: 'block',
                            fontSize: '32px',
                            lineHeight: 1.35,
                            color: color.textMuted,
                            lineClamp: 3,
                        }}
                    >
                        {description}
                    </div>
                ) : null}
            </div>
            <div
                style={{
                    display: 'flex',
                    flexShrink: 0,
                    fontSize: '26px',
                    color: color.brand,
                }}
            >
                {new URL(siteUrl).host}
            </div>
        </div>
    );
}

export async function ogImageResponse(props: {
    title: string;
    description?: string;
    // Small label top right, e.g. "Docs" or "Blog"; the homepage card has none.
    section?: string;
}): Promise<ImageResponse> {
    const [display, body] = await loadFonts();
    return new ImageResponse(<OgCard {...props} />, {
        width: WIDTH,
        height: HEIGHT,
        fonts: [
            {
                name: 'Schibsted Grotesk',
                data: display,
                weight: 700,
                style: 'normal',
            },
            {
                name: 'Hanken Grotesk',
                data: body,
                weight: 400,
                style: 'normal',
            },
        ],
    });
}

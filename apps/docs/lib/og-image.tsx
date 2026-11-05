import { appName } from '@/lib/shared';

import { ImageResponse } from 'next/og';

// One Open Graph card for every route (`/og/home`, `/og/docs/...`, `/og/blog/...`).
//
// It keeps the look of fumadocs' `generate` template, which these routes used
// before, but not its layout: that template stacks title, description and footer
// in a flex column with no line limit, so a long description ran through the
// dashed divider and the footer logo (the homepage card shipped that way). Here
// every block has a fixed line budget that fits 1200×630 together:
//
//   title        ≤ 2 lines, font size stepped down as the title gets longer
//   description  ≤ 3 lines at 40px, ellipsis past that
//   footer       never shrinks, pinned to the bottom
//
// and the description is also the only block allowed to shrink, with overflow
// hidden, so a font that measures wider than expected still cannot paint over
// the footer.

const WIDTH = 1200;
const HEIGHT = 630;

const primaryColor = 'rgba(255,150,255,0.3)';
const primaryTextColor = 'rgb(255,150,255)';

// 82px fits ~28 characters per line, so two lines hold ~56; past that the size
// steps down rather than wrapping to a third line. Past ~96 characters even
// 48px needs a third line, and the clamp ends the title with an ellipsis.
function titleFontSize(title: string): number {
    if (title.length <= 52) return 82;
    if (title.length <= 70) return 66;
    if (title.length <= 80) return 56;
    return 48;
}

function OgCard({
    title,
    description,
}: {
    title: string;
    description?: string;
}) {
    return (
        <div
            style={{
                display: 'flex',
                flexDirection: 'column',
                width: '100%',
                height: '100%',
                color: 'white',
                padding: '64px',
                backgroundColor: '#0c0c0c',
                borderBottom: `18px solid ${primaryColor}`,
            }}
        >
            <div
                style={{
                    display: 'block',
                    flexShrink: 0,
                    fontWeight: 800,
                    fontSize: `${titleFontSize(title)}px`,
                    lineHeight: 1.15,
                    lineClamp: 2,
                }}
            >
                {title}
            </div>
            <div
                style={{
                    display: 'flex',
                    flexDirection: 'column',
                    flexShrink: 1,
                    minHeight: 0,
                    overflow: 'hidden',
                    marginTop: '24px',
                    paddingBottom: '28px',
                    borderBottom: `10px dashed ${primaryColor}`,
                }}
            >
                {description ? (
                    <div
                        style={{
                            display: 'block',
                            fontSize: '40px',
                            lineHeight: 1.3,
                            color: 'rgba(240,240,240,0.8)',
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
                    flexDirection: 'row',
                    alignItems: 'center',
                    flexShrink: 0,
                    gap: '20px',
                    marginTop: 'auto',
                    paddingTop: '24px',
                    color: primaryTextColor,
                }}
            >
                <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="56"
                    height="56"
                    viewBox="0 0 24 24"
                    fill="none"
                >
                    <circle
                        cx="12"
                        cy="12"
                        r="11"
                        stroke={primaryTextColor}
                        strokeWidth="2"
                    />
                </svg>
                <div style={{ fontSize: '56px', fontWeight: 600 }}>
                    {appName}
                </div>
            </div>
        </div>
    );
}

export function ogImageResponse(props: {
    title: string;
    description?: string;
}): ImageResponse {
    return new ImageResponse(<OgCard {...props} />, {
        width: WIDTH,
        height: HEIGHT,
    });
}

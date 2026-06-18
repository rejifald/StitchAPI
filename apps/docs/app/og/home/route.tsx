import { appName } from '@/lib/shared';

import { generate as DefaultImage } from 'fumadocs-ui/og';
import { ImageResponse } from 'next/og';

export const revalidate = false;

export function GET() {
    return new ImageResponse(
        (
            <DefaultImage
                title="Turn any API into a typed, resilient function"
                description="API stitching: declare an endpoint once — its types, auth, and resilience — and call it like a local function. No server, no codegen, no config files."
                site={appName}
            />
        ),
        { width: 1200, height: 630 },
    );
}

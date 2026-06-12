import { appName } from '@/lib/shared';

import { generate as DefaultImage } from 'fumadocs-ui/og';
import { ImageResponse } from 'next/og';

export const revalidate = false;

export function GET() {
    return new ImageResponse(
        (
            <DefaultImage
                title="A typed stitch replaces fetch"
                description="An agent-native runtime whose core primitive — a stitch — replaces fetch. Call one endpoint as a function, CLI, HTTP route, or MCP tool."
                site={appName}
            />
        ),
        { width: 1200, height: 630 },
    );
}

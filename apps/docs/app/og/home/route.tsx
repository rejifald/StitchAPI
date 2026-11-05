import { ogImageResponse } from '@/lib/og-image';

export const revalidate = false;

export function GET() {
    return ogImageResponse({
        title: 'Turn any API into a typed, resilient function',
        description:
            'API stitching: declare an endpoint once — its types, auth, and resilience — and call it like a local function. No server, no codegen, no config files.',
    });
}

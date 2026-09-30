import { llmsPreamble, source } from '@/lib/source';

import { llms } from 'fumadocs-core/source';

export const revalidate = false;

export async function GET() {
    // Lead with the curated StitchAPI header, then the auto-generated page index.
    // fumadocs' index() emits the root meta.json title ("Documentation") as its
    // first heading — strip that leading heading so the output leads with the
    // preamble's "# StitchAPI" rather than a generic "# Documentation".
    const index = (await llms(source).index()).replace(/^#\s+.*\n?/, '');

    return new Response(`${llmsPreamble()}\n\n${index}`);
}

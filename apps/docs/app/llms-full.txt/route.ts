import { getLLMText, llmsPreamble, source } from '@/lib/source';

export const revalidate = false;

// Page URLs that should lead the concatenated corpus, in this order: an agent
// reads the introduction, how to install, the quickstart, then the agent-facing
// pages before the rest of the manual. Any page not listed keeps its default
// order and trails the lead block.
const leadOrder = [
    '/docs/getting-started',
    '/docs/getting-started/installation',
    '/docs/getting-started/quickstart',
    '/docs/agents',
    '/docs/agents/run-stitch-tool',
    '/docs/agents/author-from-one-example',
    '/docs/agents/llms-txt',
];

export async function GET() {
    const pages = source.getPages();
    const rank = (url: string) => {
        const i = leadOrder.indexOf(url);

        return i === -1 ? leadOrder.length : i;
    };

    const ordered = [...pages].sort((a, b) => {
        const delta = rank(a.url) - rank(b.url);

        // Stable fallback for pages outside the lead list: keep getPages() order.
        return delta !== 0 ? delta : pages.indexOf(a) - pages.indexOf(b);
    });

    const scanned = await Promise.all(ordered.map(getLLMText));

    return new Response(`${llmsPreamble()}\n\n${scanned.join('\n\n')}`);
}

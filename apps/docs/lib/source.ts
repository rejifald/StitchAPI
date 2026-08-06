import { docsContentRoute, docsImageRoute, docsRoute } from './shared';

import { docs } from 'collections/server';
import { loader } from 'fumadocs-core/source';
import { lucideIconsPlugin } from 'fumadocs-core/source/lucide-icons';

// See https://fumadocs.dev/docs/headless/source-api for more info
export const source = loader({
    baseUrl: docsRoute,
    source: docs.toFumadocsSource(),
    plugins: [lucideIconsPlugin()],
});

// A curated, signal-first header prepended to /llms.txt and /llms-full.txt so an
// agent reads what StitchAPI is — and how to call it — before the page index.
// The advertised numbers live here in ONE place so they can't drift across docs.
export function llmsPreamble() {
    return `# StitchAPI
> API stitching: turn any API into a typed, resilient function. Declare an endpoint once — its types, auth, and resilience — and call it like a local function, from your code, the CLI, or an AI agent over MCP, without ever touching a credential. fetch/axios are pluggable adapters underneath; a stitch sits above them, it does not replace them.

Search these docs instead of loading the whole file: this site is also a hosted MCP server (search_docs + get_doc) at https://stitchapi.dev/api/mcp — see /docs/agents/search-over-mcp.

## What an agent needs to know
- API stitching, not an HTTP client: a **stitch** takes one endpoint (HTTP, GraphQL, SSE, an LLM, even a shell command) and hands back a callable. Keep the fetch/axios you already have — it is the adapter underneath.
- Capability, not credential: an agent invokes a stitch and gets structured, validated, traceable data; the secret stays behind the boundary.
- One context-frugal **code-mode** tool (run_stitch + list_stitches + describe_stitch), not one tool per endpoint — adding APIs never floods the context window.
- No server, no codegen, no config files — a URL and one example response is enough; only explicit composition (no ambient/global config a stitch silently inherits).
- Zero-dependency core, ~24 kB min+gzip for the whole entry (~22 kB for a tree-shaken import { stitch }), validator-agnostic (bring your own Standard Schema / Zod), and it runs in the browser.
- Composes with your data layer: a stitch is the queryFn for TanStack Query / SWR — it owns the call's resilience; your query layer owns view state.

## Quickstart
\`\`\`ts
import { stitch } from 'stitchapi';

const getUser = stitch('https://api.example.com/users/{id}');
const user = await getUser({ params: { id: 1 } }); // typed, validated, traced
\`\`\``;
}

export function getPageImage(page: (typeof source)['$inferPage']) {
    const segments = [...page.slugs, 'image.png'];

    return {
        segments,
        url: `${docsImageRoute}/${segments.join('/')}`,
    };
}

export function getPageMarkdownUrl(page: (typeof source)['$inferPage']) {
    const segments = [...page.slugs, 'content.md'];

    return {
        segments,
        url: `${docsContentRoute}/${segments.join('/')}`,
    };
}

export async function getLLMText(page: (typeof source)['$inferPage']) {
    const processed = await page.data.getText('processed');

    return `# ${page.data.title} (${page.url})

${processed}`;
}

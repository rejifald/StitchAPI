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
> The agent-native runtime where a typed, declarative stitch replaces fetch for humans and agents alike — declare an endpoint once; your code, the CLI, and an agent all call it without ever touching a credential.

## What an agent needs to know
- Agent-native: one context-frugal **code-mode** tool (run_stitch + list_stitches + describe_stitch), not one tool per endpoint — adding APIs never floods the context window.
- Capability, not credential: an agent invokes a stitch and gets structured, validated, traceable data; the secret stays behind the boundary.
- Zero-dependency core, ~17–21 kB min+gzip, validator-agnostic (bring your own Standard Schema / Zod), and it runs in the browser.
- No spec, no codegen, no server — a URL and one example response is enough.

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

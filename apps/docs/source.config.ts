import { rehypeCodeDefaultOptions } from 'fumadocs-core/mdx-plugins';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';
import { defineConfig, defineDocs } from 'fumadocs-mdx/config';
import { transformerTwoslash } from 'fumadocs-twoslash';

// You can customize Zod schemas for frontmatter and `meta.json` here
// see https://fumadocs.dev/docs/mdx/collections
export const docs = defineDocs({
    dir: 'content/docs',
    docs: {
        schema: pageSchema,
        postprocess: {
            includeProcessedMarkdown: true,
        },
    },
    meta: {
        schema: metaSchema,
    },
});

export default defineConfig({
    mdxOptions: {
        // Package-manager install tabs (```package-install```) and code-variant
        // tabs (```ts tab="…"```) ship on by default in fumadocs-mdx. `persist`
        // makes the reader's package-manager pick stick across every page;
        // code-variant tabs persist per `tabGroup` id set on the fence.
        // See AUTHORING.md → "Code variants — tabs".
        remarkNpmOptions: { persist: { id: 'package-manager' } },
        // Twoslash type-checks every ```ts twoslash``` block against the real
        // `stitchapi` types at build time and renders hover tooltips. Spread the
        // defaults so the stock Shiki transformers (tab/title/icon meta) survive;
        // the Popup components it emits are registered in components/mdx.tsx.
        rehypeCodeOptions: {
            ...rehypeCodeDefaultOptions,
            transformers: [
                ...(rehypeCodeDefaultOptions.transformers ?? []),
                transformerTwoslash(),
            ],
        },
    },
});

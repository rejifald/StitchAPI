import { remarkInstallChannel } from './lib/remark-install-channel';
import { transformerFold } from './lib/transformer-fold';

import { rehypeCodeDefaultOptions } from 'fumadocs-core/mdx-plugins';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';
import { defineConfig, defineDocs } from 'fumadocs-mdx/config';
import { transformerTwoslash } from 'fumadocs-twoslash';
import { z } from 'zod';

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

// A SEPARATE collection from `docs`, with its own `content/blog` tree, so it
// stays clear of the docs IA drift guard (content.manifest.ts + the skeleton
// generator + content-manifest.spec.ts), which is scoped to `content/docs`.
//
// Blog posts carry the standard page frontmatter (title/description) plus
// author + date + optional tags. Extending `pageSchema` keeps the blog in sync
// with however the docs page schema evolves rather than re-declaring it.
// `date` is an ISO date string (`YYYY-MM-DD`); we keep it a string the loader
// can sort lexicographically and parse with `new Date(...)` for display. The
// YAML parser turns an unquoted `date: 2026-06-25` into a `Date`, so coerce it
// back to an ISO date string before validating — quoting in frontmatter is
// preferred, but this keeps an unquoted date from breaking the build.
//
// NOTE: `source.config.ts` may only export collections — keep the schema inline
// (fumadocs-mdx rejects any other export from this file).
export const blog = defineDocs({
    dir: 'content/blog',
    docs: {
        schema: pageSchema.extend({
            author: z.string(),
            date: z.preprocess(
                (value) =>
                    value instanceof Date
                        ? value.toISOString().slice(0, 10)
                        : value,
                z
                    .string()
                    .refine(
                        (value) => !Number.isNaN(new Date(value).getTime()),
                        {
                            message:
                                'Invalid date — use an ISO date like 2026-06-25',
                        },
                    ),
            ),
            tags: z.array(z.string()).optional(),
        }),
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
        // Stamp the documented npm dist-tag (e.g. `@rc`) onto bare first-party
        // specs in ```package-install``` blocks BEFORE fumadocs' remarkNpm expands
        // them into per-manager tabs. The array form of `remarkPlugins` runs AFTER
        // remarkNpm; the function form receives the built-in list so we can
        // prepend and run first. See lib/remark-install-channel.ts.
        remarkPlugins: (builtin) => [remarkInstallChannel, ...builtin],
        // Twoslash type-checks every ```ts twoslash``` block against the real
        // `stitchapi` types at build time and renders hover tooltips. Spread the
        // defaults so the stock Shiki transformers (tab/title/icon meta) survive;
        // the Popup components it emits are registered in components/mdx.tsx.
        rehypeCodeOptions: {
            ...rehypeCodeDefaultOptions,
            transformers: [
                ...(rehypeCodeDefaultOptions.transformers ?? []),
                // NestJS examples use legacy class/parameter decorators (@Module,
                // @Injectable, @Inject); enable them so those ```ts twoslash``` blocks
                // type-check against the real @stitchapi/nest + @nestjs/* types.
                transformerTwoslash({
                    twoslashOptions: {
                        compilerOptions: { experimentalDecorators: true },
                    },
                }),
                // Collapse `// [!code fold:start] … [!code fold:end]` regions
                // behind a "Show full example" toggle. Runs AFTER twoslash so it
                // folds the post-twoslash line elements (and keeps them in the
                // DOM, unlike twoslash's `// ---cut---`). The toggle UI is the
                // `pre` override in components/mdx.tsx. See AUTHORING.md →
                // "Folding setup code".
                transformerFold(),
            ],
        },
    },
});

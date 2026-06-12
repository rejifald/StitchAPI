import { Popup, PopupContent, PopupTrigger } from 'fumadocs-twoslash/ui';
import { createGenerator } from 'fumadocs-typescript';
import { AutoTypeTable } from 'fumadocs-typescript/ui';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';
import type { ComponentProps } from 'react';

// One generator for the whole docs build — reads the real workspace types so
// Reference pages render their option shapes straight from source (no hand-written
// tables that can drift). `path` on <AutoTypeTable> resolves relative to this app's
// cwd, e.g. `../../packages/core/src/types.ts`.
const generator = createGenerator();

type AutoTypeTableProps = Omit<
    ComponentProps<typeof AutoTypeTable>,
    'generator'
>;

export function getMDXComponents(components?: MDXComponents) {
    return {
        ...defaultMdxComponents,
        AutoTypeTable: (props: AutoTypeTableProps) => (
            <AutoTypeTable generator={generator} {...props} />
        ),
        // Twoslash hover popups — emitted by the transformer wired in source.config.ts.
        Popup,
        PopupContent,
        PopupTrigger,
        ...components,
    } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
    type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}

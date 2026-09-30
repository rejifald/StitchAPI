import { FoldableCodeBlock } from '@/components/code-block';

import { Popup, PopupContent, PopupTrigger } from 'fumadocs-twoslash/ui';
import { type GenerateOptions, createGenerator } from 'fumadocs-typescript';
import { AutoTypeTable } from 'fumadocs-typescript/ui';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';
import type { ComponentProps } from 'react';

// One generator for the whole docs build — reads the real workspace types so
// Reference pages render their option shapes straight from source (no hand-written
// tables that can drift). `path` on <AutoTypeTable> resolves relative to this app's
// cwd, e.g. `../../packages/core/src/types.ts`.
const generator = createGenerator();

/** Longest written type we'll put in the table's Type column before falling back. */
const MAX_WRITTEN_TYPE = 120;

/**
 * The shape we need off a TypeScript AST node (fumadocs-typescript drives the
 * native `typescript/unstable` API). Declared structurally because that package
 * is a transitive dep of fumadocs-typescript and isn't resolvable from this app.
 * Method signatures carry `parameters`; property signatures don't.
 */
interface DeclarationLike {
    parameters?: unknown;
    type?: { getText: () => string };
}

/**
 * Show the type **as written in the source** instead of fumadocs' simplified form.
 *
 * The simplifier collapses any union to the bare word `union` (and likewise
 * `object` / `function`), which erases exactly the thing a reader needs: the name
 * of the nested shape. `retry` rendered as `union` rather than
 * `number | AtLeastOne<RetryOptions>`, so there was no name to go look up — and
 * because an optional `T | undefined` is itself a union, this hit nearly every
 * field. The written node also keeps the alias and generic sugar that resolving
 * the type throws away (`AtLeastOne<MultipartOptions>`, not its expansion).
 *
 * Falls back to the simplified form for method signatures (no type node — their
 * `function` is already right) and for anything too long to read in a column.
 */
const preferWrittenType: GenerateOptions['transform'] = function (
    entry,
    _type,
    symbol,
) {
    // `@remarks` / `@fumadocsType` are deliberate author overrides — leave them be.
    if (
        entry.tags.some(
            (t) => t.name === 'remarks' || t.name === 'fumadocsType',
        )
    )
        return;

    const declaration = symbol.declarations[0]?.resolve(this.program) as
        DeclarationLike | undefined;
    if (!declaration || 'parameters' in declaration) return;

    const written = declaration.type?.getText();
    if (!written) return;

    // Prettier breaks a long union across lines with a leading `|`.
    const oneLine = written
        .replace(/\s+/g, ' ')
        .replace(/^\|\s*/, '')
        .trim();
    if (!oneLine || oneLine.length > MAX_WRITTEN_TYPE) return;

    entry.simplifiedType = oneLine;
};

type AutoTypeTableProps = Omit<
    ComponentProps<typeof AutoTypeTable>,
    'generator'
>;

export function getMDXComponents(components?: MDXComponents) {
    return {
        ...defaultMdxComponents,
        // Adds a "Show full code" toggle to blocks with a fold region; falls
        // back to the default code block otherwise (see components/code-block.tsx).
        pre: FoldableCodeBlock,
        AutoTypeTable: (props: AutoTypeTableProps) => (
            <AutoTypeTable
                generator={generator}
                options={{ transform: preferWrittenType }}
                {...props}
            />
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

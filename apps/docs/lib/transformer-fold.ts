import type { ShikiTransformer } from 'shiki';

// Derive the hast node types from Shiki's own `code` hook signature, so this
// file needs no direct `hast` / `@types/hast` dependency (pnpm's strict linker
// wouldn't resolve them here anyway — they're transitive, not declared).
type CodeHook = NonNullable<ShikiTransformer['code']>;
type HastElement = Parameters<CodeHook>[0];
type HastNode = HastElement['children'][number];

/**
 * Fold a region of a code block behind a "Show full example" toggle.
 *
 * Authors mark a region with whole-line comment sigils; the lines between them
 * — imports, validation schemas, type scaffolding: required for the snippet to
 * compile under Twoslash, but not the point of the example — collapse by
 * default and are revealed by the button rendered in `components/code-block.tsx`.
 *
 * ```ts twoslash
 * // [!code fold:start]
 * import { stitch } from 'stitchapi';
 * import { z } from 'zod';
 * // [!code fold:end]
 * const getUser = stitch({ baseUrl: 'https://api.example.com', path: '/users/{id}' });
 * ```
 *
 * Unlike Twoslash's `// ---cut---`, the folded code stays in the DOM — still
 * type-checked, and revealable — rather than being deleted. Wire this AFTER
 * `transformerTwoslash` so it operates on the post-Twoslash line elements.
 */
const START = /\[!code fold:start\]/;
const END = /\[!code fold:end\]/;

function classList(node: HastElement): string[] {
    const raw = node.properties?.['className'] ?? node.properties?.['class'];
    if (Array.isArray(raw)) return raw.map(String);
    if (typeof raw === 'string') return raw.split(/\s+/);
    return [];
}

function isLine(node: HastNode): node is HastElement {
    return (
        node.type === 'element' &&
        node.tagName === 'span' &&
        classList(node).includes('line')
    );
}

function isBlankText(node: HastNode): boolean {
    return node.type === 'text' && node.value.trim() === '';
}

function textOf(node: HastNode): string {
    if (node.type === 'text') return node.value;
    if (node.type === 'element') return node.children.map(textOf).join('');
    return '';
}

/** A line element plus the newline text node that follows it, kept together. */
interface Row {
    nodes: HastNode[];
    line?: HastElement;
}

/** Group a `<code>`'s children into rows so newlines travel with their line. */
function toRows(children: HastNode[]): Row[] {
    const rows: Row[] = [];
    for (let i = 0; i < children.length; i++) {
        const node = children[i];
        if (!isLine(node)) {
            rows.push({ nodes: [node] });
            continue;
        }
        const row: Row = { nodes: [node], line: node };
        const next = children[i + 1];
        if (next && isBlankText(next)) {
            row.nodes.push(next);
            i++;
        }
        rows.push(row);
    }
    return rows;
}

/** Wrap collected rows in a `display:contents` span the toggle can hide. */
function foldRegion(rows: Row[]): HastElement {
    return {
        type: 'element',
        tagName: 'span',
        properties: { 'data-fold-region': '' },
        children: rows.flatMap((r) => r.nodes),
    };
}

export function transformerFold(): ShikiTransformer {
    return {
        name: 'stitchapi:fold',
        code(code) {
            const out: Row[] = [];
            let region: Row[] | null = null;
            let folded = false;

            for (const row of toRows(code.children)) {
                const text = row.line ? textOf(row.line) : '';
                // Marker lines are dropped whole (line + its newline).
                if (row.line && START.test(text)) {
                    region = [];
                    folded = true;
                    continue;
                }
                if (row.line && END.test(text)) {
                    if (region) out.push({ nodes: [foldRegion(region)] });
                    region = null;
                    continue;
                }
                (region ?? out).push(row);
            }
            // Tolerate a missing `:end` — fold to the end of the block.
            if (region) out.push({ nodes: [foldRegion(region)] });

            if (!folded) return;

            // A region that ends the block keeps a trailing newline that would
            // render as a dangling blank line once expanded — drop it.
            const last = out.at(-1)?.nodes[0];
            if (
                last?.type === 'element' &&
                last.properties?.['data-fold-region'] !== undefined
            ) {
                while (last.children.length && isBlankText(last.children.at(-1)!))
                    last.children.pop();
            }

            code.children = out.flatMap((r) => r.nodes);
            // Flag the <pre> so the React `pre` override renders the toggle.
            this.pre.properties['data-fold'] = '';
        },
    };
}

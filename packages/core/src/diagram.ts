// `stitch diagram` — render a Mermaid flowchart of each stitch's SHAPE from its definition
// (`__config`), not from a run. A glance-able "what does this stitch do": the configured request
// pipeline — throttle, the request, retry, a non-http surface's interpret step, pagination,
// validation, transform, unwrap, cache — in engine order. A trace-driven DAG of what actually ran
// is a separate, future capability (it needs composition causality the flat event stream does not
// yet emit). Auth is intentionally absent: it is redacted from `__config` (ADR 0002), so a stitch
// cannot leak which credential it holds — not even its scheme — through this view.
import { pipelineStages } from './config-summary';
import type { StitchRegistry } from './registry';

export interface MermaidExportResult {
    diagram: string;
    warnings: string[];
}

// `endpointLabel` is re-exported (it used to live here): `stitch init --project` imports it from
// `./diagram` to reuse the exact same one-line "METHOD endpoint" summary in the consumer rule list.
export { endpointLabel } from './config-summary';

// Mermaid node ids must be identifier-safe; labels ride in quotes (double-quotes swapped out).
function safeId(key: string, i: number): string {
    return `s${i}_${key.replace(/[^A-Za-z0-9]/g, '_')}`;
}
function label(text: string): string {
    return text.replace(/"/g, "'");
}

/**
 * Build a Mermaid `flowchart` of the registry: one subgraph per stitch, each a left-to-right chain
 * of its configured pipeline stages. Pure (no I/O). `opts.name` filters to a single stitch (by
 * registry key or configured `name`). Returns the diagram text plus warnings (e.g. an unknown name).
 */
export function toMermaid(
    registry: StitchRegistry,
    opts: { name?: string } = {},
): MermaidExportResult {
    const warnings: string[] = [];
    const entries = Object.entries(registry).filter(
        ([key, s]) =>
            opts.name === undefined ||
            key === opts.name ||
            s.__config.name === opts.name,
    );
    if (opts.name !== undefined && entries.length === 0)
        warnings.push(`no stitch named "${opts.name}"`);

    const lines: string[] = ['flowchart TD'];
    entries.forEach(([key, stitch], i) => {
        const id = safeId(key, i);
        const chain = pipelineStages(stitch.__config, { detailed: true })
            .map((text, j, all) => {
                const terminal = j === 0 || j === all.length - 1;
                return terminal
                    ? `${id}_${j}(["${label(text)}"])`
                    : `${id}_${j}["${label(text)}"]`;
            })
            .join(' --> ');
        lines.push(`  subgraph ${id}["${label(key)}"]`);
        lines.push('    direction LR');
        lines.push(`    ${chain}`);
        lines.push('  end');
    });
    return { diagram: `${lines.join('\n')}\n`, warnings };
}

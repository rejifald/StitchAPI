// `stitch diagram` — render a Mermaid flowchart of each stitch's SHAPE from its definition
// (`__config`), not from a run. A glance-able "what does this stitch do": the configured request
// pipeline — throttle, the request, retry, a non-http surface's interpret step, pagination,
// validation, transform, unwrap, cache — in engine order. A trace-driven DAG of what actually ran
// is a separate, future capability (it needs composition causality the flat event stream does not
// yet emit). Auth is intentionally absent: it is redacted from `__config` (ADR 0002), so a stitch
// cannot leak which credential it holds — not even its scheme — through this view.
import type { StitchRegistry } from './registry';
import type { StitchConfig } from './types';

export interface MermaidExportResult {
    diagram: string;
    warnings: string[];
}

// A compact "METHOD endpoint" label for the request node. Exported so `stitch
// init --project` can reuse the exact same one-line summary when listing a repo's
// existing stitches in the consumer rule.
export function endpointLabel(cfg: StitchConfig): string {
    const method = (cfg.method ?? 'GET').toUpperCase();
    let where: string;
    if (typeof cfg.url === 'string') where = cfg.url;
    else if (typeof cfg.url === 'function') where = '(dynamic url)';
    else {
        const base =
            typeof cfg.baseUrl === 'string'
                ? cfg.baseUrl
                : cfg.baseUrl
                  ? '(dynamic)'
                  : '';
        where = base + (cfg.path ?? '');
    }
    return `${method} ${where || '(no endpoint)'}`;
}

// The configured pipeline stages, in engine order. `call`/`result` always bookend; the middle
// stages appear only when configured. Auth is redacted from __config, so it never appears.
function stagesFor(cfg: StitchConfig): string[] {
    const kindRaw: unknown = cfg.kind; // __config.kind is the surface id string
    const kind = typeof kindRaw === 'string' ? kindRaw : 'http';
    const stages: string[] = ['call'];
    if (cfg.throttle) stages.push('throttle');
    stages.push(endpointLabel(cfg));
    if (cfg.retry) stages.push(`retry ×${cfg.retry.attempts ?? 1}`);
    if (kind !== 'http') stages.push(`${kind} interpret`);
    if (cfg.paginate) stages.push(`paginate (max ${cfg.paginate.max ?? 50})`);
    if (cfg.output) stages.push('validate');
    if (cfg.transform) stages.push('transform');
    if (cfg.unwrap) stages.push(`unwrap: ${cfg.unwrap}`);
    if (cfg.cache) stages.push('cache');
    stages.push('result');
    return stages;
}

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
        const chain = stagesFor(stitch.__config)
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

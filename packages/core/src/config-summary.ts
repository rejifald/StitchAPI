// Shared, pure read-outs of a stitch's redacted `__config` — the "what does this stitch do" shape
// used by both `stitch diagram` (./diagram) and the MCP server's stitch listing (./mcp). Kept in one
// leaf so the two stay in lockstep instead of drifting as near-duplicate copies. Auth is redacted
// from `__config` (ADR 0002), so it never appears here.
import type { RedactedStitchConfig } from './types';

// A compact "METHOD endpoint" label for the request node. Reused by `stitch init --project` (the
// consumer rule list) and the MCP `endpoint` field, so the one-line summary stays identical.
export function endpointLabel(cfg: RedactedStitchConfig): string {
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

// The configured pipeline stages, in engine order. `call`/`result` always bookend; the middle stages
// appear only when configured. `detailed` (the diagram view) annotates `retry`/`paginate` with their
// counts; the terse default (the MCP teaching list) names the stage only.
export function pipelineStages(
    cfg: RedactedStitchConfig,
    opts: { detailed?: boolean } = {},
): string[] {
    const kind = cfg.kind ?? 'http'; // __config.kind is the surface id string
    const stages: string[] = ['call'];
    if (cfg.throttle) stages.push('throttle');
    stages.push(endpointLabel(cfg));
    if (cfg.retry)
        stages.push(
            opts.detailed ? `retry ×${cfg.retry.attempts ?? 1}` : 'retry',
        );
    if (kind !== 'http') stages.push(`${kind} interpret`);
    if (cfg.paginate)
        stages.push(
            opts.detailed
                ? `paginate (max ${cfg.paginate.max ?? 50})`
                : 'paginate',
        );
    // Post-response order matches the engine (engine.ts): transform → unwrap → validate. The body
    // is transformed, then the unwrap path is read, then the result is validated against `output`.
    if (cfg.transform) stages.push('transform');
    if (cfg.unwrap) stages.push(`unwrap: ${cfg.unwrap}`);
    if (cfg.output) stages.push('validate');
    if (cfg.cache) stages.push('cache');
    stages.push('result');
    return stages;
}

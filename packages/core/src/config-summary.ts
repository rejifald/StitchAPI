// Shared, pure read-outs of a stitch's redacted `__config` — the "what does this stitch do" shape
// used by both `stitch diagram` (./diagram) and the MCP server's stitch listing (./mcp). Kept in one
// leaf so the two stay in lockstep instead of drifting as near-duplicate copies. Auth is redacted
// from `__config` (ADR 0002), so it never appears here.
import type {
    Assert,
    Covers,
    PolicySlot,
    StageEntry,
    StagedSlot,
} from './config-anatomy';
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

// How each staged slot renders, keyed off the config anatomy. `at` must equal the anatomy's declared
// position — the order lives there, not here — and `_StagesCovered` rejects a slot the anatomy stages
// but this table forgets, so a new capability cannot land silently absent from the read-out.
// Post-response order matches the engine (engine.ts): transform → pick → validate. The pick path is
// read, then the result is validated against `output`. (`transform` is a live closure and lives only
// on `__rawConfig` — P0 — so the redacted public view can't report it as a stage.)
const STAGES = [
    { slot: 'throttle', at: 1, label: () => 'throttle' },
    {
        slot: 'retry',
        at: 3,
        label: (cfg, detailed) =>
            detailed ? `retry ×${cfg.retry?.attempts ?? 1}` : 'retry',
    },
    {
        slot: 'paginate',
        at: 5,
        label: (cfg, detailed) =>
            detailed
                ? `paginate (max ${cfg.paginate?.pages ?? 50})`
                : 'paginate',
    },
    { slot: 'pick', at: 6, label: (cfg) => `pick: ${cfg.pick}` },
    { slot: 'output', at: 7, label: () => 'validate' },
    { slot: 'cache', at: 8, label: () => 'cache' },
] as const satisfies readonly StageEntry<RedactedStitchConfig>[];
export type _StagesCovered = Assert<
    Covers<StagedSlot, (typeof STAGES)[number]['slot']>
>;

// The configured pipeline stages, in engine order. `call`/`result` always bookend; the middle stages
// appear only when configured. `detailed` (the diagram view) annotates `retry`/`paginate` with their
// counts; the terse default (the MCP teaching list) names the stage only.
export function pipelineStages(
    cfg: RedactedStitchConfig,
    opts: { detailed?: boolean } = {},
): string[] {
    const kind = cfg.kind ?? 'http'; // __config.kind is the surface id string
    // The unconditional positions on the anatomy's shared number line, then every configured slot at
    // its own. One sort puts them in engine order — no hand-maintained sequence of pushes.
    const at: [number, string][] = [
        [0, 'call'],
        [2, endpointLabel(cfg)],
        [9, 'result'],
    ];
    if (kind !== 'http') at.push([4, `${kind} interpret`]);
    for (const stage of STAGES) {
        if (cfg[stage.slot])
            at.push([stage.at, stage.label(cfg, opts.detailed ?? false)]);
    }
    return at.sort((a, b) => a[0] - b[0]).map(([, label]) => label);
}

// The resilience knobs reported to an agent as configured/not (the `mcp` `policies` block). It joins
// `endpointLabel` and `pipelineStages` here rather than living in `mcp.ts` for two reasons: it is the
// same kind of pure read-out of `__config`, and `mcp` is a published entry point, so an exported
// coverage assert there would land in the package's public `.d.ts`.
const POLICY_SLOTS = [
    'retry',
    'throttle',
    'cache',
    'timeout',
] as const satisfies readonly PolicySlot[];
export type _PoliciesCovered = Assert<
    Covers<PolicySlot, (typeof POLICY_SLOTS)[number]>
>;

export function policySummary(
    cfg: RedactedStitchConfig,
): Record<string, boolean> {
    return Object.fromEntries(
        POLICY_SLOTS.map((k) => [k, cfg[k] !== undefined]),
    );
}

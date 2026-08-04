// Direct unit tests for src/config-summary.ts — the shared, pure read-outs of a stitch's redacted
// __config (endpointLabel + pipelineStages) used by `stitch diagram`, the MCP stitch listing, and
// `stitch init --project`. It has no dedicated spec: diagram.spec.ts exercises a SUBSET of stages
// through toMermaid, and nothing covers endpointLabel's dynamic/no-endpoint branches, the full
// engine-ordered stage chain, or the terse (non-detailed) mode the MCP listing uses. These do.
import { endpointLabel, pipelineStages } from '../src/config-summary';
import type { RedactedStitchConfig } from '../src/types';

// The functions read __config purely (structurally); a redacted config is otherwise large and
// resolved, so build minimal shapes and assert through this single boundary cast.
const cfg = (o: Record<string, unknown>): RedactedStitchConfig => o;

describe('endpointLabel', () => {
    it('defaults the method to GET for a string url', () => {
        expect(endpointLabel(cfg({ url: 'https://x/y' }))).toBe(
            'GET https://x/y',
        );
    });

    it('uppercases a non-GET method', () => {
        expect(
            endpointLabel(cfg({ method: 'delete', url: 'https://x/y' })),
        ).toBe('DELETE https://x/y');
    });

    it('joins a string baseUrl with the path', () => {
        expect(endpointLabel(cfg({ baseUrl: 'https://x', path: '/y' }))).toBe(
            'GET https://x/y',
        );
    });

    it('marks a dynamic (function) url', () => {
        expect(endpointLabel(cfg({ url: () => 'https://x' }))).toBe(
            'GET (dynamic url)',
        );
    });

    it('marks a dynamic baseUrl while keeping the path', () => {
        expect(
            endpointLabel(cfg({ baseUrl: () => 'https://x', path: '/y' })),
        ).toBe('GET (dynamic)/y');
    });

    it('falls back to "(no endpoint)" when nothing is configured', () => {
        expect(endpointLabel(cfg({}))).toBe('GET (no endpoint)');
    });
});

describe('pipelineStages', () => {
    // Stage 4 is unconditional since ADR 0022 Decision 2 — `http` used to be the one surface with no
    // interpretation to render, and that omission is why the outcome ladder was hard to discover
    // (#529). Every stitch now shows the stage that decides what its response means.
    it('a bare config is call -> endpoint -> interpret -> result', () => {
        expect(pipelineStages(cfg({ url: 'https://x/y' }))).toEqual([
            'call',
            'GET https://x/y',
            'http interpret',
            'result',
        ]);
    });

    it('a non-http surface names itself at the same stage', () => {
        expect(
            pipelineStages(cfg({ url: 'https://x/y', kind: 'graphql' })),
        ).toContain('graphql interpret');
    });

    it('detailed mode chains every configured stage in engine order, with counts', () => {
        const full = cfg({
            baseUrl: 'https://api.example.com',
            path: '/widgets',
            method: 'POST',
            throttle: { concurrency: 2 },
            retry: { attempts: 3 },
            paginate: { pages: 7 },
            transform: () => undefined,
            pick: 'data',
            output: () => true,
            cache: '1m',
        });
        // Post-response order is pick → validate (engine.ts), bookended by call/result. `transform`
        // is a live closure (P0 — off the public `__config`), so the redacted summary omits it.
        expect(pipelineStages(full, { detailed: true })).toEqual([
            'call',
            'throttle',
            'POST https://api.example.com/widgets',
            'retry ×3',
            'http interpret',
            'paginate (max 7)',
            'pick: data',
            'validate',
            'cache',
            'result',
        ]);
    });

    it('terse mode (the default) names retry/paginate without their counts', () => {
        const c = cfg({
            url: 'https://x/y',
            retry: { attempts: 3 },
            paginate: { pages: 7 },
        });
        expect(pipelineStages(c)).toEqual([
            'call',
            'GET https://x/y',
            'retry',
            'http interpret',
            'paginate',
            'result',
        ]);
    });

    it('detailed retry without an explicit attempts count renders ×1', () => {
        expect(
            pipelineStages(cfg({ url: 'https://x', retry: {} }), {
                detailed: true,
            }),
        ).toContain('retry ×1');
    });

    it('detailed paginate without max renders the default (max 50)', () => {
        expect(
            pipelineStages(cfg({ url: 'https://x', paginate: {} }), {
                detailed: true,
            }),
        ).toContain('paginate (max 50)');
    });

    it('a non-http surface inserts a "<kind> interpret" stage', () => {
        expect(
            pipelineStages(cfg({ url: 'https://x', kind: 'graphql' })),
        ).toEqual(['call', 'GET https://x', 'graphql interpret', 'result']);
    });
});

// ADR 0022 Decision 2/3 — `verdict` is stage 4's declarative input, so it ANNOTATES the
// interpret stage rather than floating as its own unnamed entry. Before this ADR the slot carried
// no stage at all: it did a pipeline stage's job and was invisible in the pipeline.
describe('stage 4 renders the interpret stage and its accept rule', () => {
    it('annotates the stage when verdict.accept is a list', () => {
        expect(
            pipelineStages(
                cfg({ url: 'https://x/y', verdict: { accept: [404, 410] } }),
            ),
        ).toContain('http interpret (accept 404, 410)');
    });

    it('annotates the stage when verdict.accept is a bare number', () => {
        expect(
            pipelineStages(
                cfg({ url: 'https://x/y', verdict: { accept: 404 } }),
            ),
        ).toContain('http interpret (accept 404)');
    });

    it('renders the stage exactly once either way', () => {
        const withAccept = pipelineStages(
            cfg({ url: 'https://x/y', verdict: { accept: [404] } }),
        );
        const without = pipelineStages(cfg({ url: 'https://x/y' }));
        expect(withAccept.filter((s) => s.includes('interpret'))).toHaveLength(
            1,
        );
        expect(without.filter((s) => s.includes('interpret'))).toHaveLength(1);
    });

    it('keeps the stage in engine order — after retry, before pick', () => {
        expect(
            pipelineStages(
                cfg({
                    url: 'https://x/y',
                    retry: { attempts: 2 },
                    verdict: { accept: [404] },
                    pick: 'data',
                }),
            ),
        ).toEqual([
            'call',
            'GET https://x/y',
            'retry',
            'http interpret (accept 404)',
            'pick: data',
            'result',
        ]);
    });
});

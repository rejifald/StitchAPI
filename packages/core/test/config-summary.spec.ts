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
    it('a bare config is just call -> endpoint -> result', () => {
        expect(pipelineStages(cfg({ url: 'https://x/y' }))).toEqual([
            'call',
            'GET https://x/y',
            'result',
        ]);
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
            unwrap: 'data',
            output: () => true,
            cache: '1m',
        });
        // Post-response order is unwrap → validate (engine.ts), bookended by call/result. `transform`
        // is a live closure (P0 — off the public `__config`), so the redacted summary omits it.
        expect(pipelineStages(full, { detailed: true })).toEqual([
            'call',
            'throttle',
            'POST https://api.example.com/widgets',
            'retry ×3',
            'paginate (max 7)',
            'unwrap: data',
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

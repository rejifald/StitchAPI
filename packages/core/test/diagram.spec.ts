// `stitch diagram` — render a Mermaid flowchart of each stitch's configured pipeline from its
// definition (not a run). The pure `toMermaid` is asserted directly; the `diagram` command is
// driven through `main` with an injected registry loader.
import { stitch } from '../src';
import { main } from '../src/cli';
import { toMermaid } from '../src/diagram';
import type { StitchRegistry } from '../src/registry';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-diagram-${process.pid}.jsonl`,
);

const sampleRegistry = (): StitchRegistry => ({
    getUser: stitch({
        baseUrl: 'https://api.example.com',
        path: '/users/{id}',
        retry: { attempts: 3 },
        output: z.object({ id: z.number() }),
        pick: 'data',
    }),
    ping: stitch('https://api.example.com/ping'),
});

describe('toMermaid', () => {
    test('emits a flowchart with one subgraph per stitch', () => {
        const { diagram } = toMermaid(sampleRegistry());
        expect(diagram.startsWith('flowchart TD')).toBe(true);
        expect(diagram).toContain('subgraph s0_getUser["getUser"]');
        expect(diagram).toContain('subgraph s1_ping["ping"]');
    });

    test('a stitch chains its configured pipeline stages in order', () => {
        const { diagram } = toMermaid(sampleRegistry());
        // getUser: call -> request -> retry -> pick -> validate -> result (no throttle/cache).
        expect(diagram).toContain('(["call"]) -->');
        expect(diagram).toContain('GET https://api.example.com/users/{id}');
        expect(diagram).toContain('retry');
        expect(diagram).toContain('validate');
        expect(diagram).toContain('pick: data');
        expect(diagram).toContain('(["result"])');
    });

    test('post-response stages render in engine order: pick -> validate', () => {
        // The engine reads the pick path then validates (engine.ts), and the diagram's contract is
        // "the configured request pipeline … in engine order" — validate LAST of the two. The
        // `transform` closure lives only on `__rawConfig` (P0), so the redacted view (and hence the
        // diagram) never shows a transform stage.
        const { diagram } = toMermaid({
            proc: stitch({
                baseUrl: 'https://api.example.com',
                path: '/x',
                transform: (b) => b,
                pick: 'data',
                output: z.object({ id: z.number() }),
            }),
        });
        expect(diagram).not.toContain('transform');
        const iPick = diagram.indexOf('pick: data');
        const iValidate = diagram.indexOf('validate');
        expect(iPick).toBeGreaterThanOrEqual(0);
        expect(iValidate).toBeGreaterThan(iPick); // validate after pick
    });

    test('a bare stitch is just call -> request -> result', () => {
        const { diagram } = toMermaid({
            ping: stitch('https://api.example.com/ping'),
        });
        expect(diagram).not.toContain('retry');
        expect(diagram).not.toContain('validate');
        expect(diagram).toContain('GET https://api.example.com/ping');
    });

    test('--name filters to one stitch; an unknown name warns', () => {
        const only = toMermaid(sampleRegistry(), { name: 'ping' });
        expect(only.diagram).toContain('s0_ping["ping"]');
        expect(only.diagram).not.toContain('getUser');
        expect(only.warnings).toEqual([]);

        const missing = toMermaid(sampleRegistry(), { name: 'nope' });
        expect(missing.warnings.some((w) => w.includes('nope'))).toBe(true);
    });
});

describe('stitch diagram (CLI)', () => {
    test('writes a Mermaid flowchart to stdout', async () => {
        const registry: StitchRegistry = {
            getUser: stitch('https://api.example.com/users/{id}'),
        };
        let out = '';
        const code = await main(['diagram', '--module', 'x'], {
            cwd: '/',
            load: async () => registry,
            write: (s) => {
                out += s;
            },
            writeErr: () => undefined,
        });
        expect(code).toBe(0);
        expect(out.startsWith('flowchart TD')).toBe(true);
        expect(out).toContain('GET https://api.example.com/users/{id}');
    });
});

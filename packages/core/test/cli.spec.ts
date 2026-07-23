// Set the trace file before importing ../src so the JSONL sink is captured/quiet.
import { stitch } from '../src';
import {
    argsToInput,
    formatTraceSummary,
    paramNamesOf,
    runStitch,
    splitRunArgs,
    summarizeTrace,
} from '../src/cli';
import { collectStitches, loadStitches, selectStitch } from '../src/registry';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';
import { asValidator } from './support/schema';

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-cli-${process.pid}.jsonl`,
);

let server: MockServer;
beforeAll(async () => {
    server = await startMockServer();
});
afterAll(async () => {
    await server.close();
});
beforeEach(() => {
    server.reset();
});

const parseLines = (lines: string[]) => lines.map((l) => JSON.parse(l));

// ---- arg → input mapping --------------------------------------------------

describe('argsToInput', () => {
    test('bare flags route to params when in the path, else to query', () => {
        const { input } = argsToInput(
            ['--id', '7', '--expand', 'roles'],
            ['id'],
        );
        expect(input.params).toEqual({ id: 7 });
        expect(input.query).toEqual({ expand: 'roles' });
    });

    test('namespaced buckets: params / query / headers / body', () => {
        const { input } = argsToInput([
            '--params.id',
            '1',
            '--query.q',
            'ada',
            '--headers.x-api-key',
            'secret',
            '--body.name',
            'Ada',
        ]);
        expect(input.params).toEqual({ id: 1 });
        expect(input.query).toEqual({ q: 'ada' });
        expect(input.headers).toEqual({ 'x-api-key': 'secret' });
        expect(input.body).toEqual({ name: 'Ada' });
    });

    test('--body takes a whole JSON document', () => {
        const { input } = argsToInput(['--body', '{"a":1,"b":[2,3]}']);
        expect(input.body).toEqual({ a: 1, b: [2, 3] });
    });

    test('values coerce (number/boolean) but header values stay strings', () => {
        const { input } = argsToInput([
            '--query.n',
            '42',
            '--query.active',
            'true',
            '--headers.x-num',
            '42',
        ]);
        expect(input.query).toEqual({ n: 42, active: true });
        expect(input.headers).toEqual({ 'x-num': '42' });
    });

    test('a bare flag with no value is boolean true', () => {
        const { input } = argsToInput(['--verbose']);
        expect(input.query).toEqual({ verbose: true });
    });

    test('--k=v form and repeated keys (→ array) are supported', () => {
        const { input } = argsToInput([
            '--query.tag=a',
            '--query.tag',
            'b',
            '--query.tag',
            'c',
        ]);
        expect(input.query).toEqual({ tag: ['a', 'b', 'c'] });
    });
});

test('paramNamesOf reads {param} names from the stitch path', () => {
    const s = stitch({ baseUrl: 'http://x', path: '/orgs/{org}/repos/{repo}' });
    expect(paramNamesOf(s)).toEqual(['org', 'repo']);
});

// ---- run --trace extraction (off by default) ------------------------------

describe('splitRunArgs (--trace extraction)', () => {
    test('absent --trace stays undefined: a run traces nothing by default', () => {
        expect(splitRunArgs(['get-user', '--id', '7']).trace).toBeUndefined();
    });
    test('bare --trace, =console, and =<path> are each pulled out', () => {
        expect(splitRunArgs(['get-user', '--trace']).trace).toBe('default');
        expect(splitRunArgs(['get-user', '--trace=console']).trace).toBe(
            'console',
        );
        expect(splitRunArgs(['get-user', '--trace=./run.jsonl']).trace).toBe(
            './run.jsonl',
        );
    });
    test('--trace never leaks into the stitch input flags', () => {
        const { name, flags } = splitRunArgs([
            'get-user',
            '--trace',
            '--id',
            '7',
        ]);
        expect(name).toBe('get-user');
        expect(flags).toEqual(['--id', '7']);
    });
});

// ---- registry -------------------------------------------------------------

describe('registry', () => {
    test('collectStitches finds named, default-registry, and nested stitches', () => {
        const a = stitch({ baseUrl: 'http://x', path: '/a' });
        const b = stitch({ baseUrl: 'http://x', path: '/b' });
        const c = stitch({ baseUrl: 'http://x', path: '/c' });
        const reg = collectStitches({
            a,
            default: { b },
            nested: { c, notAStitch: 123 },
        });
        expect(Object.keys(reg).sort()).toEqual(['a', 'b', 'c']);
    });

    test('selectStitch matches by export key, then by configured name', () => {
        const listing = stitch({
            name: 'list-things',
            baseUrl: 'http://x',
            path: '/things',
        });
        const reg = { listing };
        expect(selectStitch(reg, 'listing')).toBe(listing);
        expect(selectStitch(reg, 'list-things')).toBe(listing);
    });

    test('selectStitch throws a listing error for an unknown name', () => {
        const reg = { a: stitch({ baseUrl: 'http://x', path: '/a' }) };
        expect(() => selectStitch(reg, 'nope')).toThrow(
            /unknown stitch "nope"/,
        );
        expect(() => selectStitch(reg, 'nope')).toThrow(/Available: a/);
    });

    test('loadStitches resolves a path to a file URL and collects the module', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'stitch-mod-'));
        const file = join(dir, 'stitches.mjs');
        writeFileSync(file, 'export const placeholder = 1;\n');
        const listWidgets = stitch({
            baseUrl: 'http://x',
            path: '/widgets',
        });

        let importedUrl = '';
        const reg = await loadStitches(file, async (url) => {
            importedUrl = url;
            return { listWidgets }; // stand in for the real module's exports
        });

        expect(importedUrl.startsWith('file://')).toBe(true);
        expect(importedUrl.endsWith('stitches.mjs')).toBe(true);
        expect(Object.keys(reg)).toEqual(['listWidgets']);
    });
});

// ---- run: arg → input → JSONL, end to end ---------------------------------

describe('runStitch (arg → input → JSONL)', () => {
    test('maps flags onto the request and streams JSONL events', async () => {
        server.route('GET', '/widgets', {
            body: { data: [{ id: 1, name: 'Cog' }] },
        });
        const listWidgets = stitch({
            baseUrl: server.url,
            path: '/widgets',
            pick: 'data',
            output: asValidator(
                z.array(z.object({ id: z.number(), name: z.string() })),
            ),
        });

        const lines: string[] = [];
        const code = await runStitch(
            { listWidgets },
            'listWidgets',
            ['--published', 'true', '--query.limit', '10'],
            (l) => lines.push(l),
        );

        expect(code).toBe(0);
        // the flags reached the actual request
        expect(server.calls('/widgets')[0]?.query).toEqual({
            published: 'true',
            limit: '10',
        });
        // every line is valid JSON; the stream is start → … → result → done
        const events = parseLines(lines);
        expect(events[0].type).toBe('start');
        expect(events.at(-1).type).toBe('done');
        const result = events.find((e) => e.type === 'result');
        expect(result.data).toEqual([{ id: 1, name: 'Cog' }]);
    });

    test('routes a bare path-param flag into the URL', async () => {
        server.route('GET', '/widgets/7', { body: { id: 7 } });
        const getWidget = stitch({
            baseUrl: server.url,
            path: '/widgets/{id}',
        });
        const lines: string[] = [];
        const code = await runStitch(
            { getWidget },
            'getWidget',
            ['--id', '7'],
            (l) => lines.push(l),
        );
        expect(code).toBe(0);
        expect(server.callCount('/widgets/7')).toBe(1);
        expect(parseLines(lines).find((e) => e.type === 'result').data).toEqual(
            { id: 7 },
        );
    });

    test('exit code 1 and an error event on failure', async () => {
        server.route('GET', '/boom', { statuses: [500] });
        const boom = stitch({ baseUrl: server.url, path: '/boom' });
        const lines: string[] = [];
        const code = await runStitch({ boom }, 'boom', [], (l) =>
            lines.push(l),
        );
        expect(code).toBe(1);
        expect(parseLines(lines).some((e) => e.type === 'error')).toBe(true);
    });
});

// ---- trace summary --------------------------------------------------------

describe('summarizeTrace', () => {
    const records = [
        { name: 'a', type: 'done', ok: true, elapsed: 10, at: 1 },
        { name: 'a', type: 'progress', phase: 'retry', at: 1 },
        { name: 'a', type: 'done', ok: true, elapsed: 30, at: 2 },
        { name: 'a', type: 'done', ok: false, elapsed: 20, at: 3 },
        { name: 'a', type: 'drift', finding: { level: 'warn' }, at: 3 },
        { name: 'b', type: 'done', ok: true, elapsed: 5, at: 4 },
    ];

    test('aggregates runs, ok/failed, retries, drift, and percentiles per stitch', () => {
        const { stitches, totals } = summarizeTrace(records);
        expect(totals).toEqual({ runs: 4, ok: 3, failed: 1 });

        const a = stitches.find((s) => s.name === 'a')!;
        expect(a.runs).toBe(3);
        expect(a.ok).toBe(2);
        expect(a.failed).toBe(1);
        expect(a.retries).toBe(1);
        expect(a.drift.warn).toBe(1);
        expect(a.p50).toBeGreaterThan(0);
        expect(a.avg).toBe(20); // (10 + 30 + 20) / 3
    });

    test('formatTraceSummary renders a table mentioning each stitch', () => {
        const out = formatTraceSummary(summarizeTrace(records));
        expect(out).toContain('a');
        expect(out).toContain('b');
        expect(out).toContain('total: 4 run(s), 3 ok, 1 failed');
    });
});

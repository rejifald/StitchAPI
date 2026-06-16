// Set the trace file before importing ../src so the JSONL sink is captured/quiet.
import { drift, stitch } from '../src';
import {
    argsToInput,
    formatTraceSummary,
    main,
    paramNamesOf,
    runStitch,
    splitRunArgs,
    summarizeTrace,
} from '../src/cli';
import { loadSnapshot } from '../src/drift';
import { collectStitches, loadStitches, selectStitch } from '../src/registry';
import type { StitchRegistry } from '../src/registry';
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
            unwrap: 'data',
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
        expect(result.value).toEqual([{ id: 1, name: 'Cog' }]);
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
        expect(
            parseLines(lines).find((e) => e.type === 'result').value,
        ).toEqual({ id: 7 });
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
        { name: 'a', type: 'done', ok: true, ms: 10, at: 1 },
        { name: 'a', type: 'progress', phase: 'retry', at: 1 },
        { name: 'a', type: 'done', ok: true, ms: 30, at: 2 },
        { name: 'a', type: 'done', ok: false, ms: 20, at: 3 },
        { name: 'a', type: 'drift', finding: { level: 'warn' }, at: 3 },
        { name: 'b', type: 'done', ok: true, ms: 5, at: 4 },
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
        expect(a.avgMs).toBe(20); // (10 + 30 + 20) / 3
    });

    test('formatTraceSummary renders a table mentioning each stitch', () => {
        const out = formatTraceSummary(summarizeTrace(records));
        expect(out).toContain('a');
        expect(out).toContain('b');
        expect(out).toContain('total: 4 run(s), 3 ok, 1 failed');
    });
});

// ---- drift generate: write the snapshot baseline(s) deliberately ----------

describe('stitch drift generate (CLI)', () => {
    // Drive `main` with an injected registry loader (like diagram.spec), capturing stdout/stderr.
    const runGenerate = (registry: StitchRegistry, args: string[] = []) => {
        const out: string[] = [];
        const err: string[] = [];
        return main(['drift', 'generate', '--module', 'x', ...args], {
            cwd: '/',
            load: async () => registry,
            write: (s) => out.push(s),
            writeErr: (s) => err.push(s),
        }).then((code) => ({ code, out: out.join(''), err: err.join('') }));
    };
    const snapDir = () => mkdtempSync(join(tmpdir(), 'stitch-drift-'));

    test('runs a drift-guarded stitch and writes its baseline (the post-unwrap shape)', async () => {
        server.route('GET', '/widgets/7', {
            body: { data: { id: 7, name: 'Cog' } },
        });
        const file = join(snapDir(), 'widget.contract.json');
        const getWidget = stitch({
            baseUrl: server.url,
            path: '/widgets/{id}',
            unwrap: 'data',
            output: drift(z.object({ id: z.number(), name: z.string() }), {
                critical: ['id'],
                snapshotFile: file,
            }),
        });

        const { code, out } = await runGenerate({ getWidget }, ['--id', '7']);

        expect(code).toBe(0);
        expect(out).toContain(`wrote ${file}`);
        // The baseline is the engine's post-unwrap SHAPE (payload-free) — what a live run compares against.
        expect(loadSnapshot(file)).toEqual({
            version: 1,
            shape: { id: 'number', name: 'string' },
        });
        expect(server.callCount('/widgets/7')).toBe(1);
    });

    test('a generated baseline produces no drift on a subsequent live run', async () => {
        server.route('GET', '/things', { body: { id: 1, kind: 'a' } });
        const file = join(snapDir(), 'thing.contract.json');
        const getThing = stitch({
            baseUrl: server.url,
            path: '/things',
            output: drift(z.object({ id: z.number(), kind: z.string() }), {
                critical: ['id'],
                snapshotFile: file,
            }),
        });

        const { code } = await runGenerate({ getThing });
        expect(code).toBe(0);

        // Re-run live against the just-written baseline: an identical body → zero drift findings.
        const lines: string[] = [];
        const runCode = await runStitch({ getThing }, 'getThing', [], (l) =>
            lines.push(l),
        );
        expect(runCode).toBe(0);
        const events = parseLines(lines);
        expect(events.some((e) => e.type === 'drift')).toBe(false);
        expect(events.find((e) => e.type === 'result').value).toEqual({
            id: 1,
            kind: 'a',
        });
    });

    test('--name baselines only the named stitch, by export key', async () => {
        server.route('GET', '/a', { body: { id: 1 } });
        server.route('GET', '/b', { body: { id: 2 } });
        const dir = snapDir();
        const fileA = join(dir, 'a.contract.json');
        const fileB = join(dir, 'b.contract.json');
        const a = stitch({
            baseUrl: server.url,
            path: '/a',
            output: drift(z.object({ id: z.number() }), {
                snapshotFile: fileA,
            }),
        });
        const b = stitch({
            baseUrl: server.url,
            path: '/b',
            output: drift(z.object({ id: z.number() }), {
                snapshotFile: fileB,
            }),
        });

        const { code } = await runGenerate({ a, b }, ['--name', 'b']);

        expect(code).toBe(0);
        expect(loadSnapshot(fileB)).toEqual({ version: 1, shape: { id: 'number' } });
        expect(loadSnapshot(fileA)).toBeUndefined(); // a was left untouched
        expect(server.callCount('/a')).toBe(0);
        expect(server.callCount('/b')).toBe(1);
    });

    test('keeps an existing snapshot by default; --force overwrites a stale one', async () => {
        server.route('GET', '/u', { body: { id: 9, role: 'admin' } });
        const file = join(snapDir(), 'u.contract.json');
        // Pre-seed a STALE baseline that critically differs (id is a string, not a number): a live
        // run would fail it at the `critical` path, yet --force must still regenerate from live.
        writeFileSync(file, JSON.stringify({ id: 'old', role: 'admin' }));
        const getU = stitch({
            baseUrl: server.url,
            path: '/u',
            output: drift(z.object({ id: z.number(), role: z.string() }), {
                critical: ['id'],
                snapshotFile: file,
            }),
        });

        // Default: the existing snapshot is kept, the stitch is skipped, and no call is made.
        const skip = await runGenerate({ getU });
        expect(skip.code).toBe(0);
        expect(skip.err).toContain('skip getU');
        expect(loadSnapshot(file)).toEqual({ id: 'old', role: 'admin' });
        expect(server.callCount('/u')).toBe(0);

        // --force: overwrite with the live body even though it critically drifts from the stale one.
        const force = await runGenerate({ getU }, ['--force']);
        expect(force.code).toBe(0);
        expect(force.out).toContain(`wrote ${file}`);
        expect(loadSnapshot(file)).toEqual({
            version: 1,
            shape: { id: 'number', role: 'string' },
        });
        expect(server.callCount('/u')).toBe(1);
    });

    test('exits non-zero when the module has no drift-guarded stitches', async () => {
        const plain = stitch({ baseUrl: server.url, path: '/plain' });
        const { code, err } = await runGenerate({ plain });
        expect(code).toBe(1);
        expect(err).toContain('no drift-guarded stitches');
    });

    test('exits non-zero when --name does not resolve to a drift-guarded stitch', async () => {
        const file = join(snapDir(), 'x.contract.json');
        const a = stitch({
            baseUrl: server.url,
            path: '/a',
            output: drift(z.object({ id: z.number() }), { snapshotFile: file }),
        });
        const { code, err } = await runGenerate({ a }, ['--name', 'nope']);
        expect(code).toBe(1);
        expect(err).toContain('unknown stitch "nope"');
        expect(loadSnapshot(file)).toBeUndefined();
    });

    test('reports a failed run and exits non-zero without writing a baseline', async () => {
        server.route('GET', '/boom', { statuses: [500] });
        const file = join(snapDir(), 'boom.contract.json');
        const boom = stitch({
            baseUrl: server.url,
            path: '/boom',
            output: drift(z.object({ id: z.number() }), { snapshotFile: file }),
        });
        const { code, err } = await runGenerate({ boom });
        expect(code).toBe(1);
        expect(err).toContain('failed boom');
        expect(loadSnapshot(file)).toBeUndefined();
    });

    test('reports a run that yields no value (an unwrap that misses), not a crash', async () => {
        server.route('GET', '/empty', { body: { nope: 1 } });
        const file = join(snapDir(), 'empty.contract.json');
        const empty = stitch({
            baseUrl: server.url,
            path: '/empty',
            unwrap: 'data', // no `data` key on the body → the value is `undefined`
            output: drift(z.unknown(), { snapshotFile: file }),
        });
        const { code, err } = await runGenerate({ empty });
        expect(code).toBe(1);
        expect(err).toContain(
            'failed empty: run produced no value to baseline',
        );
        expect(loadSnapshot(file)).toBeUndefined();
    });

    test('bare `drift` (no subcommand) prints usage and exits 2', async () => {
        const err: string[] = [];
        const code = await main(['drift'], {
            cwd: '/',
            write: () => undefined,
            writeErr: (s) => err.push(s),
        });
        expect(code).toBe(2);
        expect(err.join('')).toContain('usage: stitch drift generate');
    });
});

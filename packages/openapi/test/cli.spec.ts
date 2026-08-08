// The ejector's write guard (#694 §1). Eject is not managed regeneration: once written, the tree
// belongs to the author, so a re-run may replace only what a PREVIOUS run put there — which
// `.stitch-gen.json` records. Anything else that already exists is the author's, and replacing it
// silently is data loss: the reported case lost a hand-added `drift(Order)` output, after which a
// response missing a `required` field started passing.
//
// Driven through `main(argv, io)` with an in-memory IO, in the style of core's `stitch init` specs.
// One test at the bottom runs against a REAL temp directory, so the default IO's existence probe is
// covered too rather than only the fake that stands in for it.
import { main } from '../src/cli';

import {
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SPEC = JSON.stringify({
    openapi: '3.0.0',
    info: { title: 'T', version: '1' },
    servers: [{ url: 'https://api.example.com' }],
    paths: {
        '/orders/{id}': {
            get: { operationId: 'getOrder', responses: { '200': {} } },
        },
    },
});

// The same document plus a second operation, so a later run wants a file that is already on disk.
const GROWN = JSON.stringify({
    ...(JSON.parse(SPEC) as Record<string, unknown>),
    paths: {
        '/orders/{id}': {
            get: { operationId: 'getOrder', responses: { '200': {} } },
        },
        '/orders': {
            get: { operationId: 'listOrders', responses: { '200': {} } },
        },
    },
});

// What an author's own client.ts looks like: edited, and nothing like the emitted one.
const MINE = "// mine\nexport const client = 'hand-written';\n";

const SPEC_PATH = 'openapi.json';
/** An emitted path as the fake filesystem keys it — `main` resolves against cwd + --out. */
const at = (p: string): string => resolve('/repo', 'out', p);

// A fake filesystem backing the CLI's IO: writeFile mutates the map, exists/readFileText read it.
// Returns the map (so a tree can be carried into a second run) plus captured stderr.
const runGen = (
    args: string[] = [],
    seed: Record<string, string> = { [SPEC_PATH]: SPEC },
) => {
    const files = new Map<string, string>(Object.entries(seed));
    const err: string[] = [];
    return main([SPEC_PATH, '--all', '--out', 'out', ...args], {
        cwd: '/repo',
        write: () => undefined,
        writeErr: (s) => err.push(s),
        readFileText: async (path) => {
            const v = files.get(path);
            if (v === undefined) throw new Error(`ENOENT: ${path}`);
            return v;
        },
        writeFile: async (path, contents) => {
            files.set(path, contents);
        },
        exists: async (path) => files.has(path),
    }).then((code) => ({ code, err: err.join(''), files }));
};

describe('cli — refusing to clobber a file it does not own (#694 §1)', () => {
    test('an existing file no manifest claims blocks the whole write, non-zero', async () => {
        const { code, err, files } = await runGen([], {
            [SPEC_PATH]: SPEC,
            [at('client.ts')]: MINE,
        });

        expect(code).not.toBe(0);
        expect(err).toMatch(/refusing to overwrite/);
        expect(err).toMatch(/client\.ts/); // names the file it would have destroyed
        expect(err).toMatch(/--force/); // and the way out
        // Nothing was written at all — not the manifest, not the operation files.
        expect(files.get(at('client.ts'))).toBe(MINE);
        expect([...files.keys()]).toEqual([SPEC_PATH, at('client.ts')]);
    });

    test('--force overwrites it', async () => {
        const { code, files } = await runGen(['--force'], {
            [SPEC_PATH]: SPEC,
            [at('client.ts')]: MINE,
        });

        expect(code).toBe(0);
        expect(files.get(at('client.ts'))).not.toBe(MINE);
        expect(files.get(at('client.ts'))).toMatch(/seam\(/);
        expect(files.has(at('.stitch-gen.json'))).toBe(true);
    });

    test('a file the manifest owns regenerates without --force', async () => {
        const first = await runGen();
        expect(first.code).toBe(0);
        const emitted = first.files.get(at('client.ts')) as string;

        // Carry that tree into a second run, with an owner's edit on top. It is still OURS by the
        // manifest, so the re-run replaces it — that is eject-and-diff (ADR 0013 Decision 1).
        const tree = Object.fromEntries(first.files);
        tree[at('client.ts')] = `${emitted}// edited by the owner\n`;
        const second = await runGen([], tree);

        expect(second.code).toBe(0);
        expect(second.err).not.toMatch(/refusing/);
        expect(second.files.get(at('client.ts'))).toBe(emitted);
        expect(second.files.get(at('get-order/index.ts'))).toMatch(
            /client\.stitch/,
        );
    });

    test('one unowned file blocks the write even when the rest of the tree is owned', async () => {
        const first = await runGen();
        // The spec grows an operation, and the author had already hand-written that file.
        const tree = Object.fromEntries(first.files);
        tree[SPEC_PATH] = GROWN;
        tree[at('list-orders/index.ts')] = MINE;

        const { code, err, files } = await runGen([], tree);

        expect(code).not.toBe(0);
        expect(err).toMatch(/list-orders\/index\.ts/);
        expect(err).not.toMatch(/get-order\/index\.ts/); // that one is ours; only the new file is not
        expect(files.get(at('list-orders/index.ts'))).toBe(MINE);
    });

    test('a manifest from before the `files` list still adopts the tree it generated', async () => {
        const first = await runGen();
        const tree = Object.fromEntries(first.files);
        // Strip the exact list, leaving the pre-guard shape (ownership graph only).
        const legacy = JSON.parse(
            tree[at('.stitch-gen.json')] as string,
        ) as Record<string, unknown>;
        delete legacy['files'];
        tree[at('.stitch-gen.json')] = JSON.stringify(legacy, null, 2);

        const { code, err } = await runGen([], tree);

        expect(code).toBe(0);
        expect(err).not.toMatch(/refusing/);
    });

    test('--dry-run writes nothing and the guard never fires', async () => {
        const { code, err, files } = await runGen(['--dry-run'], {
            [SPEC_PATH]: SPEC,
            [at('client.ts')]: MINE,
        });

        expect(code).toBe(0);
        expect(err).not.toMatch(/refusing/);
        expect([...files.keys()]).toEqual([SPEC_PATH, at('client.ts')]);
    });

    // End-to-end on a real directory: proves the default IO's existence probe sees a real file, so
    // the guard is not an artefact of the fake filesystem above.
    test('on a real directory, an author file survives the re-run untouched', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'stitch-openapi-'));
        try {
            await mkdir(join(dir, 'out'), { recursive: true });
            await writeFile(join(dir, 'openapi.json'), SPEC, 'utf8');
            await writeFile(join(dir, 'out', 'client.ts'), MINE, 'utf8');
            const err: string[] = [];

            const code = await main(
                [join(dir, 'openapi.json'), '--all', '--out', join(dir, 'out')],
                { write: () => undefined, writeErr: (s) => err.push(s) },
            );

            expect(code).not.toBe(0);
            expect(err.join('')).toMatch(/refusing to overwrite/);
            expect(await readFile(join(dir, 'out', 'client.ts'), 'utf8')).toBe(
                MINE,
            );
            expect(await readdir(join(dir, 'out'))).toEqual(['client.ts']);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

// `stitch-openapi` — eject a SELECTED set of operations from an OpenAPI document into ready-to-own
// stitch source (ADR 0013). Thin wrapper over the pure `planGen`: parse argv, read the spec (JSON
// natively; YAML via the `yaml` dependency, imported lazily), then write the files (or print them
// on --dry-run). Writing is guarded: a file the previous run's manifest does not claim belongs to
// the author, and is never overwritten without --force.
import {
    type GenOptions,
    MANIFEST_FILE,
    type OpenApiDoc,
    planGen,
} from './gen-openapi';

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const USAGE = `stitch-openapi — eject selected operations from an OpenAPI document into stitch source

usage:
  stitch-openapi <spec> --out <dir> [--all | --tag <t> | --only <id> | --grep <s>]
                 [--layout dir|flat] [--validator types-only] [--force] [--dry-run]

  <spec>            an OpenAPI 3.x document (JSON or YAML)
  --out, -o <dir>   output directory (required unless --dry-run)
  --all             generate every operation (otherwise pass a selector)
  --tag <t>         only operations with this tag (repeatable)
  --only <id>       only this operationId / export name (repeatable)
  --grep <substr>   only operations whose path contains this substring
  --layout dir|flat dir = one folder per operation (default); flat = one file per operation
  --validator <t>   types-only (default; v1). valibot/zod tiers are not implemented yet
  --force           overwrite files this ejector did not generate (it refuses by default)
  --dry-run         print the files to stdout instead of writing them

Ejects ready-to-own source you edit afterward: a client.ts seam, one stitch per operation typed
via stitch<T>(), atomic component types placed by fan-in (used by >=2 ops -> _shared/, by one ->
private to it), an index.ts, and a .stitch-gen.json ownership manifest. types-only emits no runtime
validation (a notice says so). Auth maps securitySchemes -> bearer/apiKey/basic with env()
placeholders; the secret is never emitted.
`;

interface Io {
    cwd: string;
    write: (s: string) => void;
    writeErr: (s: string) => void;
    readFileText: (path: string) => Promise<string>;
    writeFile: (path: string, contents: string) => Promise<void>;
    exists: (path: string) => Promise<boolean>;
}

function defaultIo(): Io {
    return {
        cwd: process.cwd(),
        write: (s) => process.stdout.write(s),
        writeErr: (s) => process.stderr.write(s),
        readFileText: (path) => readFile(path, 'utf8'),
        writeFile: async (path, contents) => {
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, contents, 'utf8');
        },
        exists: async (path) => {
            try {
                await access(path);
                return true;
            } catch {
                return false;
            }
        },
    };
}

function asArray(v: unknown): unknown[] {
    return Array.isArray(v) ? (v as unknown[]) : [];
}

/**
 * Paths (relative to --out) that a PREVIOUS run of this ejector wrote there, per the manifest it
 * left behind. Everything else on disk belongs to the author — an edited `client.ts`, a hand-written
 * helper — and is not ours to replace (#694 §1). No manifest means no previous run: own nothing.
 */
async function ownedPaths(io: Io, outDir: string): Promise<Set<string>> {
    const owned = new Set<string>();
    let raw: string;
    try {
        raw = await io.readFileText(resolve(outDir, MANIFEST_FILE));
    } catch {
        return owned;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw) as unknown;
    } catch {
        io.writeErr(
            `warning: ${MANIFEST_FILE} is not valid JSON; treating every existing file as yours\n`,
        );
        return owned;
    }
    const m = (
        typeof parsed === 'object' && parsed !== null ? parsed : {}
    ) as Record<string, unknown>;

    // The exact list, written by every run since the guard shipped.
    if (Array.isArray(m['files'])) {
        for (const p of asArray(m['files']))
            if (typeof p === 'string') owned.add(p);
        return owned;
    }
    // Older manifests predate that list but still record the ownership graph, so derive from it —
    // adopting a tree this ejector really did generate should not cost a blanket --force. The three
    // constants are emitted unconditionally by every run (client.ts, index.ts, the manifest itself).
    owned.add(MANIFEST_FILE);
    owned.add('client.ts');
    owned.add('index.ts');
    for (const e of [...asArray(m['operations']), ...asArray(m['schemas'])]) {
        const f = (e as { file?: unknown }).file;
        // A flat-layout private schema records `<op>.ts (inlined)` — a marker, not a path.
        if (typeof f === 'string' && f !== '' && !f.endsWith('(inlined)'))
            owned.add(f);
    }
    return owned;
}

export async function main(
    argv: string[],
    overrides: Partial<Io> = {},
): Promise<number> {
    const io: Io = { ...defaultIo(), ...overrides };
    if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
        io.write(USAGE);
        return argv.length === 0 ? 2 : 0;
    }

    let spec: string | undefined;
    let out: string | undefined;
    let dryRun = false;
    let force = false;
    const opts: GenOptions = {};
    const tags: string[] = [];
    const only: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === undefined) continue;
        if (a === '--out' || a === '-o') out = argv[++i];
        else if (a === '--all') opts.all = true;
        else if (a === '--tag') {
            const v = argv[++i];
            if (v) tags.push(v);
        } else if (a === '--only') {
            const v = argv[++i];
            if (v) only.push(v);
        } else if (a === '--grep') {
            const v = argv[++i];
            if (v) opts.grep = v;
        } else if (a === '--validator') {
            const v = argv[++i];
            if (v) opts.validator = v as NonNullable<GenOptions['validator']>;
        } else if (a === '--layout') {
            const v = argv[++i];
            if (v) opts.layout = v as NonNullable<GenOptions['layout']>;
        } else if (a === '--force') force = true;
        else if (a === '--dry-run') dryRun = true;
        else if (!a.startsWith('-') && spec === undefined) spec = a;
        else io.writeErr(`warning: ignored unknown arg: ${a}\n`);
    }
    if (tags.length) opts.tags = tags;
    if (only.length) opts.only = only;

    if (spec === undefined) {
        io.writeErr('missing <spec> file\n');
        return 2;
    }
    if (out === undefined && !dryRun) {
        io.writeErr('--out <dir> is required (or use --dry-run)\n');
        return 2;
    }

    let raw: string;
    try {
        raw = await io.readFileText(spec);
    } catch (e) {
        io.writeErr(`could not read ${spec}: ${(e as Error).message}\n`);
        return 1;
    }

    let doc: OpenApiDoc;
    try {
        if (/\.ya?ml$/i.test(spec)) {
            // Lazy so JSON-only runs never load the YAML parser; `yaml` is a real dependency.
            const { parse } = await import('yaml');
            doc = parse(raw) as OpenApiDoc;
        } else {
            doc = JSON.parse(raw) as OpenApiDoc;
        }
    } catch (e) {
        io.writeErr(`could not parse ${spec}: ${(e as Error).message}\n`);
        return 1;
    }

    const result = planGen(doc, opts);
    for (const n of result.notices) io.writeErr(`note: ${n}\n`);
    for (const w of result.warnings) io.writeErr(`warning: ${w}\n`);
    if (result.selected.length === 0) return 1;

    io.writeErr(`selected ${result.selected.length} operation(s):\n`);
    for (const s of result.selected)
        io.writeErr(`  ${s.method} ${s.path} -> ${s.name}\n`);

    if (dryRun) {
        for (const f of result.files) {
            io.write(`\n// ===== ${f.path} =====\n`);
            io.write(f.contents);
        }
        return 0;
    }

    const base = out as string;
    const outDir = resolve(io.cwd, base);

    // Eject, not managed regeneration (ADR 0013): the tree is the author's once written, so a re-run
    // may replace only what a previous run put there. Anything else that already exists is theirs.
    if (!force) {
        const owned = await ownedPaths(io, outDir);
        const clobbered: string[] = [];
        for (const f of result.files) {
            if (owned.has(f.path)) continue; // ours from last time — the normal regen path
            if (await io.exists(resolve(outDir, f.path)))
                clobbered.push(f.path);
        }
        if (clobbered.length > 0) {
            io.writeErr(
                `refusing to overwrite ${clobbered.length} file(s) in ${base} that this generator did not write (no record of them in ${MANIFEST_FILE}):\n`,
            );
            for (const p of clobbered) io.writeErr(`  ${p}\n`);
            io.writeErr(
                'Nothing was written. Eject into a scratch directory and diff (ADR 0013 Decision 1), or pass --force to overwrite them.\n',
            );
            return 1;
        }
    }

    for (const f of result.files)
        await io.writeFile(resolve(outDir, f.path), f.contents);
    io.writeErr(`wrote ${result.files.length} file(s) to ${base}\n`);
    return 0;
}

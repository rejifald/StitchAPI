// `stitch-openapi` — eject a SELECTED set of operations from an OpenAPI document into ready-to-own
// stitch source (ADR 0013). Thin wrapper over the pure `planGen`: parse argv, read the spec (JSON
// natively; YAML via a lazily-imported optional), then write the files (or print them on --dry-run).
import { type GenOptions, type OpenApiDoc, planGen } from './gen-openapi';

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const USAGE = `stitch-openapi — eject selected operations from an OpenAPI document into stitch source

usage:
  stitch-openapi <spec> --out <dir> [--all | --tag <t> | --only <id> | --grep <s>]
                 [--layout dir|flat] [--validator types-only] [--dry-run]

  <spec>            an OpenAPI 3.x document (JSON; YAML needs the optional \`yaml\` package)
  --out, -o <dir>   output directory (required unless --dry-run)
  --all             generate every operation (otherwise pass a selector)
  --tag <t>         only operations with this tag (repeatable)
  --only <id>       only this operationId / export name (repeatable)
  --grep <substr>   only operations whose path contains this substring
  --layout dir|flat dir = one folder per operation (default); flat = one file per operation
  --validator <t>   types-only (default; v1). valibot/zod tiers are not implemented yet
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
    };
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
        } else if (a === '--dry-run') dryRun = true;
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
            let yaml: { parse: (s: string) => unknown };
            try {
                // Runtime-computed specifier so the bundler leaves `yaml` as a true optional.
                const mod = ['ya', 'ml'].join('');
                yaml = (await import(mod)) as typeof yaml;
            } catch {
                io.writeErr(
                    'reading YAML needs the optional `yaml` package (run `npm i -D yaml`), or pass a JSON spec\n',
                );
                return 1;
            }
            doc = yaml.parse(raw) as OpenApiDoc;
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
    for (const f of result.files)
        await io.writeFile(resolve(io.cwd, base, f.path), f.contents);
    io.writeErr(`wrote ${result.files.length} file(s) to ${base}\n`);
    return 0;
}

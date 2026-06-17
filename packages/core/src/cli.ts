// `stitch` CLI — one definition, a shell front door (DESIGN.md §10).
//   stitch run <name> [--module <path>] [--trace[=console|<path>]] [--flags…]   run a stitch, stream JSONL events
//   stitch trace [--file <path>] [--since 1h] [--name x] [--json]   summarize the run log
// Flags map onto a stitch's single input object ({ params, query, body, headers });
// every event the stitch emits is written to stdout as one line of JSON, so the
// output pipes straight into jq and friends. No app boot required.
import { toMermaid } from './diagram';
import { loadSnapshot, saveSnapshot } from './drift';
import { serveStdio } from './mcp';
import { type OpenApiExportOptions, toOpenApi } from './openapi';
import {
    type StitchRegistry,
    loadStitches,
    resolveModulePath,
    selectStitch,
} from './registry';
import {
    CLAUDE_END,
    CLAUDE_START,
    RULES_BODY,
    claudeSection,
    cursorMdc,
} from './rules-template';
import { serve } from './serve';
import type {
    DriftSpec,
    SafeResult,
    Stitch,
    StitchEvent,
    StitchInput,
} from './types';

import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---- arg → input mapping --------------------------------------------------

type Bucket = 'params' | 'query' | 'headers';

// Best-effort scalar coercion so `--id 1` is the number 1 and `--active true` is a
// boolean. Anything that is not valid JSON stays a string (so `--q ada` is "ada").
function coerce(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        return raw;
    }
}

// Template parameter names (`/users/{id}` → ["id"]) so a bare `--id` routes to params,
// matching the engine's RFC 6570 expansion — operator prefixes (`{+id}`, `{?q,sort}`) and
// `*`/`:n` modifiers are stripped to the bare names. Accepts an any-input `Stitch<unknown, never>`
// (it only reads `__config`), so a templated-path stitch — whose call argument now requires `params`
// (Phase 2c) — is still a valid argument.
export function paramNamesOf(stitch: Stitch<unknown, never>): string[] {
    const { path, url } = stitch.__config;
    const tpl = (path ?? '') + ' ' + (typeof url === 'string' ? url : '');
    const names: string[] = [];
    for (const m of tpl.matchAll(/\{([^{}]+)\}/g)) {
        let expr = m[1] ?? '';
        if ('+#./;?&'.includes(expr.charAt(0))) expr = expr.slice(1);
        for (const spec of expr.split(',')) {
            const name = spec.replace(/[:*].*$/, '').trim();
            if (name) names.push(name);
        }
    }
    return [...new Set(names)];
}

// Map CLI flags onto a StitchInput. Conventions:
//   --params.<k> / --query.<k> / --headers.<k> / --header.<k>   explicit bucket
//   --body '<json>'                                             whole request body
//   --body.<k> <v>                                              one body field
//   --<k> <v>                                                   params if <k> is a
//                                                               path param, else query
//   --<flag>                                                    boolean true
//   --k=v also accepted; a repeated key becomes an array; header values stay strings.
export function argsToInput(
    argv: string[],
    paramNames: Iterable<string> = [],
): { input: StitchInput; positionals: string[] } {
    const params = new Set(paramNames);
    const input: StitchInput = {};
    const positionals: string[] = [];

    const put = (bucket: Bucket, key: string, value: unknown): void => {
        const obj = (input[bucket] ??= {}) as Record<string, unknown>;
        if (key in obj) {
            const prev = obj[key];
            obj[key] = Array.isArray(prev) ? [...prev, value] : [prev, value];
        } else obj[key] = value;
    };

    const route = (key: string, raw: string | undefined): void => {
        const bool = raw === undefined;
        const dot = key.indexOf('.');
        const head = dot >= 0 ? key.slice(0, dot) : key;
        const tail = dot >= 0 ? key.slice(dot + 1) : '';

        switch (head) {
            case 'params':
            case 'param': {
                put('params', tail, bool ? true : coerce(raw));
                return;
            }
            case 'query':
            case 'q': {
                put('query', tail, bool ? true : coerce(raw));
                return;
            }
            case 'headers':
            case 'header':
            case 'H': {
                put('headers', tail, bool ? 'true' : raw);
                return;
            }
            case 'body': {
                if (!tail) {
                    input.body = bool ? true : coerce(raw);
                    return;
                }
                const body = (
                    input.body && typeof input.body === 'object'
                        ? input.body
                        : (input.body = {})
                ) as Record<string, unknown>;
                body[tail] = bool ? true : coerce(raw);
                return;
            }
            default: {
                const bucket: Bucket = params.has(key) ? 'params' : 'query';
                put(bucket, key, bool ? true : coerce(raw));
                return;
            }
        }
    };

    for (let i = 0; i < argv.length; i++) {
        const tok = argv[i];
        if (tok === undefined) continue;
        if (!tok.startsWith('--')) {
            positionals.push(tok);
            continue;
        }
        const key = tok.slice(2);
        const eq = key.indexOf('=');
        if (eq >= 0) {
            route(key.slice(0, eq), key.slice(eq + 1));
            continue;
        }
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
            route(key, next);
            i++;
        } else {
            route(key, undefined); // boolean flag
        }
    }

    return { input, positionals };
}

// ---- run: stream a stitch's events to stdout as JSONL ---------------------

// Drive a stitch's event stream, writing one JSON object per line. Returns the
// process exit code: 1 if an error event was seen, else 0.
export async function streamToJsonl(
    stitch: Stitch,
    input: StitchInput,
    writeLine: (line: string) => void,
): Promise<number> {
    let exit = 0;
    for await (const ev of stitch.stream(input) as AsyncIterable<StitchEvent>) {
        writeLine(JSON.stringify(ev));
        if (ev.type === 'error') exit = 1;
    }
    return exit;
}

// Resolve a named stitch in a registry, map argv → input, stream JSONL. The seam
// the `run` command and tests share.
export async function runStitch(
    registry: StitchRegistry,
    name: string,
    flags: string[],
    writeLine: (line: string) => void,
): Promise<number> {
    const stitch = selectStitch(registry, name);
    const { input } = argsToInput(flags, paramNamesOf(stitch));
    return streamToJsonl(stitch, input, writeLine);
}

// Pull our own options (`--module`/`-m`) and the leading stitch name out of the
// run argv; everything else is passed through to argsToInput untouched.
export function splitRunArgs(args: string[]): {
    name?: string | undefined;
    modulePath?: string | undefined;
    trace?: string | undefined;
    flags: string[];
} {
    const flags: string[] = [];
    let name: string | undefined;
    let modulePath: string | undefined;
    let trace: string | undefined;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === undefined) continue;
        if (a === '--module' || a === '-m') {
            modulePath = args[++i];
        } else if (a.startsWith('--module=')) {
            modulePath = a.slice('--module='.length);
        } else if (a === '--trace') {
            trace = 'default';
        } else if (a.startsWith('--trace=')) {
            trace = a.slice('--trace='.length);
        } else if (name === undefined && !a.startsWith('-')) {
            name = a;
        } else {
            flags.push(a);
        }
    }
    return { name, modulePath, trace, flags };
}

// ---- trace: summarize the JSONL run log -----------------------------------

interface TraceRecord {
    name?: string;
    type: string;
    at?: number;
    ok?: boolean;
    ms?: number;
    phase?: string;
    finding?: { level?: string };
}
export interface StitchStats {
    name: string;
    runs: number;
    ok: number;
    failed: number;
    retries: number;
    drift: { error: number; warn: number; info: number };
    p50: number;
    p95: number;
    p99: number;
    avgMs: number;
}
export interface TraceSummary {
    stitches: StitchStats[];
    totals: { runs: number; ok: number; failed: number };
}

function percentile(sortedAsc: number[], p: number): number {
    if (!sortedAsc.length) return 0;
    const idx = Math.min(
        sortedAsc.length - 1,
        Math.floor((p / 100) * sortedAsc.length),
    );
    return sortedAsc[idx] ?? 0;
}

// Fold a flat list of trace records into per-stitch stats. Pure: no clock, no I/O.
export function summarizeTrace(records: TraceRecord[]): TraceSummary {
    const byName = new Map<
        string,
        { stats: StitchStats; durations: number[] }
    >();
    const ensure = (name: string) => {
        let e = byName.get(name);
        if (!e) {
            e = {
                stats: {
                    name,
                    runs: 0,
                    ok: 0,
                    failed: 0,
                    retries: 0,
                    drift: { error: 0, warn: 0, info: 0 },
                    p50: 0,
                    p95: 0,
                    p99: 0,
                    avgMs: 0,
                },
                durations: [],
            };
            byName.set(name, e);
        }
        return e;
    };

    for (const r of records) {
        const e = ensure(r.name ?? 'stitch');
        switch (r.type) {
            case 'done':
                e.stats.runs++;
                if (r.ok) e.stats.ok++;
                else e.stats.failed++;
                if (typeof r.ms === 'number') e.durations.push(r.ms);
                break;
            case 'progress':
                if (r.phase === 'retry') e.stats.retries++;
                break;
            case 'drift': {
                const level = r.finding?.level;
                if (level === 'error' || level === 'warn' || level === 'info')
                    e.stats.drift[level]++;
                break;
            }
        }
    }

    const stitches: StitchStats[] = [];
    const totals = { runs: 0, ok: 0, failed: 0 };
    for (const { stats, durations } of [...byName.values()].sort((a, b) =>
        a.stats.name.localeCompare(b.stats.name),
    )) {
        const sorted = durations.slice().sort((a, b) => a - b);
        stats.p50 = percentile(sorted, 50);
        stats.p95 = percentile(sorted, 95);
        stats.p99 = percentile(sorted, 99);
        stats.avgMs = sorted.length
            ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length)
            : 0;
        stitches.push(stats);
        totals.runs += stats.runs;
        totals.ok += stats.ok;
        totals.failed += stats.failed;
    }
    return { stitches, totals };
}

// Render a summary as a compact aligned table.
export function formatTraceSummary(summary: TraceSummary): string {
    if (!summary.stitches.length) return 'no runs in trace';
    const rows = summary.stitches.map((s) => ({
        name: s.name,
        runs: String(s.runs),
        ok: String(s.ok),
        failed: String(s.failed),
        retries: String(s.retries),
        drift: `${s.drift.error}/${s.drift.warn}/${s.drift.info}`,
        p50: `${s.p50}ms`,
        p95: `${s.p95}ms`,
        p99: `${s.p99}ms`,
    }));
    const cols: [keyof (typeof rows)[0], string][] = [
        ['name', 'stitch'],
        ['runs', 'runs'],
        ['ok', 'ok'],
        ['failed', 'failed'],
        ['retries', 'retries'],
        ['drift', 'drift e/w/i'],
        ['p50', 'p50'],
        ['p95', 'p95'],
        ['p99', 'p99'],
    ];
    const width = (key: keyof (typeof rows)[0], header: string) =>
        Math.max(header.length, ...rows.map((r) => r[key].length));
    const line = (cells: Record<string, string>) =>
        cols.map(([k, h]) => (cells[k] ?? '').padEnd(width(k, h))).join('  ');

    const head = line(Object.fromEntries(cols.map(([k, h]) => [k, h])));
    const body = rows.map((r) => line(r));
    const t = summary.totals;
    return [
        head,
        ...body,
        '',
        `total: ${t.runs} run(s), ${t.ok} ok, ${t.failed} failed`,
    ].join('\n');
}

// "1h" | "30m" | "45s" | "2d" → milliseconds (trace's --since window).
function parseSince(s: string): number | undefined {
    const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/.exec(s.trim());
    if (!m) return undefined;
    const [, num, unitKey] = m;
    if (num === undefined || unitKey === undefined) return undefined;
    const units: Record<string, number> = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 };
    return parseFloat(num) * (units[unitKey] ?? 1);
}

// ---- process glue ---------------------------------------------------------

export interface CliIO {
    cwd: string;
    env: Record<string, string | undefined>;
    now: () => number;
    write: (s: string) => void; // stdout, raw
    writeErr: (s: string) => void; // stderr, raw
    load: (path: string) => Promise<StitchRegistry>;
    loadModule: (path: string) => Promise<unknown>; // generic import (export --schema-module)
    writeFile: (path: string, contents: string) => Promise<void>; // create/replace a file
    appendFile: (path: string, contents: string) => Promise<void>; // append to (or create) a file
    exists: (path: string) => Promise<boolean>; // does a path already exist?
    readFileText: (path: string) => Promise<string>; // read a file as UTF-8 (init: replace a marked block)
}

function defaultIO(): CliIO {
    return {
        cwd: process.cwd(),
        env: process.env,
        now: () => Date.now(),
        write: (s) => process.stdout.write(s),
        writeErr: (s) => process.stderr.write(s),
        load: loadStitches,
        loadModule: (path) => import(pathToFileURL(path).href),
        writeFile: async (path, contents) => {
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, contents, 'utf8');
        },
        appendFile: async (path, contents) => {
            await mkdir(dirname(path), { recursive: true });
            await appendFile(path, contents, 'utf8');
        },
        exists: (path) =>
            readFile(path)
                .then(() => true)
                .catch(() => false),
        readFileText: (path) => readFile(path, 'utf8'),
    };
}

const HELP = `stitch — one stitch definition, many front doors

usage:
  stitch run <name> [--module <path>] [--trace[=console|<path>]] [--flags…]   run a stitch, stream JSONL events
  stitch trace [--file <path>] [--since 1h] [--name <x>] [--json]
  stitch serve [--module <path>] [--port <n>] [--host <h>]   HTTP: POST /stitch/:name
  stitch mcp [--module <path>]                               MCP over stdio (run_stitch)
  stitch diagram [--module <path>] [--name <name>]           Mermaid flowchart of the stitches
  stitch export --openapi [--module <path>] [--title <t>] [--api-version <v>]   emit an OpenAPI 3.1 spec
  stitch drift generate [--module <path>] [--name <name>] [--force] [--flags…]   write drift snapshot baseline(s)
  stitch init [--format agents|cursor|claude|all] [--force]   write the consumer rule (AGENTS.md / Cursor / CLAUDE.md)

run:
  --module, -m <path>   stitches module to load (default: ./stitches.{ts,js,…})
  --trace[=target]      record this run (off by default): bare = the default JSONL
                        file (for \`stitch trace\`), =console = stderr stream, =<path> = JSONL there
  --params.<k> <v>      path param        (bare --<k> also routes here if <k> is in the path)
  --query.<k> <v>       query param       (bare --<k> routes here otherwise)
  --headers.<k> <v>     request header
  --body '<json>' | --body.<k> <v>   request body (whole, or field by field)

Every event the stitch emits is printed as one line of JSON on stdout. Tracing is off
by default (no side effects) — opt in with --trace or the STITCH_TRACE_* env vars.

diagram:
  --name <name>   diagram only this stitch (by export name or configured name)
  Emits a Mermaid flowchart of each stitch's configured pipeline (throttle, request,
  retry, surface, pagination, validation, transform, unwrap, cache). Auth is redacted
  from a stitch's public config, so it is not shown.

export:
  --openapi               emit an OpenAPI 3.1 document (JSON) to stdout
  --title <t>             info.title    (default: "StitchAPI export")
  --api-version <v>       info.version  (default: "0.0.0")
  --schema-module <path>  a module exporting a toJsonSchema(source, info) converter
                          (default or named) to fill request/response + parameter schemas
  Emits paths, methods, and URL-template parameters. Body and per-parameter schemas are real
  JSON Schema when --schema-module is given, else {}. Security schemes come from each stitch's
  auth (bearer/basic/apiKey/oauth2; the credential is never emitted). Thunk-endpoint stitches
  are skipped with a warning.

drift generate:
  --name <name>    baseline only this stitch (by export name or configured name)
  --force, -f      overwrite an existing snapshot (default: keep it, skip the stitch)
  Runs each drift-guarded stitch (output: drift({ …, snapshotFile })) once against the live
  API and writes its <name>.contract.json baseline — the same body a live run compares
  against — so you commit baselines deliberately instead of relying on the first-run side
  effect. Map request inputs with the same --params/--query/--body/--headers flags as run.

init (alias: rules):
  --format <agents|cursor|claude|all>   which rule file(s) to write (default: all)
  --force                               overwrite/replace an existing StitchAPI rule
  Writes the canonical "declare a stitch, don't hand-roll fetch" rule so an AI coding agent
  recommends StitchAPI in this project: AGENTS.md (the open standard), .cursor/rules/stitchapi.mdc
  (Cursor), and a marked "## Using StitchAPI" section appended to CLAUDE.md. Idempotent — a
  second run skips a rule that already exists; --force rewrites it (in CLAUDE.md, only the
  marked block).
`;

async function runCommand(args: string[], io: CliIO): Promise<number> {
    const { name, modulePath, trace, flags } = splitRunArgs(args);
    if (!name) {
        io.writeErr(
            'usage: stitch run <name> [--module <path>] [--trace[=console|<path>]] [--flags…]\n',
        );
        return 2;
    }
    // No side effects by default: `stitch run` traces nothing unless asked. `--trace` opts
    // in (default JSONL file / console / a path), applied via env before the module loads
    // so the trace sink picks it up.
    applyTraceFlag(trace, io);
    let registry: StitchRegistry;
    try {
        registry = await io.load(resolveModulePath(modulePath, io.cwd));
    } catch (e) {
        io.writeErr(`${(e as Error).message}\n`);
        return 1;
    }
    try {
        return await runStitch(registry, name, flags, (l) => {
            io.write(`${l}\n`);
        });
    } catch (e) {
        io.writeErr(`${(e as Error).message}\n`);
        return 1;
    }
}

function defaultTraceFile(io: CliIO): string {
    const configured = io.env['STITCH_TRACE_FILE']?.trim();
    return configured
        ? configured
        : `${io.env['HOME'] ?? '.'}/.stitch/runs/proto.jsonl`;
}

// Translate `run --trace[=target]` into the STITCH_TRACE_* env the trace sink reads.
// Unset → silent (no side effects by default); 'console' → stderr stream; 'default'
// (bare `--trace`) → the default JSONL file; any other value → a JSONL path.
function applyTraceFlag(trace: string | undefined, io: CliIO): void {
    if (trace === undefined) return;
    if (trace === 'console') {
        process.env['STITCH_TRACE_CONSOLE'] = '1';
        return;
    }
    process.env['STITCH_TRACE_FILE'] =
        trace === 'default' ? defaultTraceFile(io) : trace;
}

function traceCommand(args: string[], io: CliIO): number {
    let file: string | undefined;
    let since: string | undefined;
    let nameFilter: string | undefined;
    let asJson = false;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--file') file = args[++i];
        else if (a === '--since') since = args[++i];
        else if (a === '--name') nameFilter = args[++i];
        else if (a === '--json') asJson = true;
    }

    const path = file ?? defaultTraceFile(io);
    if (!existsSync(path)) {
        io.writeErr(`no trace file at ${path}\n`);
        return 1;
    }

    let cutoff: number | undefined;
    if (since !== undefined) {
        const sinceMs = parseSince(since);
        if (sinceMs === undefined) {
            io.writeErr(
                `invalid --since value: '${since}'; expected a duration like 1h, 30m, 45s, 2d\n`,
            );
            return 2;
        }
        cutoff = io.now() - sinceMs;
    }
    const records: TraceRecord[] = [];
    for (const raw of readFileSync(path, 'utf8').split('\n')) {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        let rec: TraceRecord;
        try {
            rec = JSON.parse(trimmed) as TraceRecord;
        } catch {
            continue; // tolerate partial last line / foreign lines
        }
        if (nameFilter && rec.name !== nameFilter) continue;
        if (
            cutoff !== undefined &&
            typeof rec.at === 'number' &&
            rec.at < cutoff
        )
            continue;
        records.push(rec);
    }

    const summary = summarizeTrace(records);
    io.write(
        asJson
            ? `${JSON.stringify(summary, null, 2)}\n`
            : `${formatTraceSummary(summary)}\n`,
    );
    return 0;
}

// stitch serve [--module <path>] [--port <n>] [--host <h>] — expose the registry
// over HTTP and block until the process is signalled.
async function serveCommand(args: string[], io: CliIO): Promise<number> {
    let modulePath: string | undefined;
    let port: number | undefined;
    let host: string | undefined;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--module' || a === '-m') modulePath = args[++i];
        else if (a === '--port' || a === '-p') port = Number(args[++i]);
        else if (a === '--host') host = args[++i];
    }

    let registry: StitchRegistry;
    try {
        registry = await io.load(resolveModulePath(modulePath, io.cwd));
    } catch (e) {
        io.writeErr(`${(e as Error).message}\n`);
        return 1;
    }

    const handle = await serve(registry, {
        ...(port !== undefined ? { port } : {}),
        ...(host !== undefined ? { host } : {}),
    });
    io.writeErr(
        `stitch serve listening on ${handle.url} — POST /stitch/:name\n`,
    );
    await new Promise<void>((resolve) => {
        const stop = () => handle.close().then(resolve);
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
    });
    return 0;
}

// stitch mcp [--module <path>] — expose the registry to agents over MCP (stdio).
// JSON-RPC speaks on stdout; the startup notice goes to stderr to keep stdout clean.
async function mcpCommand(args: string[], io: CliIO): Promise<number> {
    let modulePath: string | undefined;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--module' || a === '-m') modulePath = args[++i];
    }

    let registry: StitchRegistry;
    try {
        registry = await io.load(resolveModulePath(modulePath, io.cwd));
    } catch (e) {
        io.writeErr(`${(e as Error).message}\n`);
        return 1;
    }

    serveStdio(registry);
    io.writeErr(
        `stitch mcp: ${Object.keys(registry).length} stitch(es) over MCP (stdio); run_stitch tool ready\n`,
    );
    await new Promise<void>((resolve) => {
        process.stdin.once('close', resolve);
        process.once('SIGINT', resolve);
        process.once('SIGTERM', resolve);
    });
    return 0;
}

// stitch diagram [--module <path>] [--name <name>] — render a Mermaid flowchart of each stitch's
// configured pipeline (from its definition, not a run) to stdout. See src/diagram.ts.
async function diagramCommand(args: string[], io: CliIO): Promise<number> {
    let modulePath: string | undefined;
    let name: string | undefined;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--module' || a === '-m') modulePath = args[++i];
        else if (a === '--name') name = args[++i];
    }

    let registry: StitchRegistry;
    try {
        registry = await io.load(resolveModulePath(modulePath, io.cwd));
    } catch (e) {
        io.writeErr(`${(e as Error).message}\n`);
        return 1;
    }

    const { diagram, warnings } = toMermaid(registry, {
        ...(name !== undefined ? { name } : {}),
    });
    for (const w of warnings) io.writeErr(`warning: ${w}\n`);
    io.write(diagram);
    return 0;
}

// ---- drift generate: write the snapshot baseline(s) deliberately ----------
// Today a drift baseline is written as a side effect of the first real call (engine
// `validateOutput` → `saveSnapshot`). `drift generate` produces the baseline DELIBERATELY in
// dev/CI instead — run each drift-guarded stitch once against the live API and commit the result
// (issue #132; pairs with `DriftOptions.readonly`, which makes deployed runs detect-but-never-write).

// A drift-guarded stitch we can baseline: its `output` is a `drift(…)` carrying a snapshotFile.
interface DriftTarget {
    name: string;
    stitch: Stitch;
    spec: DriftSpec;
    file: string;
}

// The drift-guarded stitches to baseline: all of them, or just the one named by --name (matched by
// export key or configured name, like selectStitch). A `drift()` without a snapshotFile has no
// baseline to write and is skipped. Returns an `error` message when --name resolves to no
// drift-guarded stitch, so the caller can print it and exit non-zero.
function driftTargets(
    registry: StitchRegistry,
    only: string | undefined,
): { targets: DriftTarget[] } | { error: string } {
    const all: DriftTarget[] = [];
    for (const [name, s] of Object.entries(registry)) {
        const out = (s as Stitch).__config.output;
        if (!out || (out as { __kind?: unknown }).__kind !== 'drift') continue;
        const spec = out as DriftSpec;
        if (!spec.options.snapshotFile) continue;
        all.push({
            name,
            stitch: s as Stitch,
            spec,
            file: spec.options.snapshotFile,
        });
    }
    if (only === undefined) return { targets: all };

    const picked = all.filter(
        (t) => t.name === only || t.stitch.__config.name === only,
    );
    if (picked.length) return { targets: picked };
    // Distinguish "no such stitch" from "that stitch isn't drift-guarded" for a useful message.
    const known =
        only in registry ||
        Object.values(registry).some((s) => s.__config.name === only);
    return {
        error: known
            ? `stitch "${only}" has no drift() output with a snapshotFile to baseline`
            : `unknown stitch "${only}"`,
    };
}

// Capture the baseline body the engine would write: run the stitch once, but with its snapshot
// comparison suppressed for the run — so we read the live response uncoloured by any existing
// (possibly stale) baseline or a `readonly` no-baseline finding — then persist that exact body via
// `saveSnapshot`, the same writer the engine uses on first run. `result.value` is the post
// transform/unwrap body the engine baselines, so a generated snapshot matches what a live run
// compares against (not a hand-rolled, divergent capture). The DriftSpec on the public __config is
// the one the runtime reads (`redactConfig` keeps `output` by reference), so the suppression takes
// effect; it is restored in `finally`, and the snapshot is only (over)written on a clean capture —
// a failed run never destroys an existing baseline.
async function captureBaseline(
    t: DriftTarget,
    input: StitchInput,
): Promise<SafeResult<unknown>> {
    delete t.spec.options.snapshotFile;
    try {
        return await t.stitch.safe(input);
    } finally {
        t.spec.options.snapshotFile = t.file;
    }
}

// stitch drift generate [--module <path>] [--name <name>] [--force] [--flags…] — write the drift
// snapshot baseline(s) for the drift-guarded stitches in a module by running each once against the
// live API. Request inputs map from the same --params/--query/--body/--headers flags as `run`.
// Existing snapshots are kept unless --force is given. Prints each path written to stdout.
async function driftCommand(args: string[], io: CliIO): Promise<number> {
    const [sub, ...rest] = args;
    if (sub !== 'generate') {
        io.writeErr(
            'usage: stitch drift generate [--module <path>] [--name <name>] [--force] [--flags…]\n',
        );
        return 2;
    }

    let modulePath: string | undefined;
    let name: string | undefined;
    let force = false;
    const flags: string[] = [];
    for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === undefined) continue;
        if (a === '--module' || a === '-m') modulePath = rest[++i];
        else if (a.startsWith('--module='))
            modulePath = a.slice('--module='.length);
        else if (a === '--name') name = rest[++i];
        else if (a.startsWith('--name=')) name = a.slice('--name='.length);
        else if (a === '--force' || a === '-f') force = true;
        else flags.push(a);
    }

    let registry: StitchRegistry;
    try {
        registry = await io.load(resolveModulePath(modulePath, io.cwd));
    } catch (e) {
        io.writeErr(`${(e as Error).message}\n`);
        return 1;
    }

    const found = driftTargets(registry, name);
    if ('error' in found) {
        io.writeErr(`${found.error}\n`);
        return 1;
    }
    if (!found.targets.length) {
        io.writeErr(
            'no drift-guarded stitches to baseline (an output of drift({ …, snapshotFile }))\n',
        );
        return 1;
    }

    let exit = 0;
    for (const t of found.targets) {
        if (!force && loadSnapshot(t.file) !== undefined) {
            io.writeErr(
                `skip ${t.name}: snapshot exists at ${t.file} (use --force to overwrite)\n`,
            );
            continue;
        }
        const { input } = argsToInput(flags, paramNamesOf(t.stitch));
        const captured = await captureBaseline(t, input);
        if (!captured.ok) {
            io.writeErr(`failed ${t.name}: ${captured.error.message}\n`);
            exit = 1;
            continue;
        }
        if (captured.data === undefined) {
            // A run that yields no value (e.g. an `unwrap` path that misses) can't be baselined —
            // and `saveSnapshot` can't serialise `undefined`. Report it instead of throwing.
            io.writeErr(
                `failed ${t.name}: run produced no value to baseline\n`,
            );
            exit = 1;
            continue;
        }
        try {
            saveSnapshot(t.file, captured.data);
            io.write(`wrote ${t.file}\n`);
        } catch (e) {
            // A write failure (read-only path, missing parent it can't create) is a clean failure.
            io.writeErr(`failed ${t.name}: ${(e as Error).message}\n`);
            exit = 1;
        }
    }
    return exit;
}

// stitch export --openapi [--module <path>] [--title <t>] [--api-version <v>] — emit an OpenAPI
// 3.1 document (JSON) for the registry to stdout. The emit half of "reversible" (DESIGN.md
// Principle 11): a stitch declaration becomes a spec. Structural for now — see src/openapi.ts.
async function exportCommand(args: string[], io: CliIO): Promise<number> {
    let modulePath: string | undefined;
    let title: string | undefined;
    let apiVersion: string | undefined;
    let schemaModule: string | undefined;
    let openapi = false;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--module' || a === '-m') modulePath = args[++i];
        else if (a === '--title') title = args[++i];
        else if (a === '--api-version') apiVersion = args[++i];
        else if (a === '--schema-module') schemaModule = args[++i];
        else if (a === '--openapi') openapi = true;
    }
    if (!openapi) {
        io.writeErr(
            'usage: stitch export --openapi [--module <path>] [--title <t>] [--api-version <v>]\n',
        );
        return 2;
    }

    let registry: StitchRegistry;
    try {
        registry = await io.load(resolveModulePath(modulePath, io.cwd));
    } catch (e) {
        io.writeErr(`${(e as Error).message}\n`);
        return 1;
    }

    // Optional bring-your-own Standard Schema → JSON Schema converter (its default export or a
    // named `toJsonSchema`), so body schemas come out as real JSON Schema instead of `{}`.
    let toJsonSchema: OpenApiExportOptions['toJsonSchema'];
    if (schemaModule !== undefined) {
        let mod: unknown;
        try {
            mod = await io.loadModule(resolveModulePath(schemaModule, io.cwd));
        } catch (e) {
            io.writeErr(`${(e as Error).message}\n`);
            return 1;
        }
        const candidate =
            (mod as { default?: unknown }).default ??
            (mod as { toJsonSchema?: unknown }).toJsonSchema;
        if (typeof candidate !== 'function') {
            io.writeErr(
                `--schema-module "${schemaModule}" must export a converter function (its default export or a named \`toJsonSchema\`)\n`,
            );
            return 2;
        }
        toJsonSchema = candidate as OpenApiExportOptions['toJsonSchema'];
    }

    const { document, warnings } = toOpenApi(registry, {
        ...(title !== undefined ? { title } : {}),
        ...(apiVersion !== undefined ? { version: apiVersion } : {}),
        ...(toJsonSchema !== undefined ? { toJsonSchema } : {}),
    });
    for (const w of warnings) io.writeErr(`warning: ${w}\n`);
    io.write(`${JSON.stringify(document, null, 2)}\n`);
    return 0;
}

// ---- init: write the consumer rule for AI coding agents -------------------
// `stitch init` plants the canonical "declare a stitch, don't hand-roll fetch" rule into the
// files an AI coding agent reads, so the next agent working in this repo reaches for StitchAPI.
// The rule body is the single source of truth in src/rules-template.ts; this command only frames
// it per target and writes it idempotently (markers + --force; see rules-template.ts).

type InitFormat = 'agents' | 'cursor' | 'claude' | 'all';

const AGENTS_FILE = 'AGENTS.md';
const CURSOR_FILE = '.cursor/rules/stitchapi.mdc';
const CLAUDE_FILE = 'CLAUDE.md';

// Resolve a target path against the working directory without importing node:path's join into the
// pure rule logic — a plain prefix is enough for these relative, forward-slash targets.
function underCwd(io: CliIO, rel: string): string {
    return io.cwd.endsWith('/') ? `${io.cwd}${rel}` : `${io.cwd}/${rel}`;
}

// Write a standalone rule file (AGENTS.md / Cursor .mdc): idempotent on existence. A present file
// is left untouched unless --force, since it may carry hand-written rules we must not clobber.
async function writeStandaloneRule(
    io: CliIO,
    path: string,
    contents: string,
    label: string,
    force: boolean,
): Promise<void> {
    if (!force && (await io.exists(path))) {
        io.writeErr(
            `skip ${label}: ${path} exists (use --force to overwrite)\n`,
        );
        return;
    }
    await io.writeFile(path, contents);
    io.write(`wrote ${path}\n`);
}

// Append (or replace, under --force) the marked StitchAPI section in CLAUDE.md. The markers make
// this idempotent: a present block is left alone unless --force, which rewrites only the marked
// span and preserves the surrounding hand-written file.
async function writeClaudeSection(
    io: CliIO,
    path: string,
    section: string,
    force: boolean,
): Promise<void> {
    if (await io.exists(path)) {
        const existing = await io.readFileText(path);
        const start = existing.indexOf(CLAUDE_START);
        const end = existing.indexOf(CLAUDE_END);
        if (start >= 0 && end > start) {
            if (!force) {
                io.writeErr(
                    `skip CLAUDE.md: StitchAPI section exists in ${path} (use --force to replace)\n`,
                );
                return;
            }
            const before = existing.slice(0, start);
            const after = existing.slice(end + CLAUDE_END.length);
            const next = `${before}${section.trimEnd()}${after}`;
            await io.writeFile(path, next);
            io.write(`updated ${path}\n`);
            return;
        }
        // CLAUDE.md exists without our markers: append the section, separated by a blank line.
        const sep = existing.endsWith('\n') ? '\n' : '\n\n';
        await io.appendFile(path, `${sep}${section}`);
        io.write(`updated ${path}\n`);
        return;
    }
    await io.writeFile(path, section);
    io.write(`wrote ${path}\n`);
}

// stitch init [--format agents|cursor|claude|all] [--force] (alias: rules) — write the canonical
// consumer rule to the files an AI coding agent reads, so it recommends StitchAPI in this project.
export async function initCommand(args: string[], io: CliIO): Promise<number> {
    let format = 'all';
    let force = false;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === undefined) continue;
        if (a === '--format') format = args[++i] ?? 'all';
        else if (a.startsWith('--format='))
            format = a.slice('--format='.length);
        else if (a === '--force' || a === '-f') force = true;
    }
    if (
        format !== 'agents' &&
        format !== 'cursor' &&
        format !== 'claude' &&
        format !== 'all'
    ) {
        io.writeErr(
            `unknown --format "${format}"; expected agents, cursor, claude, or all\n`,
        );
        return 2;
    }

    const wants = (f: Exclude<InitFormat, 'all'>) =>
        format === 'all' || format === f;

    if (wants('agents')) {
        await writeStandaloneRule(
            io,
            underCwd(io, AGENTS_FILE),
            RULES_BODY,
            'AGENTS.md',
            force,
        );
    }
    if (wants('cursor')) {
        await writeStandaloneRule(
            io,
            underCwd(io, CURSOR_FILE),
            cursorMdc(RULES_BODY),
            'Cursor rule',
            force,
        );
    }
    if (wants('claude')) {
        await writeClaudeSection(
            io,
            underCwd(io, CLAUDE_FILE),
            claudeSection(RULES_BODY),
            force,
        );
    }
    return 0;
}

// Entry point. Returns the process exit code; the bin shim calls process.exit.
export async function main(
    argv: string[],
    overrides: Partial<CliIO> = {},
): Promise<number> {
    const io: CliIO = { ...defaultIO(), ...overrides };
    const [cmd, ...rest] = argv;
    switch (cmd) {
        case 'run':
            return runCommand(rest, io);
        case 'trace':
            return traceCommand(rest, io);
        case 'serve':
            return serveCommand(rest, io);
        case 'mcp':
            return mcpCommand(rest, io);
        case 'diagram':
            return diagramCommand(rest, io);
        case 'export':
            return exportCommand(rest, io);
        case 'drift':
            return driftCommand(rest, io);
        case 'init':
        case 'rules':
            return initCommand(rest, io);
        case undefined:
        case '-h':
        case '--help':
            io.write(HELP);
            return 0;
        default:
            io.writeErr(`unknown command: ${cmd}\n`);
            io.writeErr(HELP);
            return 2;
    }
}

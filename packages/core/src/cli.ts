// `stitch` CLI — one definition, a shell front door (DESIGN.md §10).
//   stitch run <name> [--module <path>] [--trace[=console|<path>]] [--flags…]   run a stitch, stream JSONL events
//   stitch trace [--file <path>] [--since 1h] [--name x] [--json]   summarize the run log
// Flags map onto a stitch's single input object ({ params, query, body, headers });
// every event the stitch emits is written to stdout as one line of JSON, so the
// output pipes straight into jq and friends. No app boot required.
import { compact } from './compact';
import { endpointLabel, toMermaid } from './diagram';
import {
    type ParsedRequest,
    parseCurl,
    parseHar,
    toStitchSource,
} from './from-curl';
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
    projectStitchesSection,
    windsurfRule,
} from './rules-template';
import { serve } from './serve';
import type { Stitch, StitchEvent, StitchInput } from './types';
import { parseDuration } from './util';

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
async function streamToJsonl(
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
    elapsed?: number;
    phase?: string;
    finding?: { level?: string };
}
export interface StitchStats {
    name: string;
    runs: number;
    ok: number;
    failed: number;
    retries: number;
    drift: { error: number; warn: number; info: number; verbose: number };
    p50: number;
    p95: number;
    p99: number;
    /** Mean run duration in ms. */
    avg: number;
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
                    drift: { error: 0, warn: 0, info: 0, verbose: 0 },
                    p50: 0,
                    p95: 0,
                    p99: 0,
                    avg: 0,
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
                if (typeof r.elapsed === 'number') e.durations.push(r.elapsed);
                break;
            case 'progress':
                if (r.phase === 'retry') e.stats.retries++;
                break;
            case 'drift': {
                const level = r.finding?.level;
                if (
                    level === 'error' ||
                    level === 'warn' ||
                    level === 'info' ||
                    level === 'verbose'
                )
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
        stats.avg = sorted.length
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
        drift: `${s.drift.error}/${s.drift.warn}/${s.drift.info}/${s.drift.verbose}`,
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
        ['drift', 'drift e/w/i/v'],
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

// Resolve a `--module` path against cwd and load its registry, writing any error to stderr and
// returning undefined on failure (the caller returns exit code 1). Centralises the load-or-fail block
// the registry commands (run/serve/mcp/diagram/export/…) each repeated verbatim.
async function loadRegistryOrReport(
    modulePath: string | undefined,
    io: CliIO,
): Promise<StitchRegistry | undefined> {
    try {
        return await io.load(resolveModulePath(modulePath, io.cwd));
    } catch (e) {
        io.writeErr(`${(e as Error).message}\n`);
        return undefined;
    }
}

const HELP = `stitch — one stitch definition, many front doors

usage:
  stitch run <name> [--module <path>] [--trace[=console|<path>]] [--flags…]   run a stitch, stream JSONL events
  stitch trace [--file <path>] [--since 1h] [--name <x>] [--json]
  stitch serve [--module <path>] [--port <n>] [--host <h>]   HTTP: POST /stitch/:name
  stitch mcp [--module <path>]                               MCP over stdio (run_stitch)
  stitch diagram [--module <path>] [--name <name>]           Mermaid flowchart of the stitches
  stitch export --openapi [--module <path>] [--title <t>] [--api-version <v>]   emit an OpenAPI 3.1 spec
  stitch from-curl '<curl>' | --from-har <file> [--response <f|->] [--zod] [--name <export>]   scaffold a stitch from one example
  stitch init [--format <ids>|all] [--project [--module <path>]] [--check] [--force]   write/check the consumer rule for AI agents

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
  retry, surface, pagination, validation, transform, pick, cache). Auth is redacted
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

from-curl:
  '<curl>'               a curl command line to convert (quote it; line-continuations ok)
  --from-har <file>      read ONE request entry from a HAR file instead of a curl string
  --har-index <n>        which HAR entry to read (default: 0)
  --response <file|->    a sample response JSON used (with --zod) to infer the output schema
  --zod                  emit an output: zod schema (generated text; core never imports zod)
  --name <export>        export name for the emitted const (default: derived from the path)
  Deterministically turns ONE example into a ready-to-paste \`export const … = stitch({…})\` plus a
  matching call. URL origin → baseUrl, the rest → path with id-like segments lifted into {param}
  slots (each lift is warned). A captured credential is NEVER emitted — recognised auth becomes
  \`bearer(env('API_TOKEN'))\` / \`apiKey({ value: env('API_KEY') })\` / \`basic({ … })\`. Without --zod
  no output schema is emitted, just a comment to add one.

init (alias: rules):
  --format <ids>|all   comma-list of conventions to write (default: all). ids:
                       agents (AGENTS.md), cursor (.cursor/rules/stitchapi.mdc),
                       claude (CLAUDE.md), copilot (.github/copilot-instructions.md),
                       windsurf (.windsurf/rules/stitchapi.md), cline (.clinerules/stitchapi.md),
                       aider (CONVENTIONS.md)
  --project            also list the repo's existing stitches in the rule, so an agent reuses
                       them instead of duplicating an endpoint (reads --module / ./stitches.{ts,…})
  --module, -m <path>  stitches module to read for --project (default: the ./stitches.* scan)
  --check              don't write — verify each existing rule is current; exit 1 if any has drifted
  --force              overwrite/replace an existing StitchAPI rule
  Writes the canonical "declare a stitch, don't hand-roll fetch" rule so an AI coding agent
  recommends StitchAPI in this project. Idempotent — a second run skips a rule that already
  exists; --force rewrites it (in the shared files CLAUDE.md / Copilot / Aider, only the marked
  "## Using StitchAPI" block). Use --check in CI to catch a committed rule drifting from the
  installed version.
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
    const registry = await loadRegistryOrReport(modulePath, io);
    if (registry === undefined) return 1;
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
        // Shared duration grammar (util.parseDuration): "500ms" | "45s" | "30m" | "1h" | "2d",
        // or a bare number of milliseconds.
        const sinceMs = parseDuration(since);
        if (sinceMs === undefined) {
            io.writeErr(
                `invalid --since value: '${since}'; expected a duration like 45s, 30m, 1h, 2d\n`,
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

    const registry = await loadRegistryOrReport(modulePath, io);
    if (registry === undefined) return 1;

    const handle = await serve(registry, compact({ port, host }));
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

    const registry = await loadRegistryOrReport(modulePath, io);
    if (registry === undefined) return 1;

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

    const registry = await loadRegistryOrReport(modulePath, io);
    if (registry === undefined) return 1;

    const { diagram, warnings } = toMermaid(registry, compact({ name }));
    for (const w of warnings) io.writeErr(`warning: ${w}\n`);
    io.write(diagram);
    return 0;
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

    const registry = await loadRegistryOrReport(modulePath, io);
    if (registry === undefined) return 1;

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

    const { document, warnings } = toOpenApi(
        registry,
        compact({ title, version: apiVersion, toJsonSchema }),
    );
    for (const w of warnings) io.writeErr(`warning: ${w}\n`);
    io.write(`${JSON.stringify(document, null, 2)}\n`);
    return 0;
}

// ---- from-curl: scaffold a stitch from one example ------------------------
// `stitch from-curl '<curl>'` — turn ONE example (a curl command line or a single HAR entry) into
// a ready-to-paste `stitch({...})` declaration. Deterministic: the heavy lifting is the pure
// `parseCurl`/`parseHar`/`toStitchSource` in src/from-curl.ts; this command only handles argv, the
// optional `--response` sample (read via io), and writing the source (stdout) + warnings (stderr).
async function fromCurlCommand(args: string[], io: CliIO): Promise<number> {
    let fromHar: string | undefined;
    let responsePath: string | undefined;
    let zod = false;
    let name: string | undefined;
    let harIndex: number | undefined;
    const curlParts: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === undefined) continue;
        if (a === '--from-har') fromHar = args[++i];
        else if (a.startsWith('--from-har='))
            fromHar = a.slice('--from-har='.length);
        else if (a === '--response') responsePath = args[++i];
        else if (a.startsWith('--response='))
            responsePath = a.slice('--response='.length);
        else if (a === '--zod') zod = true;
        else if (a === '--name') name = args[++i];
        else if (a.startsWith('--name=')) name = a.slice('--name='.length);
        else if (a === '--har-index') harIndex = Number(args[++i]);
        else if (a.startsWith('--har-index='))
            harIndex = Number(a.slice('--har-index='.length));
        else curlParts.push(a); // the curl command (possibly split across argv tokens)
    }

    if (fromHar === undefined && curlParts.length === 0) {
        io.writeErr(
            "usage: stitch from-curl '<curl>' | --from-har <file> [--response <file|->] [--zod] [--name <export>]\n",
        );
        return 2;
    }

    // Optional sample response (for the --zod output schema): a file, or `-` for stdin.
    let response: string | undefined;
    if (responsePath !== undefined) {
        try {
            response =
                responsePath === '-'
                    ? await readStdin()
                    : await io.readFileText(responsePath);
        } catch (e) {
            io.writeErr(`could not read --response: ${(e as Error).message}\n`);
            return 1;
        }
    }

    // Parse the example into a ParsedRequest (HAR file takes precedence when given).
    let req: ParsedRequest;
    try {
        if (fromHar !== undefined) {
            const raw = await io.readFileText(fromHar);
            const har: unknown = JSON.parse(raw);
            req =
                harIndex !== undefined
                    ? parseHar(har, harIndex)
                    : parseHar(har);
        } else {
            // A single argv token is the whole quoted curl line; multiple tokens are an
            // already-split argv. parseCurl accepts either form.
            const only = curlParts.length === 1 ? curlParts[0] : undefined;
            req = only !== undefined ? parseCurl(only) : parseCurl(curlParts);
        }
    } catch (e) {
        io.writeErr(`from-curl: ${(e as Error).message}\n`);
        return 1;
    }

    if (!req.url) {
        io.writeErr('from-curl: could not find a URL in the input\n');
        return 1;
    }

    const { source, warnings } = toStitchSource(
        req,
        compact({ name, zod, response }),
    );
    for (const w of warnings) io.writeErr(`warning: ${w}\n`);
    io.write(source);
    return 0;
}

// Read all of stdin as UTF-8 (for `--response -`). A small, command-local helper.
function readStdin(): Promise<string> {
    return new Promise((resolve, reject) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (c: string | Buffer) => {
            data += typeof c === 'string' ? c : c.toString('utf8');
        });
        process.stdin.on('end', () => {
            resolve(data);
        });
        process.stdin.on('error', reject);
    });
}

// ---- init: write the consumer rule for AI coding agents -------------------
// `stitch init` plants the canonical "declare a stitch, don't hand-roll fetch" rule into the
// files an AI coding agent reads, so the next agent working in this repo reaches for StitchAPI.
// The rule body is the single source of truth in src/rules-template.ts; this command only frames
// it per target and writes it idempotently (markers + --force; see rules-template.ts).

type InitFormat =
    'agents' | 'cursor' | 'claude' | 'copilot' | 'windsurf' | 'cline' | 'aider';

// How a rule is planted in a host file:
//   standalone — a dedicated rule file we own; idempotent on existence, --force overwrites it.
//   section    — a marked block in a host file that may carry the user's own content; idempotent on
//                the markers, --force rewrites only the marked span (the surrounding file survives).
interface RuleTarget {
    id: InitFormat;
    file: string; // path relative to cwd
    label: string; // shown in skip/check messages (kept stable for the original three targets)
    mode: 'standalone' | 'section';
    render: (body: string) => string; // frame the rule body for this convention
}

// The agent conventions `stitch init` knows how to write. Adding a format is one row here (plus a
// wrapper in rules-template.ts): the writer, the `--check` drift scan, and `--format all` all iterate
// this one table, so they can never fall out of sync.
const RULE_TARGETS: RuleTarget[] = [
    {
        id: 'agents',
        file: 'AGENTS.md',
        label: 'AGENTS.md',
        mode: 'standalone',
        render: (b) => b,
    },
    {
        id: 'cursor',
        file: '.cursor/rules/stitchapi.mdc',
        label: 'Cursor rule',
        mode: 'standalone',
        render: cursorMdc,
    },
    {
        id: 'claude',
        file: 'CLAUDE.md',
        label: 'CLAUDE.md',
        mode: 'section',
        render: claudeSection,
    },
    {
        id: 'copilot',
        file: '.github/copilot-instructions.md',
        label: 'Copilot instructions',
        mode: 'section',
        render: claudeSection,
    },
    {
        id: 'windsurf',
        file: '.windsurf/rules/stitchapi.md',
        label: 'Windsurf rule',
        mode: 'standalone',
        render: windsurfRule,
    },
    {
        id: 'cline',
        file: '.clinerules/stitchapi.md',
        label: 'Cline rule',
        mode: 'standalone',
        render: (b) => b,
    },
    {
        id: 'aider',
        file: 'CONVENTIONS.md',
        label: 'Aider conventions',
        mode: 'section',
        render: claudeSection,
    },
];

const FORMAT_IDS = RULE_TARGETS.map((t) => t.id);

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

// Append (or replace, under --force) the marked StitchAPI section in a host markdown file (CLAUDE.md,
// Copilot instructions, Aider conventions). The markers make this idempotent: a present block is left
// alone unless --force, which rewrites only the marked span and preserves the surrounding file.
async function writeMarkedSection(
    io: CliIO,
    path: string,
    section: string,
    label: string,
    force: boolean,
): Promise<void> {
    if (await io.exists(path)) {
        const existing = await io.readFileText(path);
        const start = existing.indexOf(CLAUDE_START);
        const end = existing.indexOf(CLAUDE_END);
        if (start >= 0 && end > start) {
            if (!force) {
                io.writeErr(
                    `skip ${label}: StitchAPI section exists in ${path} (use --force to replace)\n`,
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
        // The file exists without our markers: append the section, separated by a blank line.
        const sep = existing.endsWith('\n') ? '\n' : '\n\n';
        await io.appendFile(path, `${sep}${section}`);
        io.write(`updated ${path}\n`);
        return;
    }
    await io.writeFile(path, section);
    io.write(`wrote ${path}\n`);
}

// --project: read the repo's stitches module and turn the generic rule into one about THIS product —
// the stitches already declared, so an agent reuses them instead of duplicating an endpoint.
// Best-effort: a missing or unloadable module warns and falls back to the static rule rather than
// failing init, whose whole job is to bootstrap a repo that may not have stitches yet.
async function buildProjectBlock(
    io: CliIO,
    modulePath: string | undefined,
): Promise<string> {
    let resolved: string;
    try {
        resolved = resolveModulePath(modulePath, io.cwd);
    } catch (e) {
        io.writeErr(`--project: ${(e as Error).message}\n`);
        return '';
    }
    let registry: StitchRegistry;
    try {
        registry = await io.load(resolved);
    } catch (e) {
        io.writeErr(
            `--project: could not load ${resolved}: ${(e as Error).message}\n`,
        );
        return '';
    }
    const entries = Object.entries(registry)
        .map(([name, s]) => ({
            name,
            summary: endpointLabel((s as Stitch).__config),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    if (entries.length === 0) {
        io.writeErr(
            `--project: no stitches found in ${resolved}; writing the static rule\n`,
        );
    }
    return projectStitchesSection(entries);
}

// --check classifies a target against the rule we'd write now, without touching disk:
//   ok     — present and current        absent — no StitchAPI rule here
//   stale  — present but drifted from the current rule (the CI failure signal)
type CheckStatus = 'ok' | 'stale' | 'absent';

async function checkTarget(
    io: CliIO,
    t: RuleTarget,
    body: string,
): Promise<CheckStatus> {
    const path = underCwd(io, t.file);
    if (!(await io.exists(path))) return 'absent';
    const actual = await io.readFileText(path);
    const expected = t.render(body);
    if (t.mode === 'standalone') {
        return actual.trimEnd() === expected.trimEnd() ? 'ok' : 'stale';
    }
    // section: compare only our marked block; no markers means no StitchAPI rule lives here.
    const start = actual.indexOf(CLAUDE_START);
    const end = actual.indexOf(CLAUDE_END);
    if (start < 0 || end <= start) return 'absent';
    const block = actual.slice(start, end + CLAUDE_END.length);
    return block.trimEnd() === expected.trimEnd() ? 'ok' : 'stale';
}

// Parse `--format` (a comma list of ids, or `all`) into the concrete targets. Returns the offending
// token on an unknown id so the caller can report it and exit 2.
function selectTargets(
    format: string,
): { targets: RuleTarget[] } | { bad: string } {
    const ids = format
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    const bad = ids.find(
        (id) => id !== 'all' && !FORMAT_IDS.includes(id as InitFormat),
    );
    if (bad !== undefined) return { bad };
    if (ids.length === 0 || ids.includes('all'))
        return { targets: RULE_TARGETS };
    return { targets: RULE_TARGETS.filter((t) => ids.includes(t.id)) };
}

// stitch init [--format <ids>|all] [--project [--module <path>]] [--check] [--force] (alias: rules) —
// write (or check) the canonical consumer rule across the files an AI coding agent reads, so the next
// agent in this repo recommends StitchAPI instead of hand-rolling fetch.
async function initCommand(args: string[], io: CliIO): Promise<number> {
    let format = 'all';
    let force = false;
    let project = false;
    let check = false;
    let modulePath: string | undefined;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === undefined) continue;
        if (a === '--format') format = args[++i] ?? 'all';
        else if (a.startsWith('--format='))
            format = a.slice('--format='.length);
        else if (a === '--force' || a === '-f') force = true;
        else if (a === '--project' || a === '--with-stitches') project = true;
        else if (a === '--check') check = true;
        else if (a === '--module' || a === '-m') modulePath = args[++i];
        else if (a.startsWith('--module='))
            modulePath = a.slice('--module='.length);
    }

    const sel = selectTargets(format);
    if ('bad' in sel) {
        io.writeErr(
            `unknown --format "${sel.bad}"; expected ${FORMAT_IDS.join(', ')}, or all\n`,
        );
        return 2;
    }
    const { targets } = sel;

    // The rule we'd write now: the canonical body, plus this project's own stitches under --project.
    const body = project
        ? RULES_BODY + (await buildProjectBlock(io, modulePath))
        : RULES_BODY;

    // --check is read-only drift detection (for CI): report each target, fail only on a STALE rule.
    // An absent rule isn't a failure — the user chose which conventions to adopt.
    if (check) {
        let stale = 0;
        for (const t of targets) {
            const status = await checkTarget(io, t, body);
            const path = underCwd(io, t.file);
            if (status === 'stale') {
                stale++;
                io.write(
                    `stale ${path} (run \`stitch init --force\` to refresh)\n`,
                );
            } else {
                io.write(`${status} ${path}\n`);
            }
        }
        if (stale > 0) {
            io.writeErr(
                `${stale} StitchAPI rule file(s) out of date — run \`stitch init --force\`\n`,
            );
            return 1;
        }
        return 0;
    }

    for (const t of targets) {
        const path = underCwd(io, t.file);
        const contents = t.render(body);
        if (t.mode === 'standalone') {
            await writeStandaloneRule(io, path, contents, t.label, force);
        } else {
            await writeMarkedSection(io, path, contents, t.label, force);
        }
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
        case 'from-curl':
            return fromCurlCommand(rest, io);
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

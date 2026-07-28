// @stitchapi/shell — run a STATIC local command as a StitchAPI surface (ADR 0008). A Node-only
// peer package: core never imports it, so `node:child_process` never reaches a browser bundle
// (the browser-first gate). It is the first consumer of the transport-replacing `Surface.execute`
// hook — the command runs INSIDE the resilience chain, so `retry` / `throttle` / `circuit` /
// `timeout` / `signal` / `trace` all apply to a subprocess exactly as they do to an HTTP call.
//
// SECURITY — injection is impossible by CONSTRUCTION, not by escaping (the "structural, not
// advisory" bar that rejected host-inferred bearer tokens in #6):
//   • the executable is STATIC, bound at construction (`shell(command)` / `shell({ command })`),
//     NEVER taken from call input;
//   • arguments are an ARRAY of strings passed straight to `execFile` — there is NO shell
//     (`shell: true` is never set, no `/bin/sh -c`), so `;` `|` `$()` backticks `*` `>` are inert
//     data, never interpreted;
//   • nothing is interpolated — each argv element is one process argument, verbatim;
//   • the subprocess env is FAIL-CLOSED (empty by default) so a secret in `process.env` can't leak
//     into a child — pass exactly what's needed (incl. `PATH` for a bare command name, or use an
//     absolute command path).
import { execFile } from 'node:child_process';
import { compact, stitch } from 'stitchapi';
import type {
    AdapterRequest,
    AdapterResponse,
    AtLeastOne,
    Stitch,
    StitchConfig,
    Surface,
} from 'stitchapi';

/** The defaults bound to a shell surface (the static command + how to run it). */
interface ShellDefaults {
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    maxBufferBytes: number;
}

// Run the static command with the call's argv. The ONLY input is the argv array (`req.body`);
// every element must already be a string (the array boundary + `execFile` make injection
// structurally impossible). A non-zero exit maps to status 500 with `{ exitCode, stdout, stderr }`
// so it surfaces as a StitchError (or an accepted result via `acceptStatus`); a spawn failure
// (ENOENT) or an abort rejects, so the resilience chain sees a transport error.
function runCommand(
    d: ShellDefaults,
    req: AdapterRequest,
): Promise<AdapterResponse> {
    const argv = req.body;
    if (!Array.isArray(argv) || !argv.every((a) => typeof a === 'string')) {
        const e = new Error(
            'shell: arguments must be a string[] passed as the call `body` (e.g. `run({ body: ["status", "--porcelain"] })`).',
        );
        e.name = 'StitchConfigError';
        return Promise.reject(e);
    }
    const url = `shell:${d.command}`;
    return new Promise<AdapterResponse>((resolve, reject) => {
        execFile(
            d.command,
            argv,
            compact({
                cwd: d.cwd,
                env: d.env ?? {}, // FAIL-CLOSED: no inherited process.env
                signal: req.signal,
                maxBuffer: d.maxBufferBytes,
                encoding: 'utf8',
            }),
            (err, stdout, stderr) => {
                if (err) {
                    // A non-zero EXIT carries a numeric `.code` (the exit status) → a "response".
                    // A spawn failure (ENOENT/EACCES) or an abort carries a string code / no code
                    // → a transport error: reject so retry/abort handling sees it.
                    const code = (err as NodeJS.ErrnoException).code;
                    if (typeof code === 'number') {
                        resolve({
                            status: 500,
                            headers: {},
                            body: { exitCode: code, stdout, stderr },
                            url,
                        });
                        return;
                    }
                    reject(err);
                    return;
                }
                // Honour the shared StitchConfig.responseType slot (narrowed to 'json' | 'text'
                // in ShellOptions): the engine threads it onto the request, the surface reads it
                // here. Absent → 'text' (stdout is the value, verbatim).
                let body: unknown = stdout;
                if (req.responseType === 'json') {
                    try {
                        body = JSON.parse(stdout);
                    } catch {
                        /* not JSON — hand back the raw text */
                    }
                }
                resolve({ status: 200, headers: {}, body, url });
            },
        );
    });
}

// The shell surface for one static command. `execute` replaces the transport (ADR 0008); the
// `url` is a `shell:` pseudo-endpoint (the engine's absolute-URL guard is bypassed for a surface
// that carries `execute`). No `interpret` — exit 0 ⇒ stdout is the value; the engine throws on a
// non-zero exit (status 500) like any HTTP failure.
function shellSurface(d: ShellDefaults): Surface {
    return {
        id: 'shell',
        buildRequest: (_cfg, input, base) => ({ ...base, body: input.body }),
        execute: (req) => runCommand(d, req),
    };
}

/**
 * Options for {@link shell}: the static `command` + run controls, plus the shared StitchConfig keys
 * (`retry` / `throttle` / `timeout` / `circuit` / `trace` all apply via the resilience chain).
 * `command` is required by design (CONTRACT.md P15) — the positional `shell(command, options?)`
 * shorthand names it, so the options bag there is `Omit<ShellOptions, 'command'>`.
 */
export interface ShellOptions
    extends Partial<Omit<StitchConfig, 'kind' | 'responseType'>> {
    /** The executable — STATIC, bound at construction, NEVER from call input. An absolute path
     *  needs no `PATH`; a bare name (`'git'`) needs `env: { PATH: process.env.PATH }`. */
    command: string;
    /** Working directory for the subprocess (default: the process cwd). */
    cwd?: string;
    /** Subprocess environment. FAIL-CLOSED: empty by default — pass exactly what's needed; nothing
     *  from `process.env` leaks in unless you put it here. */
    env?: Record<string, string>;
    /** How to read stdout — the shared {@link StitchConfig.responseType} slot, narrowed to what a
     *  subprocess can yield: `'text'` (default — the value is the stdout string) or `'json'`
     *  (`JSON.parse` it, falling back to the raw text). Honoured by the shell surface directly. */
    responseType?: 'json' | 'text';
    /** Max stdout/stderr bytes buffered (default 10 MiB); exceeding it fails the call. */
    maxBufferBytes?: number;
}

/**
 * `shell(command, options?)` — a stitch that runs a static local command, its `stdout` the result.
 * The call supplies the argument vector as a `string[]` `body`; everything else (retry/throttle/
 * timeout/trace) is the usual StitchConfig. `T` is the result type (`string` for the default
 * `responseType: 'text'`, your shape for `'json'`).
 *
 * Two spellings (CONTRACT.md P15): the positional shorthand names the required `command`, or pass
 * the full {@link ShellOptions} envelope. The positional options bag must set at least one field —
 * all-defaults is spelled by omitting it, never `{}` (P20).
 *
 * @example
 * ```ts
 * import { shell } from '@stitchapi/shell';
 *
 * const git = shell('git', { env: { PATH: process.env.PATH! } });
 * const status = await git({ body: ['status', '--porcelain'] }); // stdout string
 * ```
 */
export function shell<T = string>(
    command: string,
    options?: AtLeastOne<Omit<ShellOptions, 'command'>>,
): Stitch<T>;
export function shell<T = string>(options: ShellOptions): Stitch<T>;
export function shell<T = string>(
    commandOrOptions: string | ShellOptions,
    positionalOptions?: AtLeastOne<Omit<ShellOptions, 'command'>>,
): Stitch<T> {
    const opts: ShellOptions =
        typeof commandOrOptions === 'string'
            ? { ...positionalOptions, command: commandOrOptions }
            : commandOrOptions;
    const { command, cwd, env, maxBufferBytes, ...rest } = opts;
    const d: ShellDefaults = {
        command,
        maxBufferBytes: maxBufferBytes ?? 10 * 1024 * 1024,
    };
    if (cwd !== undefined) d.cwd = cwd;
    if (env !== undefined) d.env = env;
    // `responseType` stays in `rest` — it is a shared StitchConfig key, so it rides the config
    // into the engine's base request, where the surface honours it (see runCommand).
    return stitch({
        ...rest,
        kind: shellSurface(d),
        url: rest.url ?? `shell:${command}`,
    }) as unknown as Stitch<T>;
}

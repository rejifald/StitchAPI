// @stitchapi/shell — run a STATIC local command as a StitchAPI surface (ADR 0008). A Node-only
// peer package: core never imports it, so `node:child_process` never reaches a browser bundle
// (the browser-first gate). It is the first consumer of the transport-replacing `Surface.execute`
// hook — the command runs INSIDE the resilience chain, so `retry` / `throttle` / `circuit` /
// `timeout` / `signal` / `trace` all apply to a subprocess exactly as they do to an HTTP call.
//
// SECURITY — injection is impossible by CONSTRUCTION, not by escaping (the "structural, not
// advisory" bar that rejected host-inferred bearer tokens in #6):
//   • the executable is STATIC, bound in `shell({ command })`, NEVER taken from call input;
//   • arguments are an ARRAY of strings passed straight to `execFile` — there is NO shell
//     (`shell: true` is never set, no `/bin/sh -c`), so `;` `|` `$()` backticks `*` `>` are inert
//     data, never interpreted;
//   • nothing is interpolated — each argv element is one process argument, verbatim;
//   • the subprocess env is FAIL-CLOSED (empty by default) so a secret in `process.env` can't leak
//     into a child — pass exactly what's needed (incl. `PATH` for a bare command name, or use an
//     absolute command path).
import { execFile } from 'node:child_process';
import { stitch } from 'stitchapi';
import type {
    AdapterRequest,
    AdapterResponse,
    Stitch,
    StitchConfig,
    Surface,
} from 'stitchapi';

/** The defaults bound to a shell surface (the static command + how to run it). */
interface ShellDefaults {
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    decode: 'text' | 'json';
    maxBuffer: number;
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
            {
                ...(d.cwd !== undefined ? { cwd: d.cwd } : {}),
                env: d.env ?? {}, // FAIL-CLOSED: no inherited process.env
                ...(req.signal !== undefined ? { signal: req.signal } : {}),
                maxBuffer: d.maxBuffer,
                encoding: 'utf8',
            },
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
                let body: unknown = stdout;
                if (d.decode === 'json') {
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

/** Options for {@link shell}: the static `command` + run controls, plus the shared StitchConfig keys
 *  (`retry` / `throttle` / `timeout` / `circuit` / `trace` all apply via the resilience chain). */
export type ShellOptions = Partial<Omit<StitchConfig, 'kind'>> & {
    /** The executable — STATIC, bound here at construction, NEVER from call input. An absolute path
     *  needs no `PATH`; a bare name (`'git'`) needs `env: { PATH: process.env.PATH }`. */
    command: string;
    /** Working directory for the subprocess (default: the process cwd). */
    cwd?: string;
    /** Subprocess environment. FAIL-CLOSED: empty by default — pass exactly what's needed; nothing
     *  from `process.env` leaks in unless you put it here. */
    env?: Record<string, string>;
    /** How to read stdout: `'text'` (default — the value is the string) or `'json'` (JSON.parse it). */
    decode?: 'text' | 'json';
    /** Max stdout/stderr bytes buffered (default 10 MiB); exceeding it fails the call. */
    maxBuffer?: number;
};

/**
 * `shell({ command })` — a stitch that runs a static local command, its `stdout` the result. The
 * call supplies the argument vector as a `string[]` `body`; everything else (retry/throttle/
 * timeout/trace) is the usual StitchConfig. `T` is the result type (`string` for `decode: 'text'`,
 * your shape for `'json'`).
 *
 * @example
 * ```ts
 * import { shell } from '@stitchapi/shell';
 *
 * const git = shell({ command: 'git', env: { PATH: process.env.PATH! } });
 * const status = await git({ body: ['status', '--porcelain'] }); // stdout string
 * ```
 */
export function shell<T = string>(opts: ShellOptions): Stitch<T> {
    const { command, cwd, env, decode, maxBuffer, ...rest } = opts;
    const d: ShellDefaults = {
        command,
        decode: decode ?? 'text',
        maxBuffer: maxBuffer ?? 10 * 1024 * 1024,
    };
    if (cwd !== undefined) d.cwd = cwd;
    if (env !== undefined) d.env = env;
    return stitch({
        ...rest,
        kind: shellSurface(d),
        url: rest.url ?? `shell:${command}`,
    }) as unknown as Stitch<T>;
}

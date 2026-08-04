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
import { compact, parseBytes, stitch } from 'stitchapi';
import type {
    AdapterRequest,
    AdapterResponse,
    AtLeastOne,
    Stitch,
    StitchConfig,
    Surface,
} from 'stitchapi';

/** The default cap on buffered stdout/stderr — Node's own `execFile` default is 1 MiB; a command
 *  run as a stitch is usually reporting, so the surface is more generous. */
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

/** The defaults bound to a shell surface (the static command + how to run it) — the RESOLVED
 *  view, not the authoring one: the `buffer` shorthand is folded and its size token parsed once,
 *  at construction, so the hot path never re-parses. The fields that reach `execFile` keep that
 *  call's spelling (`maxBuffer`, bytes) so the mapping is one-to-one and nothing here reads as a
 *  second public name for the `buffer` envelope. */
interface ShellDefaults {
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    decode: 'text' | 'json';
    maxBuffer: number;
}

// Fold the `buffer` slot's scalar shorthand — `'4mb'` ≡ `{ max: '4mb' }` (CONTRACT.md P12) — and
// resolve it to the byte count `execFile` wants. An unparseable token yields `undefined` from
// `parseBytes` and lands on the default, so a typo can never widen the cap to "unbounded" (P25).
function resolveMaxBuffer(buffer: ShellOptions['buffer']): number {
    const max =
        typeof buffer === 'object' && buffer !== null ? buffer.max : buffer;
    return parseBytes(max) ?? DEFAULT_MAX_BUFFER;
}

// Run the static command with the call's argv. The ONLY input is the argv array (`req.body`);
// every element must already be a string (the array boundary + `execFile` make injection
// structurally impossible). A non-zero exit maps to status 500 with `{ exitCode, stdout, stderr }`
// so it surfaces as a StitchError (or an accepted result via `verdict.accept`); a spawn failure
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
                maxBuffer: d.maxBuffer,
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

/**
 * How the subprocess's buffered output is bounded. One dominant field, so the `buffer` slot also
 * takes its scalar (CONTRACT.md P12): `buffer: '4mb'` ≡ `buffer: { max: '4mb' }`. It is an
 * envelope rather than a bare `maxBufferBytes` key so the next output control (an overflow
 * policy, an encoding) lands inside it instead of adding a top-level word (P21).
 *
 * Inside it `max` needs no unit suffix — the size analogue of core's `BackoffOptions.max`: there
 * is only one thing here to measure (P1), and it bounds a **magnitude**, which is the case P4
 * leaves `max`. Bytes are the house size unit (P25) — the `Chars` family is the marked exception
 * — and a subprocess buffer is natively bytes, as `execFile`'s own `maxBuffer` is.
 */
export interface ShellBufferOptions {
    /** Ceiling on the buffered stdout/stderr; exceeding it fails the call. A raw byte count or a
     *  size token — `4 * 1024 * 1024` or `'4mb'` (powers of 1024) — parsed by core's shared
     *  `parseBytes` (CONTRACT.md P25). Default 10 MiB; an unparseable token falls back to that
     *  default, never to "unbounded". */
    max?: number | string;
}

/**
 * Options for {@link shell}: the static `command` + run controls, plus the shared StitchConfig keys
 * (`retry` / `throttle` / `timeout` / `circuit` / `trace` all apply via the resilience chain).
 * `command` is required by design (CONTRACT.md P15) — the positional `shell(command, options?)`
 * shorthand names it, so the options bag there is `Omit<ShellOptions, 'command'>`.
 *
 * The whole `wire` envelope is omitted from the inherited keys: it describes the HTTP wire format
 * — request body encoding, urlencoded array serialisation, multipart nesting, response reading —
 * and a subprocess has none of it. Its `body` is argv, not an encoded payload, and how stdout
 * becomes a value is spelled once, as `decode` — the house word for "turn raw output into values"
 * (core spells the streaming decoder `stream.decode`). Passing an HTTP-shaped slot to a shell used
 * to type-check and do nothing; now it does not type-check.
 *
 * The envelope is dropped whole rather than by its `response` field: once the four flat slots
 * folded into one word (CONTRACT.md P24), filtering a single field inside it would leave the other
 * three inherited — type-checking and doing nothing, which is the exact hole this closes.
 */
export interface ShellOptions extends Partial<
    Omit<StitchConfig, 'kind' | 'wire'>
> {
    /** The executable — STATIC, bound at construction, NEVER from call input. An absolute path
     *  needs no `PATH`; a bare name (`'git'`) needs `env: { PATH: process.env.PATH }`. */
    command: string;
    /** Working directory for the subprocess (default: the process cwd). */
    cwd?: string;
    /** Subprocess environment. FAIL-CLOSED: empty by default — pass exactly what's needed; nothing
     *  from `process.env` leaks in unless you put it here. */
    env?: Record<string, string>;
    /** How to read stdout: `'text'` (default — the value is the string) or `'json'` (`JSON.parse`
     *  it, falling back to the raw text). */
    decode?: 'text' | 'json';
    /** Output buffering — {@link ShellBufferOptions}, or its dominant field's scalar:
     *  `buffer: '4mb'` ≡ `buffer: { max: '4mb' }` (CONTRACT.md P12). Default 10 MiB. The
     *  envelope must set a field — omit `buffer` for the default, never `{}` (P20). */
    buffer?: number | string | AtLeastOne<ShellBufferOptions>;
}

/**
 * `shell(command, options?)` — a stitch that runs a static local command, its `stdout` the result.
 * The call supplies the argument vector as a `string[]` `body`; everything else (retry/throttle/
 * timeout/trace) is the usual StitchConfig. `T` is the result type (`string` for the default
 * `decode: 'text'`, your shape for `'json'`).
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
    const { command, cwd, env, decode, buffer, ...rest } = opts;
    const d: ShellDefaults = {
        command,
        decode: decode ?? 'text',
        maxBuffer: resolveMaxBuffer(buffer),
    };
    if (cwd !== undefined) d.cwd = cwd;
    if (env !== undefined) d.env = env;
    return stitch({
        ...rest,
        kind: shellSurface(d),
        url: rest.url ?? `shell:${command}`,
    }) as unknown as Stitch<T>;
}

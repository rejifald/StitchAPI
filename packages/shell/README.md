# @stitchapi/shell

Run a **static local command** as a StitchAPI surface — so a subprocess gets the same `retry` /
`throttle` / `circuit` / `timeout` / `trace` treatment as an HTTP call, through the same engine
([ADR 0008](../../docs/adr/0008-non-http-surfaces-and-pipe.md)).

This is a **Node-only peer package**: core never imports it, so `node:child_process` never reaches a
browser bundle.

```ts
import { shell } from '@stitchapi/shell';

const git = shell({ command: 'git', env: { PATH: process.env.PATH! } });

const status = await git({ body: ['status', '--porcelain'] }); // stdout (string)
```

## Security — injection is impossible by construction

Not "mitigated by escaping" — **structurally impossible**, the same bar that rejected
host-inferred bearer tokens in StitchAPI's auth:

-   **Static executable.** `command` is bound in `shell({ command })`, **never** taken from call
    input — exactly as a credential is bound at construction.
-   **`argv` is an array, never a string.** Arguments are a `string[]` passed straight to
    `child_process.execFile`. There is **no shell** (`shell: true` is never set), so `;` `|` `$()`
    backticks `*` `>` are inert data, never interpreted.
-   **No interpolation.** Each `argv` element is one process argument, verbatim. An `input` schema can
    further constrain values, but the array boundary is the guarantee.
-   **Fail-closed env.** The subprocess inherits **no** `process.env` by default, so a secret in the
    parent environment cannot leak into a child. Pass exactly what's needed — including `PATH` for a
    bare command name, or use an absolute command path (as in the example).

## Result

-   Exit `0` → the value is `stdout` (a `string`; pass `decode: 'json'` to `JSON.parse` it).
-   A non-zero exit → a `StitchError` (status `500`) whose `.body` is `{ exitCode, stdout, stderr }`
    (or accept it as a normal result with `acceptStatus`).
-   A timeout / caller `AbortSignal` aborts the subprocess (it runs inside the resilience chain).

## Options

`shell(options)` takes the static `command`, optional `cwd` / `env` / `decode` / `maxBuffer`, plus
the usual `StitchConfig` keys (`retry`, `throttle`, `timeout`, `circuit`, `trace`, …) — all applied
by the engine around the subprocess.

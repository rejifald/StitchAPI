# @stitchapi/shell

[![npm](https://img.shields.io/npm/v/@stitchapi/shell?color=2563EB&label=npm)](https://www.npmjs.com/package/@stitchapi/shell)

Run a **static local command** as a StitchAPI surface — so a subprocess gets the same `retry` /
`throttle` / `circuit` / `timeout` / `trace` treatment as an HTTP call, through the same engine
([ADR 0008](../../docs/adr/0008-non-http-surfaces-and-pipe.md)).

This is a **Node-only peer package**: core never imports it, so `node:child_process` never reaches a
browser bundle.

```ts
import { shell } from '@stitchapi/shell';

const git = shell('git', { env: { PATH: process.env.PATH! } });

const status = await git({ body: ['status', '--porcelain'] }); // stdout (string)
```

## Security — injection is impossible by construction

Not "mitigated by escaping" — **structurally impossible**, the same bar that rejected
host-inferred bearer tokens in StitchAPI's auth:

- **Static executable.** `command` is bound at construction — `shell(command, …)` or
  `shell({ command, … })` — **never** taken from call input, exactly as a credential is bound at
  construction.
- **`argv` is an array, never a string.** Arguments are a `string[]` passed straight to
  `child_process.execFile`. There is **no shell** (`shell: true` is never set), so `;` `|` `$()`
  backticks `*` `>` are inert data, never interpreted.
- **No interpolation.** Each `argv` element is one process argument, verbatim. An `input` schema can
  further constrain values, but the array boundary is the guarantee.
- **Fail-closed env.** The subprocess inherits **no** `process.env` by default, so a secret in the
  parent environment cannot leak into a child. Pass exactly what's needed — including `PATH` for a
  bare command name, or use an absolute command path (as in the example).

## Result

- Exit `0` → the value is `stdout` (a `string`; pass `decode: 'json'` to `JSON.parse` it).
- A non-zero exit → a `StitchError` (status `500`) whose `.body` is `{ exitCode, stdout, stderr }`
  (or accept it as a normal result with `verdict: { accept: … }`).
- A timeout / caller `AbortSignal` aborts the subprocess (it runs inside the resilience chain).

## Options

Two spellings: the positional shorthand `shell(command, options?)` names the required `command`, or
pass the full `ShellOptions` envelope `shell({ command, … })`. The options are the optional `cwd` /
`env` / `decode` (`'text'` default, or `'json'`) / `buffer` (below), plus the usual `StitchConfig`
keys (`retry`, `throttle`, `timeout`, `circuit`, `trace`, …) — all applied by the engine around the
subprocess. The positional options bag must set at least one field — all-defaults is spelled by
omitting it, never `{}`.

`buffer` caps the buffered `stdout`/`stderr` (default 10 MiB; exceeding it fails the call). It is a
`ShellBufferOptions` envelope whose dominant field takes a byte count or a size token, and it
collapses to that scalar:

```ts
shell(NODE, { buffer: '4mb' }); // ≡ { buffer: { max: '4mb' } }
shell(NODE, { buffer: 4096 }); // ≡ { buffer: { max: 4096 } }
```

Tokens are powers of 1024 (`'1mb'` = 1 048 576), parsed by core's shared `size.parse`. An
unparseable token falls back to the default — never to "unbounded".

## Contributing

Issues and pull requests are welcome — see the [contributing guide](../../CONTRIBUTING.md) for local setup, the verify gate, and how to open a PR against `main`.

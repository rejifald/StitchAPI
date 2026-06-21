# @stitchapi/pino

[![npm](https://img.shields.io/npm/v/@stitchapi/pino?color=2563EB&label=npm)](https://www.npmjs.com/package/@stitchapi/pino)

A **[Pino](https://getpino.io) `TraceSink`** for StitchAPI. Attach it and the
stitch event stream becomes structured Pino logs — one record per event, at the
right level, with **no change to the call site**:

```ts
import { pinoSink } from '@stitchapi/pino';
import pino from 'pino';
import { seam } from 'stitchapi';

const api = seam({ trace: pinoSink(pino()) });
```

Every call the seam makes now emits structured records:

```jsonc
{ "level": 20, "stitch": "getUser", "method": "GET", "url": "https://api.example.com/users", "msg": "→ getUser GET https://api.example.com/users" }
{ "level": 30, "stitch": "getUser", "status": 200, "attempts": 1, "msg": "← getUser 200 (1 attempt(s))" }
```

## Event → level mapping

The sink maps each `StitchEvent` to a Pino level — the same logic
`@stitchapi/nest`'s `loggerSink` uses, logging in Pino's **structured** form
(`logger.info({ stitch, … }, msg)`):

| Event      | Pino level                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `error`    | `error`                                                                                                                                    |
| `drift`    | `error` / `warn` / `debug` — follows the finding's own `level`                                                                             |
| `progress` | `warn` when the phase is `retry` or `circuit` (upstream flaky / breaker tripped), else `debug` (routine throttle / paginate / cache waits) |
| `start`    | `debug` — gated by `lifecycle`                                                                                                             |
| `result`   | `info` — gated by `lifecycle`                                                                                                              |
| `done`     | `debug` — gated by `lifecycle`                                                                                                             |
| `delta`    | **dropped** — a streamed chunk is raw response data, never logged                                                                          |

`start`/`done` sit at `debug` so a production Pino level (`info`) hides them by
default. Set `lifecycle: false` to drop the happy-path entirely and log only
retries, drift findings, and errors:

```ts
pinoSink(pino(), { lifecycle: false });
```

## Bring your own logger

This package **imports no logger** — it runs on a small structural
`PinoLoggerLike` surface (`{ error, warn, info, debug, trace }`, plus an optional
`child`). A real `pino()` instance, a `logger.child({ requestId })`, and a plain
test double all satisfy it. `pino` is the single (peer) dependency, accepting both
v8 and v9.

## Security — metadata only, by design

> [!IMPORTANT]
>
> A custom `TraceSink` receives the **raw** event — core only redacts inside its
> own built-in sinks. So `pinoSink` logs **only metadata** and never the payload.

Concretely, it logs the stitch name, method, **redacted URL** (the query string is
stripped — it can carry `?api_key=…`), status, attempt counts, drift
path/level/change, progress phase, and timing. It **never** logs `event.input`
(headers like `authorization` / `cookie` stay raw on the event), `event.value`
(the response body), a `delta` chunk, or `JSON.stringify(event)`. That keeps it
safe on a secret-bearing seam regardless of core's trace redaction — proven by a
test that feeds a `start` event whose `input.headers.authorization` is set and
asserts the secret never appears in any logged argument.

## Public API

-   `pinoSink(logger, options?)` → a `TraceSink`
-   `interface PinoLoggerLike` — the structural logger slice
-   `interface PinoLogFn` — a single level method (`(obj, msg?)` and `(msg)`)
-   `interface PinoSinkOptions` — `{ lifecycle?: boolean }` (default `true`)

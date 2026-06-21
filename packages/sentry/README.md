# @stitchapi/sentry

[![npm](https://img.shields.io/npm/v/@stitchapi/sentry?color=2563EB&label=npm)](https://www.npmjs.com/package/@stitchapi/sentry)

A [Sentry](https://sentry.io) `TraceSink` for [StitchAPI](https://stitchapi.dev). The logger sinks (`@stitchapi/pino`, core's `loggerSink`) and the OTLP bridge cover logs and traces; Sentry's model is different — a trail of **breadcrumbs** leading up to a **captured error**. This sink maps the stitch [event stream](https://stitchapi.dev/docs/concepts/event-stream) onto it.

Routine events become breadcrumbs (category `stitch`); an `error` event is captured as a Sentry issue with the call's context, so the breadcrumb trail attaches automatically.

**Bring your own Sentry.** The sink imports no SDK — it talks to a small structural surface that `@sentry/node`, `@sentry/browser`, `@sentry/react`, and friends all satisfy. So there's no `@sentry/*` dependency, and a test double is a drop-in.

## Install

```sh
pnpm add @stitchapi/sentry stitchapi
```

`stitchapi` is the only peer dependency. Pass whichever `@sentry/*` SDK your app already runs.

## Usage

```ts
import * as Sentry from '@sentry/node';
import { sentrySink } from '@stitchapi/sentry';
import { seam } from 'stitchapi';

const api = seam({
    baseUrl: 'https://api.example.com',
    trace: sentrySink(Sentry),
});
```

The same sink works on a single stitch — `stitch({ trace: sentrySink(Sentry) })`.

## What it sends

| Event                          | Sentry                                                               |
| ------------------------------ | -------------------------------------------------------------------- |
| `error`                        | `captureMessage` (level `error`) + an error breadcrumb               |
| `progress` (`retry`/`circuit`) | breadcrumb, level `warning`                                          |
| `progress` (throttle/paginate) | breadcrumb, level `debug`                                            |
| `drift`                        | breadcrumb (level follows the finding); captured with `captureDrift` |
| `start` / `result` / `done`    | breadcrumb only when `lifecycle: true` (off by default)              |
| `delta` / `info`               | **never sent** (raw response data / strategy announcements)          |

Options: `{ lifecycle?, captureErrors?, captureDrift? }`.

## Safe on a secret-bearing seam

> A custom `TraceSink` receives the **raw** event — core only redacts inside its own built-in sinks. This sink therefore sends **metadata only**: the stitch name, method, **redacted URL** (query stripped — it can carry `?api_key=…`), status, attempt counts, drift path/level/change, phase, and timing. It never sends `event.input` (headers still hold the live `authorization`/`cookie`), the response `value`, or a `delta` chunk.

## License

Apache-2.0

# Harness API reference (for scenario authors)

Public API of the prototype. See `test/smoke.spec.ts` for a working example.

## Imports

```ts
import { drift, seam, stitch } from '../src';
import { apiKey, basic, bearer, cookieSession, env } from '../src/auth';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

import { z } from 'zod';
```

## stitch(config | url)

`config` fields (all optional except a target):

- `name`, `method` (default GET), `baseUrl` (string | `() => string`), `path` (may include `{param}` and `?predefined=query`)
- `input`: `{ params?, query?, body?, headers? }` — each a Zod/Standard-Schema validator
- `output`: a schema **or** `drift(schema, opts)` — validated against the **picked** value
- `pick`: dot-path string (e.g. `'data'`)
- `auth`: an AuthStrategy (see below)
- `retry`: `{ attempts (total incl. first, default 1), on: StatusMatch (default [429,502,503,504]), backoff: BackoffCurve | { curve, base, max }, respectRetryAfter }`
- `throttle`: `{ rate: '2/s', concurrency: number, pool: 'stitch'|'host', delegate?: boolean, on?: StatusMatch }`
- `timeout`: `{ total: number|string, perAttempt: number|string }` (ms or '30s')
- `hooks`: `{ onRequest, onResponse, onError, onRetry }` — `(ctx) => void|Promise<void>`, `ctx = { name, attempt, req?, res?, error? }`
- `extends`: `Array<fragment | stitch>`
- `adapter`: inject a custom transport (not needed; the mock server gives real fetch)

## Calling a stitch

```ts
const s = stitch({ baseUrl, path: '/x' });
await s();                         // unwrapped, validated result; THROWS StitchError (err.status) on error
await s({ params, query, body, headers });
for await (const ev of s.stream(input?)) { ... }   // typed event stream
const s2 = s.with({ query: { role: 'admin' } });   // partial application -> new stitch
```

## Events (each also has `at: number`)

- `{ type:'start', name, method, url, input }`
- `{ type:'progress', phase:'auth'|'request'|'throttled'|'retry'|'paginate', attempt, detail?, waited? }`
- `{ type:'drift', finding:{ level:'error'|'warn'|'info'|'verbose', path, change:'invalid'|'undeclared'|'coerced'|'defaulted', detail? } }`
- `{ type:'result', data, status, attempts }`
- `{ type:'error', name, message, status?, attempts }`
- `{ type:'done', ok, elapsed, attempts }`

## Composition (all equivalent — one engine)

```ts
const base = { baseUrl, retry: { attempts: 3 } };
// A) extends
stitch({ extends: [base, authStrategy], path: '/x' });
// B) a seam — shares config AND runtime (one store, throttle, sink)
const api = seam(base);
api.stitch({ path: '/x', extends: [authStrategy] });
```

Merge: scalars replace, objects deep-merge, `hooks` CHAIN (onRequest base→child; onResponse/onError/onRetry child→base).

## drift(schema, opts)

`opts = { ignore?: string[], severity?: DriftSeverity | DriftSeverity[] | Partial<Record<'undeclared'|'coerced'|'defaulted', DriftSeverity>> }` where `DriftSeverity = 'warn'|'info'|'verbose'`.
Drift is schema-anchored — no snapshot (ADR 0015). Each call validates the unwrapped value against `schema`: a missing-required / incompatible value throws (`change:'invalid'`, **error**), and the call returns the VALIDATED value (coerced/defaulted/stripped). Then it diffs raw-vs-validated for soft drift: a stripped key → `undeclared` (**info**), a coercion → `coerced` (**warn**), a default fired → `defaulted` (**verbose**). Paths look like `data[].headline` (array indices render as `[]`, deduped). `ignore` silences paths; `severity` filters (a level/list) or re-levels (a map). Declared variance (optional absent, nullable null, empty/heterogeneous arrays) validates clean and yields no findings.

## Auth

`bearer(secret)`, `apiKey({ name?, in?, secret })` (`in: 'header' | 'query' | 'cookie'`, default `header`), `basic({ user, pass })`, `cookieSession({ login: <stitch>, cookie: 'sid', loginInput?: () => StitchInput, refresh?: [401] })`. Secrets: `env('VAR')` / `secretsFile('name')` return `() => string` resolved at call time. `cookieSession` auto-logs-in when no cookie is stored, replays the captured cookie, and re-logs-in when a response status is matched by `refresh`.

## Mock server

```ts
const server = await startMockServer(); // server.url = http://127.0.0.1:<port>
server.route('GET', '/x', behavior);
server.calls('/x');
server.callCount('/x');
server.reset();
await server.close();
```

`behavior`: `{ statuses?: number[] (successive; last repeats), delay?: number|number[] (ms), body?: value | array(per-call sequence) | (callIndex, req) => body, requireCookie?: {name,value?}, requireHeader?: {name,value?}, setCookie?: {name,value}, retryAfterSeconds?: number, headers?, stream?: { chunks, chunkDelay? (ms) } }`.

## Test conventions

- Put `process.env.STITCH_TRACE_FILE = join(tmpdir(), 'stitch-<suite>-'+process.pid+'.jsonl')` at the **very top, before importing `../src`**, to capture/quiet the JSONL trace.
- One `startMockServer()` per file in `beforeAll`; `server.reset()` in `beforeEach`; `server.close()` in `afterAll`.
- Keep retries fast: `retry: { baseDelay: 5 }`. Backoff jitter is random — assert attempt COUNTS and event PRESENCE, not exact delays. Use `delay` to create timing for throttle/timeout assertions.

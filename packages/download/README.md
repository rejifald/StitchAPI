# @stitchapi/download

Batch downloader / manager for [StitchAPI](https://stitchapi.dev), built on core's buffered
`download()` surface. It sequences a **list** of downloads with bounded concurrency and adds the
niceties a single `download()` call can't: FIFO admission, per-item settling, cancellation, aggregate
progress + ETA, a forward-progress **idle timeout**, and opt-in same-URL **dedupe**.

-   **Zero runtime dependencies.** `stitchapi` is a peer dep; nothing else ships.
-   **Browser-first.** The surface returns `Blob`s and never touches disk — the same code runs in Node
    and the browser.
-   **Rides core's resilience.** Every item is a real `download()` stitch, so retry / throttle / timeout
    / circuit / auth all apply per item — this package only orchestrates the batch.

```bash
pnpm add @stitchapi/download stitchapi
```

## One-shot: `downloadAll`

```ts
import { downloadAll } from '@stitchapi/download';

const batch = downloadAll(
    ['https://cdn.example.com/a.zip', 'https://cdn.example.com/b.zip'],
    {
        concurrency: 4,
        onProgress: (p) =>
            console.log(`${p.completed}/${p.count}`, p.etaMs, 'ms left'),
    },
);

const results = await batch; // never throws — settles per item, in enqueue order
for (const r of results) {
    if (r.status === 'fulfilled') save(r.value.blob, r.value.filename);
    else if (r.status === 'rejected')
        console.warn(r.id, r.code, r.retryable ? '(retryable)' : '(terminal)');
    // r.status === 'cancelled' → skipped
}
```

Each item is either a URL string or a partial `download()` config (`{ id?, baseUrl, path, retry, … }`).
Shared config goes in `defaults`; per-item fields win:

```ts
downloadAll([{ path: '/a' }, { path: '/b', retry: { attempts: 5 } }], {
    defaults: {
        baseUrl: 'https://api.example.com',
        throttle: { concurrency: 4, pool: 'host' },
    },
});
```

## Control

```ts
const batch = downloadAll(items, { concurrency: 2 });
batch.cancel(id); // cancel ONE — in-flight aborts and its slot goes to the next queued item;
//   a still-queued item just drops (no slot freed, next item not skipped)
batch.cancelAll(); // cancel everything — in-flight abort, queue drains
batch.snapshot(); // { progress, items:[{ id, phase, status? }] } — live
```

Pass an `AbortSignal` as `signal` to wire cancel-all to an external controller.

## Stateful: `DownloadManager`

Enqueue over time (the manager `downloadAll` is built on):

```ts
import { DownloadManager } from '@stitchapi/download';

const mgr = new DownloadManager({
    concurrency: 3,
    onItemSettled: (r) => log(r),
});
const handle = mgr.add('https://cdn.example.com/late.bin');
handle.cancel();
const result = await handle.done; // this item's ItemResult
await mgr.idle(); // resolves when the whole queue drains
```

## Forward-progress idle timeout

`download()`'s `timeout` is wall-clock — it fires on total elapsed time whether or not bytes are
arriving, so a healthy-but-slow download dies by the same clock as a dead stall. `idleTimeout` is
different: it resets on **every** progress chunk, so a slow stream survives while a genuinely stalled
one is aborted (surfacing as a retryable `IDLE_TIMEOUT`).

```ts
downloadAll(urls, { idleTimeout: 10_000 }); // abort an item after 10s of NO new bytes
```

## Error classification

The engine drops the underlying transport `cause` before a caller sees it, so an `ECONNRESET` looks
like any other `fetch failed`. This package captures the raw error per item (via a `hooks.onError`
seam) and classifies the rejection:

```ts
{ id, status: 'rejected', reason /* StitchError */, retryable: true, code: 'UND_ERR_SOCKET' }
```

`retryable` is `true` for transport faults, `5xx`, `429`, `408`, and idle-timeouts; `false` for
terminal `4xx`. `code` is a best-effort machine code (`UND_ERR_SOCKET`, `HTTP_404`, `IDLE_TIMEOUT`, …).

## Same-URL dedupe

By default every item is an **independent** fetch — predictable, no cross-item coupling. Opt in to
collapse duplicates onto a single in-flight request:

```ts
downloadAll([url, url], { dedupe: true }); // one request on the wire; both handles get the same Blob
```

## License

Apache-2.0

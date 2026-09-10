# @stitchapi/download

Batch downloader / manager for [StitchAPI](https://stitchapi.dev), built on core's buffered
`download()` surface. It sequences a **list** of downloads with bounded concurrency and adds the
niceties a single `download()` call can't: FIFO admission, per-item settling, cancellation, aggregate
progress + ETA, a forward-progress **idle timeout**, and opt-in same-URL **dedupe**.

- **Zero runtime dependencies.** `stitchapi` is a peer dep; nothing else ships.
- **Browser-first.** The surface returns `Blob`s and never touches disk — the same code runs in Node
  and the browser.
- **Rides core's resilience.** Every item is a real `download()` stitch, so retry / throttle / timeout
  / circuit / auth all apply per item — this package only orchestrates the batch.

```bash
pnpm add @stitchapi/download@rc stitchapi@rc
```

## One-shot: `downloadAll`

```ts
import { downloadAll } from '@stitchapi/download';

const batch = downloadAll(
    ['https://cdn.example.com/a.zip', 'https://cdn.example.com/b.zip'],
    {
        concurrency: 4,
        onProgress: (p) =>
            console.log(`${p.completed}/${p.count}`, p.eta, 'ms left'),
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
batch.cancel(); // omit the id to cancel EVERYTHING — in-flight abort, queue drains
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
await mgr.drained(); // resolves when the whole queue drains
```

## Forward progress: `idle`

`download()`'s `timeout` is wall-clock — it fires on total elapsed time whether or not bytes are
arriving, so a healthy-but-slow download dies by the same clock as a dead stall. `idle` is a
different clock: it resets on **every** progress chunk, so a slow stream survives while a genuinely
stalled one is aborted (surfacing as a retryable `IDLE_TIMEOUT`).

```ts
downloadAll(urls, { idle: '10s' }); // abort an item after 10s of NO new bytes
```

Two clocks, two words — the batch's `idle` and the stitch's wall-clock `timeout` (set per item, or
under `defaults`) never share a name, and both take `number | string`.

## Error classification

A bare `fetch failed` says nothing about whether retrying is worth it. This package captures the raw
transport error per item (via a `hooks.onError` seam, which also catches a thrown non-`Error`) and
classifies the rejection:

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

**Keyed off the resolved request**, not off how you spelled it. Items collapse when they resolve to
the same target — `defaults` merged under the item, then `baseUrl` + `path` (or a whole `url`), with
the query string sorted — so all of these are one fetch:

```ts
downloadAll([{ path: '/a' }, { path: '/a' }], {
    dedupe: true,
    defaults: { baseUrl: 'https://cdn.example.com' },
});
downloadAll([{ path: '/a?x=1&y=2' }, { path: '/a?y=2&x=1' }], { dedupe: true });
```

An item's own `id` still wins where it has one: naming two items alike declares them one download
(whatever their URLs), and naming them apart keeps them apart (whatever their URLs).

**Cancel is ref-counted.** Every sharer cancels independently and settles `cancelled` on its own; the
request on the wire is aborted only when the **last** sharer cancels. Cancelling the item that opened
the request does not fail the others — the fetch outlives it, and its progress and `idle` window pass
to a survivor.

**It coalesces requests in flight; it is not a cache.** Only items whose lifetimes overlap collapse.
An item admitted after the shared request has settled starts a fresh one — a just-finished `Blob` is
never replayed onto a later item, and neither is a just-finished failure. With `concurrency: 1`, two
identical items are therefore two requests: the second is admitted only once the first has settled.

## License

Apache-2.0

# @stitchapi/angular

Angular bindings for [StitchAPI](https://stitchapi.dev). `injectStitch` / `injectStitchStream` expose a stitch's lifecycle as **both Angular signals and an RxJS observable** from one shared execution, plus an optional [TanStack Query](https://tanstack.com/query) adapter.

**Streaming-first.** A `stitch` can stream (`sse` / `stream` surfaces) — `injectStitchStream` surfaces each `delta` chunk as it arrives. That's the differentiator over plain request/response query libraries.

These functions are a thin layer over [`@stitchapi/query-core`](../query-core), the framework-agnostic store that owns the reactive lifecycle. React / Vue / Svelte / Solid bindings are the same few lines against their own reactive primitive.

## Install

```sh
pnpm add @stitchapi/angular @stitchapi/query-core stitchapi @angular/core rxjs
```

`stitchapi`, `@angular/core` (`>=16`), and `rxjs` (`>=7`) are peer dependencies. `@tanstack/angular-query-experimental` is an **optional** peer — only needed if you use `queryOptions`.

## `injectStitch` — request / response

Call it in an injection context (a component field initializer). Pass the input as a **signal or getter** so the query re-fetches when it changes; read the result's signals in the template.

```ts
import { Component, input } from '@angular/core';
import { injectStitch } from '@stitchapi/angular';
import { stitch } from 'stitchapi';

const getUser = stitch({
    baseUrl: 'https://api.example.com',
    path: '/users/{id}',
});

@Component({
    selector: 'app-profile',
    template: `
        @if (user.isPending()) {
            <app-spinner />
        } @else if (user.isError()) {
            <button (click)="user.refetch()">Retry</button>
        } @else {
            <h1>{{ user.data()?.name }}</h1>
        }
    `,
})
export class ProfileComponent {
    readonly id = input.required<string>();
    readonly user = injectStitch(getUser, () => ({
        params: { id: this.id() },
    }));
}
```

The query is recreated (and re-fetched) when the input signal changes. The in-flight run is aborted when the component is destroyed.

## `injectStitchStream` — live deltas

```ts
import { Component, input } from '@angular/core';
import { injectStitchStream } from '@stitchapi/angular';
import { sse } from 'stitchapi/sse';

const chat = sse({ url: 'https://api.example.com/chat' });

@Component({
    selector: 'app-chat',
    template: `
        @for (c of tokens.chunks(); track $index) {
            <span>{{ c }}</span>
        }
        @if (tokens.isStreaming()) {
            <app-cursor />
        }
    `,
})
export class ChatComponent {
    readonly prompt = input.required<string>();
    readonly tokens = injectStitchStream(chat, () => ({
        body: { prompt: this.prompt() },
    }));
}
```

Same shape as `injectStitch`. `data()` is the accumulated chunks (`mode: 'append'`, default) or the latest chunk (`mode: 'replace'`); `chunks()` is the running list; `status()` is `'streaming'` until the terminal `result`, then `'success'`.

## Both signals and an observable

Every result exposes the same state two ways, from **one shared query execution**:

```ts
interface InjectStitchResult<T> {
    // signals
    state: Signal<StitchQueryState<T>>;
    data: Signal<T | undefined>;
    error: Signal<unknown>;
    status: Signal<'idle' | 'pending' | 'streaming' | 'success' | 'error'>;
    chunks: Signal<readonly unknown[]>;
    isPending: Signal<boolean>;
    isError: Signal<boolean>;
    isSuccess: Signal<boolean>;
    isStreaming: Signal<boolean>;
    // observable — for the async pipe / RxJS operators
    state$: Observable<StitchQueryState<T>>;
    // imperative
    refetch: () => void;
    cancel: () => void;
}
```

Read `user.data()` in a template, or `user.state$ | async` if you prefer RxJS — both reflect the same run.

## Optional: TanStack Query

`queryOptions(stitch, input)` returns a plain `{ queryKey, queryFn }` object — no import of `@tanstack/angular-query-experimental` required, so it works even if you never install it.

```ts
import { injectQuery } from '@tanstack/angular-query-experimental';
import { queryOptions } from '@stitchapi/angular';

readonly user = injectQuery(() =>
    queryOptions(getUser, { params: { id: this.id() } }),
);
```

## License

Apache-2.0

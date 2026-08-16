// The best available StitchAPI answer, as a caller would write it — the thing C8 counts and runs.
//
// Three decisions, and NONE of them is configuration. That is the finding: every other scenario in
// this pass had at least one lever in the config object, and this one has zero. The library's
// contribution here is that the seams EXIST and compose, not that any of them knows what a
// `Deprecation` header is.
//
//   • READING IT    — `kind: deprecationSurface(...)`. `interpret(res, cfg)` is the only hook that
//     sees `res.headers` AND decides the result (C1). Written once, and — because seam-level `kind`
//     is a compile error the runtime would otherwise honour (C4 f) — repeated on every member.
//   • REPORTING IT  — `trace: watch`, a `TraceSink` at the SEAM, so one sink covers every member
//     and `ctx.name` says which endpoint (C4). This half genuinely is configured once.
//   • ENFORCING IT  — `failAfterSunset` on the surface, reading the stitch's injected `clock`. It
//     does not burn retries and does not open the circuit (C5).
//
// The coupling to watch: the sink reads the notice off the `result` event's `data`, which only
// carries it because the surface folded it there — so `fold: true` and the sink are one unit, and
// an `output` contract that does not declare `_deprecation` silently breaks it (C4 d).
import { seam } from '../../../../packages/core/src/index';
import type {
    Adapter,
    Clock,
    Stitch,
} from '../../../../packages/core/src/types';
import { DeprecationWatch, deprecationSurface } from './deprecation';

export interface WatchedApiOptions {
    baseUrl: string;
    adapter: Adapter;
    clock: Clock;
    /** Endpoints to mint, `name` → `path`. */
    endpoints: readonly { name: string; path: string }[];
    /** Turn an announced sunset into a hard failure once it has passed. */
    failAfterSunset: boolean;
}

export interface WatchedApi {
    members: Map<string, Stitch>;
    watch: DeprecationWatch;
}

// >>> BEGIN USER CODE
/** A seam whose every member reads its own retirement notice, and one sink that reports the fleet. */
export function watchedApi(opts: WatchedApiOptions): WatchedApi {
    const watch = new DeprecationWatch(opts.clock);
    const api = seam({
        baseUrl: opts.baseUrl,
        adapter: opts.adapter,
        clock: opts.clock,
        trace: watch,
    });
    const surface = deprecationSurface({
        fold: true,
        failAfterSunset: opts.failAfterSunset,
    });
    const members = new Map<string, Stitch>();
    for (const e of opts.endpoints)
        members.set(
            e.name,
            api.stitch({ name: e.name, path: e.path, kind: surface }),
        );
    return { members, watch };
}
// <<< END USER CODE

// The assembled answer: parse both header formats, put the notice somewhere an accessor can see it,
// aggregate it across the fleet, and optionally trip after a sunset you chose.
//
// Everything between the USER CODE markers is what a caller writes. C8 counts it against
// `hand-rolled.ts`, which does the same job with no library at all — so the markers bracket only
// code someone maintains, never the fixtures or the types.
//
// The shape is forced by one measured fact (C1): NO StitchEvent, Inspection, RunReport, SafeResult
// or StitchError carries response headers. The only two places a response header is in scope are
// `hooks.onResponse` (`ctx.res.headers`) and a Surface's `interpret(res, cfg)` (`res.headers`). Of
// those two, only `interpret` can put what it found anywhere the rest of the library will carry, so
// the surface is the load-bearing seam and everything else here hangs off it.
import type {
    Surface,
    SurfaceOutcome,
} from '../../../../packages/core/src/index';
import { verdictOf } from '../../../../packages/core/src/surface';
import type {
    Clock,
    StitchEvent,
    TraceContext,
    TraceSink,
} from '../../../../packages/core/src/types';
import { DAY } from './fake-vendor';

/**
 * A parsed retirement notice. Dates are epoch ms or `null` — `null` means "the vendor did not say",
 * which is a different fact from "the date is zero" and the fleet report has to keep them apart.
 */
export interface Notice {
    /** When the endpoint was declared deprecated (RFC 9745), or `null`. */
    deprecatedAt: number | null;
    /** When it stops responding (RFC 8594), or `null` — deprecation without a sunset is legal. */
    sunsetAt: number | null;
    /** The `rel="successor-version"` URL, or `null`. */
    successor: string | null;
}

/** The key a folded notice rides under, on the value a deprecated endpoint returns. */
export const NOTICE_KEY = '_deprecation';

// >>> BEGIN USER CODE

// >>> BEGIN PARSERS  (C6 counts the executable lines between these two markers)
/**
 * RFC 9745 `Deprecation`. The header is a structured-field DATE: an `@` sigil followed by
 * seconds since the epoch (`@1735689600`). Several vendors still emit the pre-RFC draft spelling,
 * an HTTP-date, in the same header — so both are accepted, and neither is guessed at.
 */
export function parseDeprecation(value: string | undefined): number | null {
    if (value === undefined) return null;
    const raw = value.trim();
    // sf-date: `@` + an sf-integer of SECONDS. The `-?` matters — a date before 1970 is legal
    // syntax, and silently dropping the sign would move a 1969 notice to 1971.
    const sf = /^@(-?\d+)$/.exec(raw);
    if (sf?.[1] !== undefined) return Number(sf[1]) * 1000;
    const http = Date.parse(raw);
    return Number.isNaN(http) ? null : http;
}

/**
 * RFC 8594 `Sunset`. Always an HTTP-date, never a structured-field date — the two RFCs genuinely
 * disagree on format, which is the trap this scenario is built around.
 */
export function parseSunset(value: string | undefined): number | null {
    if (value === undefined) return null;
    const at = Date.parse(value.trim());
    return Number.isNaN(at) ? null : at;
}

/** The `rel="successor-version"` target out of a `Link` header, if one is there. */
export function parseSuccessor(value: string | undefined): string | null {
    if (value === undefined) return null;
    const m = /<([^>]+)>\s*;[^,]*rel\s*=\s*"?successor-version"?/.exec(value);
    return m?.[1] ?? null;
}

/**
 * Read a whole notice off a response's headers, or `null` when the vendor said nothing.
 *
 * A `Sunset` with no `Deprecation` still counts: RFC 8594 stands alone, and an endpoint that
 * announces only its removal date is the more urgent case, not the less.
 */
export function readNotice(headers: Record<string, string>): Notice | null {
    const deprecatedAt = parseDeprecation(headers['deprecation']);
    const sunsetAt = parseSunset(headers['sunset']);
    if (deprecatedAt === null && sunsetAt === null) return null;
    return {
        deprecatedAt,
        sunsetAt,
        successor: parseSuccessor(headers['link']),
    };
}
// <<< END PARSERS

export interface DeprecationSurfaceOptions {
    /**
     * Fold the notice into the returned value under {@link NOTICE_KEY}, so every accessor
     * downstream — the awaited value, `.inspect()`, the `result` event, and therefore a `TraceSink`
     * — can see it. Off by default: it changes the caller's result type, which is a real cost.
     */
    fold?: boolean;
    /**
     * Called with every notice seen, endpoint name first. The side channel that does NOT touch the
     * caller's payload — the surface is the only place a response header is in scope, so if the
     * notice must not ride the value, this is the only way out.
     */
    onNotice?: (endpoint: string, notice: Notice) => void;
    /**
     * FAIL the call once this instant has passed (epoch ms), read off the stitch's `clock`. A
     * deliberate tripwire for a sunset you have decided to treat as a deadline — never a default,
     * because RFC 9745 is explicit that the header is a hint and not a guarantee.
     */
    failAfterSunset?: boolean;
}

/**
 * A surface that reads the retirement notice off the response.
 *
 * `interpret(res, cfg)` is the ONE hook in the library that sees `res.headers` AND decides what the
 * call returns, so it is where all of this has to live. It composes `verdictOf` first — an
 * `interpret` REPLACES the default rather than layering on it, so skipping that would silently
 * discard the stitch's own `verdict` config and turn every 4xx into a success.
 */
export function deprecationSurface(
    opts: DeprecationSurfaceOptions = {},
): Surface {
    return {
        id: 'http+deprecation',
        interpret: (res, cfg): SurfaceOutcome => {
            const failed = verdictOf(res, cfg);
            if (failed) return failed;
            const notice = readNotice(res.headers);
            if (notice === null) return { ok: true, data: res.body };
            const name = cfg.name ?? 'stitch';
            opts.onNotice?.(name, notice);
            if (
                opts.failAfterSunset === true &&
                notice.sunsetAt !== null &&
                (cfg.clock?.now() ?? Date.now()) >= notice.sunsetAt
            )
                return {
                    ok: false,
                    message: `${name}: sunset passed (${new Date(notice.sunsetAt).toISOString()})`,
                    status: res.status,
                };
            if (opts.fold !== true) return { ok: true, data: res.body };
            return {
                ok: true,
                data: { ...(res.body as object), [NOTICE_KEY]: notice },
            };
        },
    };
}

/** One row of the fleet report. */
export interface FleetRow {
    endpoint: string;
    notice: Notice;
    /** Calls seen against this endpoint — the de-duplication denominator (C7). */
    calls: number;
}

/**
 * The fleet view: which endpoints are retiring, and which one goes first.
 *
 * A `TraceSink` is configured once (on a stitch or a whole seam), receives `handle(event, ctx)` for
 * every event of every call through it, and `ctx.name` says which endpoint — the same cross-call
 * seam scenario 12 used to turn per-call drift findings into a rate. What does NOT transfer is the
 * payload: no event carries headers, so this reads the notice off the `result` event's `data`,
 * which only works when the surface was built with `fold: true`. That coupling is the finding, not
 * an implementation detail.
 *
 * De-duplication is the `Map` keyed by endpoint. One row per endpoint however many calls arrive,
 * which is the difference between a fleet report and a log line per request.
 */
export class DeprecationWatch implements TraceSink {
    private readonly rows = new Map<string, FleetRow>();
    private readonly clock: Clock | undefined;

    constructor(clock?: Clock) {
        this.clock = clock;
    }

    handle(event: StitchEvent, ctx: TraceContext): void {
        if (event.type !== 'result') return;
        const notice = noticeOf(event.data);
        if (notice === null) return;
        const prior = this.rows.get(ctx.name);
        this.rows.set(ctx.name, {
            endpoint: ctx.name,
            notice,
            calls: (prior?.calls ?? 0) + 1,
        });
    }

    /** Deprecated endpoints, soonest sunset first. One row per endpoint, never per call. */
    fleet(): FleetRow[] {
        return [...this.rows.values()].sort(
            (a, b) =>
                (a.notice.sunsetAt ?? Infinity) -
                (b.notice.sunsetAt ?? Infinity),
        );
    }

    /** The one line an operator reads: how many are retiring, and how long until the first one. */
    summary(): string {
        const rows = this.fleet();
        if (rows.length === 0) return 'no deprecated endpoints';
        const first = rows[0];
        if (first === undefined) return 'no deprecated endpoints';
        const names = rows.map((r) => r.endpoint).join(', ');
        if (first.notice.sunsetAt === null)
            return `${String(rows.length)} endpoints deprecated (${names}), no sunset announced`;
        const days = Math.round(
            (first.notice.sunsetAt - (this.clock?.now() ?? Date.now())) / DAY,
        );
        return `${String(rows.length)} endpoints deprecated (${names}), earliest sunset in ${String(days)} days: ${first.endpoint}`;
    }
}

/** Pull a folded notice back off a result value, or `null` when there is not one there. */
export function noticeOf(data: unknown): Notice | null {
    if (typeof data !== 'object' || data === null) return null;
    const found = (data as Record<string, unknown>)[NOTICE_KEY];
    if (typeof found !== 'object' || found === null) return null;
    return found as Notice;
}

// <<< END USER CODE

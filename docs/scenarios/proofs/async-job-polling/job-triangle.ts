// USER CODE — the best answer this scenario has from the public API. Three stitches under `linked`,
// one caller-owned `AbortSignal` as the operation deadline, and a poll surface that carries the
// three rules the built-ins do not: in-band `InProgress` is a retry, in-band `Failed` is a failure,
// and the wait comes from `Retry-After` in SECONDS with a capped exponential fallback.
//
// Nothing here is exotic — every piece is a documented seam (`Surface.interpret`, `hooks.onResponse`,
// `StitchInput.signal`, `linked`). What the file exists to show is HOW MUCH of it there is, so C9's
// comparison against a hand-rolled `while` is a line count rather than an opinion.
import { stitch } from '../../../../packages/core/src/index';
import { linked } from '../../../../packages/core/src/pipe';
import type { Surface } from '../../../../packages/core/src/surface';
import { verdictOf } from '../../../../packages/core/src/surface';
import type {
    Adapter,
    Clock,
    StitchStore,
    TraceSink,
} from '../../../../packages/core/src/types';
import { errorMessageOf, resultUrlOf, stateOf } from './fake-jobs';

/**
 * Read `Retry-After` as the wait for the NEXT poll. Two things this must get right and neither is
 * done for you: the header is delta-SECONDS (a bare `'30'` handed to `after` means 30ms — C3(c)),
 * and the HTTP-date form is unparseable by `parseDuration`, so it must be converted here or the
 * server's pacing is silently discarded (C3(d)). Returns `undefined` to fall through to `backoff`.
 */
export function retryAfterMs(
    header: string | undefined,
    clock: Clock,
): number | undefined {
    if (header === undefined) return undefined;
    if (/^\d+$/.test(header.trim())) return Number(header.trim()) * 1000;
    const at = Date.parse(header);
    return Number.isNaN(at) ? undefined : Math.max(0, at - clock.now());
}

/**
 * The poll loop as a surface. `verdictOf` first, so a `verdict`-declared status still rules and a
 * 404 does not come back as a successful poll (C2(e)).
 */
export function jobPollSurface(clock: Clock): Surface {
    return {
        id: 'job-poll',
        interpret: (res, cfg) => {
            const failed = verdictOf(res, cfg);
            if (failed) return failed;
            const state = stateOf(res.body);
            if (state === 'InProgress') {
                const after = retryAfterMs(res.headers['retry-after'], clock);
                return after === undefined
                    ? { ok: false, retry: true, message: 'InProgress' }
                    : { ok: false, retry: true, message: 'InProgress', after };
            }
            if (state === 'Failed')
                return {
                    ok: false,
                    message: `job failed: ${errorMessageOf(res.body)}`,
                    status: res.status,
                };
            return { ok: true, data: res.body };
        },
    };
}

/**
 * The operation deadline: an `AbortSignal` that fires after `ms` on the INJECTED clock. There is no
 * config field for a budget spanning three stitches (C5(c)), and `AbortSignal.timeout` is wall-clock
 * only — so an hour-long budget is only testable if the timer is the stitch's own clock.
 */
export function operationDeadline(ms: number, clock: Clock): AbortSignal {
    const ctrl = new AbortController();
    const timer = clock.setTimer(() => {
        ctrl.abort(new Error(`job budget of ${ms}ms exhausted`));
    }, ms);
    ctrl.signal.addEventListener('abort', () => {
        clock.clearTimer(timer);
    });
    return ctrl.signal;
}

export interface JobTriangleOptions {
    /** Where `POST /jobs` lives. */
    submitUrl: string;
    /** Origin the `Location` header is resolved against. */
    host: string;
    adapter: Adapter;
    clock: Clock;
    /** Poll bound. Reached before the deadline, this is what ends the operation. */
    pollAttempts: number;
    /** Whole-operation budget (ms) — submit + every poll + the download. */
    budgetMs: number;
    /** Fallback poll spacing when the server sends no `Retry-After`. */
    backoff: { base: number | string; max: number | string };
    /** Where the job id is persisted so a restart can reattach (C8(b)). */
    store?: StitchStore;
    /** Key under `store` for the job's `Location`. */
    storeKey?: string;
    /** One sink for all three stitches, so the operation's trace chain is observable (C6). */
    trace?: TraceSink;
}

/** What one run of the triangle produced. */
export interface JobTriangleResult<T = unknown> {
    /** The downloaded payload. */
    data: T;
    /** The job's `Location`, for a resume that skips the submit. */
    location: string;
}

/**
 * Submit → poll to a terminal state → download, as one operation. Fails fast on an in-band `Failed`,
 * on the poll budget, and on the deadline. Pass `resumeFrom` to reattach to a job already submitted
 * — the submit is skipped entirely, which is the whole point of persisting the id.
 */
export function jobTriangle(opts: JobTriangleOptions) {
    const { adapter, clock, host } = opts;
    const key = opts.storeKey ?? 'job:location';
    let location = '';

    const trace = opts.trace;

    const submit = stitch({
        name: 'job-submit',
        url: opts.submitUrl,
        method: 'POST',
        adapter,
        clock,
        ...(trace === undefined ? {} : { trace }),
        // A stable key so a restarted process's resubmit is collapsible server-side (C8(d)).
        idempotency: { keyOf: (input) => `job:${JSON.stringify(input.body)}` },
        hooks: {
            onResponse: (ctx) => {
                const loc = ctx.res?.headers['location'];
                if (loc === undefined) return;
                location = loc;
                void opts.store?.set(key, loc, opts.budgetMs);
            },
        },
    });

    const poll = stitch({
        name: 'job-poll',
        url: `${host}{+loc}`, // `{+}` = reserved expansion: the slashes survive (C1(f))
        kind: jobPollSurface(clock),
        adapter,
        clock,
        ...(trace === undefined ? {} : { trace }),
        retry: {
            attempts: opts.pollAttempts,
            backoff: { curve: 'expo', ...opts.backoff },
        },
    });

    const download = stitch({
        name: 'job-download',
        url: '{+u}',
        adapter,
        clock,
        ...(trace === undefined ? {} : { trace }),
        // The link is single-use: one shot, and a 404 is permanent (C7).
        retry: { attempts: 1 },
    });

    return {
        submit,
        poll,
        download,
        /** Run the operation. `resumeFrom` skips the submit and polls an existing job. */
        run: (body: unknown, resumeFrom?: string): Promise<JobTriangleResult> =>
            linked(async (run) => {
                const signal = operationDeadline(opts.budgetMs, clock);
                if (resumeFrom === undefined)
                    await run(submit, { body, signal });
                else location = resumeFrom;
                const status = await run(poll, {
                    params: { loc: location },
                    signal,
                });
                const url = resultUrlOf(status);
                if (url === undefined)
                    throw new Error('JobComplete with no resultUrl');
                const data = await run(download, {
                    params: { u: url },
                    signal,
                });
                return { data, location };
            }),
    };
}

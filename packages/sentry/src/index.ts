// @stitchapi/sentry — a Sentry TraceSink for StitchAPI.
//
// The logger sinks (`@stitchapi/pino`, core's `loggerSink`) and the OTLP bridge
// cover logs and traces; Sentry's model is different — a trail of **breadcrumbs**
// leading up to a **captured error**. This sink maps the stitch event stream onto
// that: routine events become breadcrumbs (category `stitch`), and an `error` event
// is captured as a Sentry issue with the call's context — so the breadcrumb trail is
// attached automatically.
//
// Bring your own Sentry. The sink imports no SDK — it talks to a tiny structural
// {@link SentryLike} surface that `@sentry/node`, `@sentry/browser`, `@sentry/react`,
// and friends all satisfy (`import * as Sentry from '@sentry/node'`). So there is no
// `@sentry/*` dependency, and a test double is a drop-in.
//
// SECURITY: a custom TraceSink receives the RAW event — core only redacts inside its
// own built-in sinks. So this sends **metadata only** (name, method, redacted URL,
// status, attempt counts, drift path/level/change, phase, timing) and NEVER
// `event.input` (its headers carry the live `authorization`/`cookie`), `event.value`,
// or a `delta` chunk. The URL query string is dropped (it can carry `?api_key=…`).
import type { StitchEvent, TraceContext, TraceSink } from 'stitchapi';

// ---------------------------------------------------------------------------
// Sentry contract (structural — any @sentry/* SDK satisfies it)
// ---------------------------------------------------------------------------

/** Sentry severity levels. */
export type SentryLevel = 'fatal' | 'error' | 'warning' | 'info' | 'debug';

/** A Sentry breadcrumb (the subset this sink sets). */
export interface SentryBreadcrumb {
    category?: string;
    message?: string;
    level?: SentryLevel;
    type?: string;
    data?: Record<string, unknown>;
}

/** The capture context this sink passes to `captureMessage`. */
export interface SentryCaptureContext {
    level?: SentryLevel;
    tags?: Record<string, string | number | boolean>;
    extra?: Record<string, unknown>;
}

/** The minimal slice of a Sentry SDK this sink calls — declared structurally so a
 * real `@sentry/node` / `@sentry/browser` / `@sentry/react` namespace, a Hub, and a
 * plain test double are all interchangeable. */
export interface SentryLike {
    addBreadcrumb(breadcrumb: SentryBreadcrumb): void;
    captureMessage(
        message: string,
        context?: SentryCaptureContext | SentryLevel,
    ): unknown;
}

/** Options for {@link sentrySink}. */
export interface SentrySinkOptions {
    /**
     * Breadcrumb the happy-path lifecycle (`start` / `result` / `done`). Default
     * `false` — these are noisy in Sentry, where breadcrumbs matter most just before
     * an error. Retries, circuit trips, and drift findings are always breadcrumbed.
     */
    lifecycle?: boolean;
    /**
     * Capture `error` events as Sentry issues via `captureMessage`. Default `true`.
     * Set `false` to only leave breadcrumbs (e.g. when your framework already reports
     * the error to Sentry and you just want the stitch trail).
     */
    captureErrors?: boolean;
    /**
     * Also capture an **error-level** `drift` finding (a breaking API change) as its
     * own Sentry issue, not just a breadcrumb. Default `false`.
     */
    captureDrift?: boolean;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Drop the query string (it may carry secrets, e.g. `?api_key=…`). */
function redactUrl(url: string): string {
    const q = url.indexOf('?');
    return q === -1 ? url : `${url.slice(0, q)}?…`;
}

const DRIFT_TO_SENTRY: Record<string, SentryLevel> = {
    error: 'error',
    warn: 'warning',
    info: 'debug',
};

/** Build the metadata-only breadcrumb for an event, or `null` to skip it. */
function breadcrumbFor(
    name: string,
    event: StitchEvent,
    lifecycle: boolean,
): SentryBreadcrumb | null {
    switch (event.type) {
        case 'start':
            return lifecycle
                ? {
                      category: 'stitch',
                      level: 'info',
                      message: `→ ${name} ${event.method} ${redactUrl(event.url)}`,
                      data: { method: event.method, url: redactUrl(event.url) },
                  }
                : null;
        case 'progress':
            return {
                category: 'stitch',
                level:
                    event.phase === 'retry' || event.phase === 'circuit'
                        ? 'warning'
                        : 'debug',
                message: `· ${name} ${event.phase}#${event.attempt}`,
                data: {
                    phase: event.phase,
                    attempt: event.attempt,
                    ...(event.waited !== undefined
                        ? { waited: event.waited }
                        : {}),
                },
            };
        case 'drift': {
            const f = event.finding;
            return {
                category: 'stitch.drift',
                level: DRIFT_TO_SENTRY[f.level] ?? 'debug',
                message: `drift ${name} ${f.path} ${f.change}`,
                data: {
                    path: f.path,
                    level: f.level,
                    change: f.change,
                    ...(f.detail !== undefined ? { detail: f.detail } : {}),
                },
            };
        }
        case 'result':
            return lifecycle
                ? {
                      category: 'stitch',
                      level: 'info',
                      message: `← ${name} ${event.status} (${event.attempts} attempt(s))`,
                      data: { status: event.status, attempts: event.attempts },
                  }
                : null;
        case 'error':
            // Always breadcrumb the error too, so it shows in the trail of any later issue.
            return {
                category: 'stitch',
                level: 'error',
                message: `✗ ${name} ${event.name}: ${event.message}`,
                data: {
                    ...(event.status !== undefined
                        ? { status: event.status }
                        : {}),
                    attempts: event.attempts,
                },
            };
        case 'done':
            return lifecycle
                ? {
                      category: 'stitch',
                      level: 'debug',
                      message: `done ${name} (${event.ok ? 'ok' : 'failed'}, ${event.elapsed}ms)`,
                      data: {
                          ok: event.ok,
                          elapsed: event.elapsed,
                          attempts: event.attempts,
                      },
                  }
                : null;
        default:
            // 'info' (strategy announcement) + 'delta' (raw response data) → never sent.
            return null;
    }
}

// ---------------------------------------------------------------------------
// the sink
// ---------------------------------------------------------------------------

/**
 * A {@link TraceSink} that forwards the stitch event stream to Sentry: routine events
 * become breadcrumbs, and an `error` event is captured as an issue with the call's
 * context (so the breadcrumb trail attaches). Bring any `@sentry/*` SDK:
 *
 * ```ts
 * import * as Sentry from '@sentry/node';
 * import { seam } from 'stitchapi';
 * import { sentrySink } from '@stitchapi/sentry';
 *
 * const api = seam({ baseUrl: 'https://api.example.com', trace: sentrySink(Sentry) });
 * ```
 *
 * The same sink works on a single stitch (`stitch({ trace: sentrySink(Sentry) })`).
 */
export function sentrySink(
    sentry: SentryLike,
    options: SentrySinkOptions = {},
): TraceSink {
    const lifecycle = options.lifecycle ?? false;
    const captureErrors = options.captureErrors ?? true;
    const captureDrift = options.captureDrift ?? false;

    return {
        handle(event: StitchEvent, ctx: TraceContext): void {
            const crumb = breadcrumbFor(ctx.name, event, lifecycle);
            if (crumb) sentry.addBreadcrumb(crumb);

            if (event.type === 'error' && captureErrors) {
                sentry.captureMessage(
                    `${ctx.name}: ${event.name} — ${event.message}`,
                    {
                        level: 'error',
                        tags: {
                            stitch: ctx.name,
                            ...(event.status !== undefined
                                ? { status: event.status }
                                : {}),
                        },
                        extra: {
                            attempts: event.attempts,
                            ...(ctx.runId ? { runId: ctx.runId } : {}),
                        },
                    },
                );
            } else if (
                event.type === 'drift' &&
                event.finding.level === 'error' &&
                captureDrift
            ) {
                sentry.captureMessage(
                    `${ctx.name}: drift ${event.finding.path} ${event.finding.change}`,
                    {
                        level: 'warning',
                        tags: { stitch: ctx.name, drift: event.finding.change },
                        extra: {
                            path: event.finding.path,
                            ...(event.finding.detail !== undefined
                                ? { detail: event.finding.detail }
                                : {}),
                        },
                    },
                );
            }
        },
    };
}

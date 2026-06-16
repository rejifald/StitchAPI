/**
 * output-format.ts — pure, framework-free helpers for the StitchPlayground output panel.
 *
 * NO React import. All exports are plain TypeScript functions usable in Node/tsx tests.
 * The component (StitchPlayground.tsx) calls these and passes the resulting strings to JSX.
 *
 * Types imported from ./runner (FROZEN — do not redefine).
 */
import type {
    LogEntry,
    RunEvent,
    RunNotice,
    RunResult,
    StitchTraceEntry,
} from './runner';

/* -------------------------------------------------------------------------- */
/*  traceToMermaid                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Build a Mermaid `flowchart TD` string from a stitch trace.
 *
 * Nodes are labelled by HTTP method + request path (e.g. `GET /users/2`) so
 * stitches that share a `name` (e.g. siblings derived via `extends`) stay
 * distinct and readable. A non-HTTP `shell` surface (ADR 0008) is labelled
 * `$ <command>` instead; when no request/url is present the label falls back to
 * the entry's `label` (name), then its `id`. Per-iteration counts are appended
 * as node annotations (ADR 0007 Decision 6): `⟳` streamed chunks, `↻` retry
 * attempts, `⊞` paginate pages.
 *
 * Edges are derived from `StitchTraceEntry.dependsOn`, which now carries REAL
 * runtime causality — the run-identity span tree of ADR 0007 (a `cookieSession`
 * login, or a `pipe()` step→step chain draws parent → child) — not the old
 * synthetic FIFO heuristic.
 *
 * Deterministic: entries are iterated in their array order; node ids are
 * sanitised to safe Mermaid identifiers (replacing non-alphanumeric chars
 * with underscores so re-runs produce the same string).
 *
 * Empty / absent trace → a valid placeholder graph so the DAG block never
 * causes a Mermaid parse error.
 */
export function traceToMermaid(trace: StitchTraceEntry[]): string {
    if (!trace || trace.length === 0) {
        return 'flowchart TD\n  _empty["(no trace)"]';
    }

    const lines: string[] = ['flowchart TD'];

    // Sanitise an id to a safe Mermaid node identifier.
    const safeid = (raw: string) => raw.replace(/[^A-Za-z0-9_]/g, '_');

    // Reduce a request URL to its path (+ search). Full URLs are parsed; bare
    // paths (e.g. "/users/2") are used as-is. NEVER throws.
    const urlToPath = (url: string): string => {
        try {
            const u = new URL(url);
            return u.pathname + u.search;
        } catch {
            return url;
        }
    };

    // The readable label fragment for a request. Most surfaces are HTTP, so it's
    // `METHOD /path` (the `llm` surface included — it POSTs to a provider
    // endpoint). A `shell` surface (ADR 0008) has a `shell:<command>` pseudo-url
    // and no HTTP method that means anything, so render it `$ <command>` —
    // otherwise `new URL('shell:git').pathname` would mislabel a subprocess as
    // `GET git`.
    const requestLabel = (req: { method: string; url: string }): string =>
        req.url.startsWith('shell:')
            ? `$ ${req.url.slice('shell:'.length)}`
            : `${req.method} ${urlToPath(req.url)}`;

    for (const entry of trace) {
        const nid = safeid(entry.id);
        // Build a label: prefer the request's "METHOD /path" (or "$ command"),
        // falling back to entry.label (name), then entry.id when no usable url
        // is present (a composed step that made no HTTP / shell call).
        const req = entry.request;
        const baseLabel =
            req && req.url ? requestLabel(req) : (entry.label ?? entry.id);
        // Node annotations (ADR 0007 Decision 6): per-iteration counts ride the
        // label exactly as the stream-chunk count does — the detailed
        // per-attempt / per-page waterfall lives in the OTLP export, not here.
        //   ⟳N  N streamed response chunks
        //   ↻N  N attempts — the call was retried (present only when > 1)
        //   ⊞N  N pages fetched by `paginate`
        const streamMarker = entry.stream ? ` ⟳${entry.stream.chunks}` : '';
        const attemptsMarker = entry.attempts ? ` ↻${entry.attempts}` : '';
        const pagesMarker = entry.pages ? ` ⊞${entry.pages}` : '';
        // Escape quotes inside the label so Mermaid doesn't choke.
        const escapedLabel = (
            baseLabel +
            streamMarker +
            attemptsMarker +
            pagesMarker
        ).replace(/"/g, "'");
        lines.push(`  ${nid}["${escapedLabel}"]`);
    }

    // Emit edges from dependsOn.
    for (const entry of trace) {
        if (entry.dependsOn && entry.dependsOn.length > 0) {
            const nid = safeid(entry.id);
            for (const dep of entry.dependsOn) {
                lines.push(`  ${safeid(dep)} --> ${nid}`);
            }
        }
    }

    return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/*  formatLog / formatValue                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Render one `LogEntry` as a single display string.
 * Objects are pretty-printed (JSON, 2-space indent); primitives are coerced.
 * Multiple args are space-joined — mirrors how `console.log` formats them.
 */
export function formatLog(entry: LogEntry): string {
    const prefix = entry.level !== 'log' ? `[${entry.level}] ` : '';
    const body = entry.args
        .map((a) => {
            if (a === undefined) return 'undefined';
            if (a === null) return 'null';
            if (typeof a === 'string') return a;
            try {
                return JSON.stringify(a, null, 2);
            } catch {
                return String(a);
            }
        })
        .join(' ');
    return prefix + body;
}

/**
 * Render an arbitrary resolved value as a display string.
 * - `undefined` → explicit "(undefined)"
 * - strings → passed through as-is
 * - objects / arrays → pretty-printed JSON (2-space indent)
 * - everything else → String coercion
 */
export function formatValue(value: unknown): string {
    if (value === undefined) return '(undefined)';
    if (value === null) return 'null';
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

/* -------------------------------------------------------------------------- */
/*  summarizeNotices                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Turn `RunNotice[]` into human-readable strings for the notices strip.
 * Examples:
 *   { kind: 'shim', surface: 'keychain', message: '…' }
 *     → "ran `keychain` shimmed — keychain is simulated in the browser sandbox"
 *   { kind: 'info', message: '…' }
 *     → the raw message
 */
export function summarizeNotices(notices?: RunNotice[]): string[] {
    if (!notices || notices.length === 0) return [];
    return notices.map((n) => {
        if (n.kind === 'shim' && n.surface) {
            return `ran \`${n.surface}\` shimmed — ${n.message}`;
        }
        return n.message;
    });
}

/* -------------------------------------------------------------------------- */
/*  RunView — shapes RunResult for the component to render                    */
/* -------------------------------------------------------------------------- */

export interface RunView {
    /** Formatted log lines in execution order. */
    logs: string[];
    /** Formatted resolved value text, or null when absent. */
    valueText: string | null;
    /** Error text (name + message + optional reason), or null when no error. */
    errorText: string | null;
    /** Human-readable notice strings (empty when none). */
    notices: string[];
    /** Mermaid flowchart string (always a valid graph string). */
    mermaid: string;
    /**
     * True when any trace entry carries `.stream` — i.e. at least one stitch()
     * call observed a chunked/SSE/LLM response.
     * NOTE: `CodeRunner.run` is single-shot (resolves once with a fully assembled
     * RunResult). True incremental UI streaming (rendering partial chunks as they
     * arrive) requires a streaming contract extension — see the U1 implementation
     * report for details.
     */
    isStreaming: boolean;
}

/**
 * Shape a `RunResult` into the flat `RunView` the component renders.
 * All fields are always present; callers do not need to guard individual fields.
 */
export function buildRunView(result: RunResult): RunView {
    // Logs
    const logs = result.logs.map(formatLog);

    // Value
    const valueText =
        result.value !== undefined ? formatValue(result.value) : null;

    // Error — include phase and reason for richer context.
    let errorText: string | null = null;
    if (result.error) {
        const { name, message, phase, reason } = result.error;
        const reasonPart = reason ? ` (${reason})` : '';
        errorText = `${name}: ${message}\n[phase: ${phase}${reasonPart}]`;
    }

    // Notices
    const notices = summarizeNotices(result.notices);

    // Trace → Mermaid + streaming flag
    const trace = result.trace ?? [];
    const mermaid = traceToMermaid(trace);
    const isStreaming = trace.some((e) => e.stream !== undefined);

    return { logs, valueText, errorText, notices, mermaid, isStreaming };
}

/* -------------------------------------------------------------------------- */
/*  Incremental accumulator — emptyRunView / applyEvent                       */
/* -------------------------------------------------------------------------- */

/**
 * Extended RunView that carries internal incremental state not surfaced in the
 * rendered fields:
 *   - `_traceEntries` — accumulated StitchTraceEntry[] so traceToMermaid can be
 *     recomputed on every `trace` event without losing prior entries.
 *   - `_streamChunks` — Map<traceId, string> keeping per-stream accumulated text
 *     in order; the sentinel key "" is used when traceId is absent.
 *
 * The extra fields are prefixed `_` and excluded from the public RunView surface
 * so consuming code (the component) never needs to know about them.
 */
interface RunViewInternal extends RunView {
    _traceEntries: StitchTraceEntry[];
    _streamChunks: Map<string, string>;
}

/**
 * Return the initial, empty RunView before any event has been received.
 * Safe to pass to `applyEvent` immediately.
 */
export function emptyRunView(): RunView {
    const internal: RunViewInternal = {
        logs: [],
        valueText: null,
        errorText: null,
        notices: [],
        mermaid: traceToMermaid([]),
        isStreaming: false,
        _traceEntries: [],
        _streamChunks: new Map(),
    };
    return internal;
}

/**
 * Fold a single `RunEvent` into the current `RunView` immutably, returning a
 * new view with the event applied. Framework-free; call from a React setState
 * updater or any other state management approach.
 *
 * Event semantics:
 *   - `log`    → append a formatted log line.
 *   - `chunk`  → append streamed text for the given traceId (key "" when absent),
 *                set isStreaming=true on the first chunk ever received.
 *   - `trace`  → append the StitchTraceEntry and recompute the Mermaid DAG.
 *   - `notice` → append the summarized notice string.
 *
 * The internal `_traceEntries` and `_streamChunks` maps are copied so each
 * returned view is fully independent of the prior one (immutable fold).
 */
export function applyEvent(view: RunView, event: RunEvent): RunView {
    // Cast to internal to access accumulated state; it was created by emptyRunView
    // or a prior applyEvent call, so the hidden fields are always present.
    const prev = view as RunViewInternal;

    switch (event.type) {
        case 'log': {
            return {
                ...prev,
                logs: [...prev.logs, formatLog(event.entry)],
            } as RunViewInternal;
        }

        case 'chunk': {
            const key = event.traceId ?? '';
            const prevText = prev._streamChunks.get(key) ?? '';
            const newChunks = new Map(prev._streamChunks);
            newChunks.set(key, prevText + event.text);
            // Concatenate all chunk streams in insertion order for valueText.
            const streamedText = Array.from(newChunks.values()).join('');
            return {
                ...prev,
                valueText: streamedText,
                isStreaming: true,
                _streamChunks: newChunks,
            } as RunViewInternal;
        }

        case 'trace': {
            const newTraceEntries = [...prev._traceEntries, event.entry];
            const newMermaid = traceToMermaid(newTraceEntries);
            // isStreaming grows monotonically — true if already set OR this entry has stream.
            const nowStreaming =
                prev.isStreaming || event.entry.stream !== undefined;
            return {
                ...prev,
                mermaid: newMermaid,
                isStreaming: nowStreaming,
                _traceEntries: newTraceEntries,
            } as RunViewInternal;
        }

        case 'notice': {
            const newNotices = summarizeNotices([event.notice]);
            return {
                ...prev,
                notices: [...prev.notices, ...newNotices],
            } as RunViewInternal;
        }

        default: {
            // Exhaustiveness guard — unknown event types are ignored safely.
            return prev;
        }
    }
}

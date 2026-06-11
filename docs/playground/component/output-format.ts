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
    RunNotice,
    RunResult,
    StitchTraceEntry,
} from './runner';

/* -------------------------------------------------------------------------- */
/*  traceToMermaid                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Build a Mermaid `flowchart TD` string from a stitch trace.
 * Nodes are labelled with the entry id (and label when present).
 * Edges are derived from `StitchTraceEntry.dependsOn`.
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

    for (const entry of trace) {
        const nid = safeid(entry.id);
        // Build a label: prefer entry.label, fall back to entry.id.
        // Annotate streaming entries with a ⟳ marker.
        const baseLabel = entry.label ?? entry.id;
        const streamMarker = entry.stream ? ` ⟳${entry.stream.chunks}` : '';
        // Escape quotes inside the label so Mermaid doesn't choke.
        const escapedLabel = (baseLabel + streamMarker).replace(/"/g, "'");
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

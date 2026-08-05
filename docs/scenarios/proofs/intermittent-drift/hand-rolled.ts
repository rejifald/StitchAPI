// The same canary detector with no library at all — the baseline C8 prices against.
//
// Feature parity with `c8-assembled.ts`: call the endpoint, validate against a declared shape,
// classify each difference into the industry change taxonomy, keep the correct value where one
// exists, refuse to invent one where it does not, and maintain a windowed rate per field so a 5%
// canary is visible as a rate rather than as a trickle of odd values.
//
// The interesting part is what falls out of writing it by hand: the classification is trivial
// (about a dozen lines), the RATE is trivial (about a dozen more), and the thing that is neither
// is the "keep the value" decision — which is exactly the decision `drift()` delegates to your
// schema and then reports on. Writing it by hand makes it explicit that a $0 charge is a choice
// somebody makes on a specific line, and that line is `Number(raw)` no matter whose code it is in.
import type { Adapter } from '../../../../packages/core/src/types';

/** The industry change taxonomy, as the classes rather than as validator mechanisms. */
export type ChangeClass = 'added' | 'removed' | 'retyped' | 'nulled';

export interface HandFinding {
    level: 'error' | 'warn' | 'info';
    change: ChangeClass;
    path: string;
    detail: string;
}

export interface HandOutcome {
    ok: boolean;
    value: Record<string, unknown> | null;
    findings: HandFinding[];
}

/* <count:begin> */
/** The declared shape: each field's expected `typeof`, and whether losing it is fatal. */
export type Shape = Record<string, { type: string; required: boolean }>;

const kindOf = (v: unknown): string =>
    v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;

/** Classify one response against the declared shape. Additions info, removals/retypes error. */
export function classify(
    body: Record<string, unknown>,
    shape: Shape,
): HandFinding[] {
    const out: HandFinding[] = [];
    for (const [path, spec] of Object.entries(shape)) {
        if (!(path in body)) {
            if (spec.required)
                out.push({
                    level: 'error',
                    change: 'removed',
                    path,
                    detail: `required ${spec.type} absent`,
                });
            continue;
        }
        const got = kindOf(body[path]);
        if (got === spec.type) continue;
        out.push(
            got === 'null'
                ? {
                      level: 'warn',
                      change: 'nulled',
                      path,
                      detail: `${spec.type} -> null`,
                  }
                : {
                      level: 'error',
                      change: 'retyped',
                      path,
                      detail: `${spec.type} -> ${got} (${JSON.stringify(body[path])})`,
                  },
        );
    }
    for (const path of Object.keys(body))
        if (!(path in shape))
            out.push({
                level: 'info',
                change: 'added',
                path,
                detail: `undeclared ${kindOf(body[path])}`,
            });
    return out;
}

/** A windowed per-finding rate. `now` is injected so the window is testable. */
export class HandRate {
    private ticks: { at: number; key: string; drifted: boolean }[] = [];
    constructor(
        private readonly now: () => number,
        private readonly window: number,
    ) {}
    record(findings: HandFinding[]): void {
        const at = this.now();
        this.ticks.push({ at, key: '<call>', drifted: false });
        for (const key of new Set(
            findings.map((f) => `${f.level}|${f.change}|${f.path}`),
        ))
            this.ticks.push({ at, key, drifted: true });
    }
    report(): string[] {
        const floor = this.now() - this.window;
        this.ticks = this.ticks.filter((t) => t.at > floor);
        const calls = this.ticks.filter((t) => !t.drifted).length;
        const by = new Map<string, number>();
        for (const t of this.ticks)
            if (t.drifted) by.set(t.key, (by.get(t.key) ?? 0) + 1);
        return [...by]
            .sort((a, b) => b[1] - a[1])
            .map(
                ([k, n]) =>
                    `${((n / calls) * 100).toFixed(1)}% of calls: ${k} (${n}/${calls})`,
            );
    }
}

/** One guarded call: fetch, classify, and keep the value only where it is unambiguous. */
export async function guardedCall(
    adapter: Adapter,
    url: string,
    shape: Shape,
    rate: HandRate,
): Promise<HandOutcome> {
    const res = await adapter({ url, method: 'GET', headers: {} });
    const body = (res.body ?? {}) as Record<string, unknown>;
    const findings = classify(body, shape);
    rate.record(findings);
    if (findings.some((f) => f.level === 'error'))
        return { ok: false, value: null, findings };
    const value: Record<string, unknown> = {};
    for (const path of Object.keys(shape)) value[path] = body[path];
    return { ok: true, value, findings };
}
/* <count:end> */

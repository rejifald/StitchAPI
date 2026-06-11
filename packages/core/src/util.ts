// Small dependency-free helpers shared across the prototype.

export const now = (): number => Date.now();

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error('aborted'));
            return;
        }
        const t = setTimeout(resolve, ms);
        signal?.addEventListener(
            'abort',
            () => {
                clearTimeout(t);
                reject(new Error('aborted'));
            },
            { once: true },
        );
    });
}

/** "30s" | "500ms" | "2m" | 1500 -> milliseconds. */
export function parseDuration(
    d: number | string | undefined,
): number | undefined {
    if (d == null) return undefined;
    if (typeof d === 'number') return d;
    const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m)$/.exec(d.trim());
    if (!m) return Number(d) || undefined;
    const n = parseFloat(m[1] ?? '');
    return m[2] === 'ms' ? n : m[2] === 's' ? n * 1000 : n * 60000;
}

/** "2/s" | "10/m" -> { count, perMs }. */
export function parseRate(r: string): { count: number; perMs: number } {
    const m = /^(\d+)\s*\/\s*(ms|s|m)$/.exec(r.trim());
    if (!m) throw new Error(`bad rate: ${r}`);
    const per = m[2] === 'ms' ? 1 : m[2] === 's' ? 1000 : 60000;
    return { count: parseInt(m[1] ?? '', 10), perMs: per };
}

export const isObj = (x: unknown): x is Record<string, unknown> =>
    !!x && typeof x === 'object' && !Array.isArray(x);

export function deepMerge<T>(a: T, b: T): T {
    if (b === undefined) return a;
    if (a === undefined) return b;
    if (Array.isArray(a) && Array.isArray(b)) return b;
    if (isObj(a) && isObj(b)) {
        const out: Record<string, unknown> = { ...a };
        for (const k of Object.keys(b)) {
            out[k] =
                k in a
                    ? deepMerge(
                          (a as Record<string, unknown>)[k],
                          (b as Record<string, unknown>)[k],
                      )
                    : (b as Record<string, unknown>)[k];
        }
        return out as T;
    }
    return b;
}

export function getPath(obj: unknown, path: string): unknown {
    if (!path) return obj;
    return path
        .split('.')
        .reduce<unknown>(
            (acc, k) =>
                acc == null ? acc : (acc as Record<string, unknown>)[k],
            obj,
        );
}

/** Expand `/users/{id}` with params, URL-encoding values. Returns { path, used }. */
export function expandPath(
    tpl: string,
    params: Record<string, unknown> = {},
): { path: string; used: Set<string> } {
    const used = new Set<string>();
    const path = tpl.replace(/\{(\w+)\}/g, (_m, k: string) => {
        used.add(k);
        return encodeURIComponent(String(params[k] ?? ''));
    });
    return { path, used };
}

export function buildQuery(q: Record<string, unknown> | undefined): string {
    if (!q) return '';
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) {
        if (v == null) continue;
        if (Array.isArray(v))
            v.forEach((x) => {
                sp.append(k, String(x));
            });
        else sp.append(k, String(v));
    }
    const s = sp.toString();
    return s ? `?${s}` : '';
}

/**
 * Does a drift path (e.g. `data[].headline`) match a user pattern?
 * Supports: exact match, `*` (single segment wildcard), and prefix match
 * (pattern `data` matches `data[].id`).
 */
export function matchPath(pattern: string, path: string): boolean {
    if (pattern === path) return true;
    if (path.startsWith(pattern + '.') || path.startsWith(pattern + '['))
        return true;
    if (pattern.includes('*')) {
        const rx = new RegExp(
            '^' +
                pattern
                    .split('.')
                    .map((s) =>
                        s === '*'
                            ? '[^.]+'
                            : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
                    )
                    .join('\\.') +
                '($|\\.|\\[)',
        );
        return rx.test(path);
    }
    return false;
}

export function matchAny(
    patterns: string[] | undefined,
    path: string,
): boolean {
    return !!patterns && patterns.some((p) => matchPath(p, path));
}

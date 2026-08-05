// The safest exposure StitchAPI can be given, as a caller would write it — what C8 counts and runs.
//
// Everything C1–C7 measured says the same thing about where the work is: the CREDENTIAL boundary is
// the library's and it holds; the ARGUMENT boundary is entirely the operator's. So this module is
// three small pieces, each closing one measured gap, and nothing here is configuration:
//
//   • THE ALLOW-LIST (`expose`)   — closes C3. `createMcpServer` takes whatever registry you hand
//     it, so the allow-list is that object. It has to be built by NAMING what is exposed, and it
//     has to be checked against `__config.name` too, because `selectStitch` resolves a stitch by
//     its configured name even when the registry key is different (registry.ts:71-74).
//   • THE INPUT FILTER (`only`)   — closes C2 and C7. A `Proxy` apply-trap rebuilds the input from
//     an explicit key list before the stitch ever sees it, so an undeclared slot is not a
//     passthrough and a stripping schema is not needed (the engine discards a validator's parsed
//     value — engine.ts:400-408 — so filtering has to happen out here).
//   • THE METHOD GATE (`readsOnly`) — closes C6 as far as it can be closed. There is no channel
//     from this process to a human (C6 a), so an irreversible call cannot be confirmed; it can only
//     be refused. The gate wraps the `Adapter`, which is the last seam before the transport and
//     outside the attempt loop.
//
// The one gap none of this closes is C4's: the error channel is an unfiltered `Error.message`
// pass-through, so a transport error that quotes the URL still reaches the model. The only fix is
// not to put a credential in a URL — `apiKey({ in: 'header' })` rather than `{ in: 'query' }`.
// >>> BEGIN USER CODE
import type { StitchRegistry } from '../../../../packages/core/src/registry';
import type {
    Adapter,
    Stitch,
    StitchInput,
} from '../../../../packages/core/src/types';

/** Which input slots — and which keys within them — a stitch accepts from an agent. */
export interface Allowed {
    params?: readonly string[];
    query?: readonly string[];
    body?: boolean;
}

/** Rebuild an object from an explicit key list, dropping everything else. */
function pickKeys(
    value: unknown,
    keys: readonly string[],
): Record<string, unknown> {
    const src = (value ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
    return out;
}

/**
 * Wrap a stitch so an agent's input is REBUILT from `allowed` before the engine sees it. A `Proxy`
 * apply-trap keeps `__config` (and every other stitch member) intact, so `list_stitches` and
 * `describe_stitch` still work on the wrapper.
 */
export function only(stitch: Stitch, allowed: Allowed): Stitch {
    return new Proxy(stitch, {
        apply(target, _thisArg, args: [StitchInput?]) {
            const input = (args[0] ?? {}) as StitchInput;
            const clean: StitchInput = {};
            if (allowed.params)
                clean.params = pickKeys(input.params, allowed.params);
            if (allowed.query)
                clean.query = pickKeys(input.query, allowed.query);
            if (allowed.body) clean.body = input.body;
            return target(clean);
        },
    });
}

/**
 * Build the registry the MCP server is given. Every exposed stitch is named twice — once as the key
 * an agent calls, once in the map — and a stitch whose CONFIGURED name is not the key it is exposed
 * under is rejected, because that name would be callable while absent from `list_stitches`.
 */
export function expose(entries: Record<string, Stitch>): StitchRegistry {
    for (const [key, stitch] of Object.entries(entries)) {
        const configured = stitch.__config.name;
        if (configured !== undefined && configured !== key)
            throw new Error(
                `expose: "${key}" is also reachable as "${configured}" — give the stitch the same name as its key`,
            );
    }
    return entries;
}

/** Refuse anything that is not a read, at the last seam before the transport. */
export function readsOnly(adapter: Adapter): Adapter {
    return (req) => {
        if (req.method !== 'GET' && req.method !== 'HEAD')
            throw new Error(
                `${req.method} is not available to an agent on this server`,
            );
        return adapter(req);
    };
}
// <<< END USER CODE

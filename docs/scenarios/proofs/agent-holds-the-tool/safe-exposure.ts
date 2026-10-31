// The safest exposure StitchAPI can be given, as a caller would write it — what C8 counts and runs.
//
// Everything C1–C7 measured says the same thing about where the work is: the CREDENTIAL boundary is
// the library's and it holds; the ARGUMENT boundary is entirely the operator's. So this module is
// three small pieces, each closing one measured gap, and nothing here is configuration:
//
//   • THE ALLOW-LIST (`expose`)   — closes C3. `createMcpServer` takes whatever registry you hand
//     it, so the allow-list is that object. It has to be built by NAMING what is exposed. Since
//     #866 the registry KEY is the only name a stitch answers to, so renaming a key really does
//     hide the original and nothing needs to be checked against `__config.name`.
//   • THE INPUT FILTER (`only`)   — closes C2 and C7 (d). A `Proxy` apply-trap rebuilds the input
//     from an explicit key list before the stitch ever sees it, so an undeclared slot is not a
//     passthrough. Since #663 a declared schema filters its own slot (engine.ts:415-447), so out
//     here the key list is defence in depth for declared slots — and the only cover a slot with
//     no schema has.
//   • THE METHOD GATE (`readsOnly`) — closes C6 as far as it can be closed. There is no channel
//     from this process to a human (C6 a), so an irreversible call cannot be confirmed; it can only
//     be refused. The gate wraps the `Adapter`, which is the last seam before the transport and
//     outside the attempt loop.
//
// C4's gap needs nothing here any more: core URL-scrubs an error message where the engine mints it
// (#866, #890), so a transport error that quotes the URL no longer carries the key to the model.
// Not putting a credential in a URL — `apiKey({ in: 'header' })` rather than `{ in: 'query' }` —
// is still the better placement.
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
 * Build the registry the MCP server is given. Each exposed stitch is named once, as the key an
 * agent calls. That key is also the ONLY name it answers to (#866), so leaving a stitch out of the
 * object, or exposing it under another key, is what keeps it away from the agent.
 */
export function expose(entries: Record<string, Stitch>): StitchRegistry {
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

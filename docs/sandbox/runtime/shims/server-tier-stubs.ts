/**
 * Server-tier throwing stubs — B1.
 *
 * `cli` / `serve` / `mcp` are genuinely impossible in the browser (process / stdio
 * / server surfaces — B1-SPIKE §5, SANDBOX §3). They are NOT in core's barrel, so
 * they tree-shake out of the bundle entirely; we still export named stubs so a
 * snippet that references them gets a clear, intentional error rather than an
 * opaque `undefined is not a function`. The dispatcher (D1) routes these to the
 * server tier when it exists; pre-server, calling them here explains why.
 */

function serverTierOnly(surface: string): never {
    throw new Error(
        `\`${surface}\` is a server-tier surface and cannot run in the browser ` +
            `sandbox (it needs process/stdio/server access). Run this snippet on ` +
            `the server tier. See docs/sandbox/SANDBOX.md §3.`,
    );
}

/** Server-tier only — throws in the browser. */
export function cli(..._args: unknown[]): never {
    return serverTierOnly('cli');
}

/** Server-tier only — throws in the browser. */
export function serve(..._args: unknown[]): never {
    return serverTierOnly('serve');
}

/** Server-tier only — throws in the browser. */
export function mcp(..._args: unknown[]): never {
    return serverTierOnly('mcp');
}

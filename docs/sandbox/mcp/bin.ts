/**
 * stitch-sandbox — MCP server exposing the StitchAPI sandbox to agents (stdio).
 *
 * Tools: `run_in_sandbox` (arbitrary snippet → sim), `run_stitch` (sim mode —
 * registered stitches against the fake API), and `list_stitches`. The whole
 * process routes `fetch` through the sandbox simulator, so NOTHING here reaches
 * the real network. Local/trusted use only (see `worker-main.node.ts` caveat).
 *
 * Usage:  node dist/mcp.mjs [--module <compiled-stitches.js>]
 *   (default: a small demo registry of stitches against api.example.com)
 */
import {
    type StitchRegistry,
    collectStitches,
} from '../../../packages/core/src/registry';
import { createFetchShim } from '../../../packages/sandbox-sim/src/adapters/node';
import { allHandlers } from '../../../packages/sandbox-sim/src/handlers';
import { runSandboxStdio } from './server';

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Sim-back ALL fetch in this process so run_stitch hits the fake API, not the net.
// The default fetch adapter binds `globalThis.fetch` when a stitch is CONSTRUCTED,
// so this must run before the default registry is built — hence the dynamic
// import of `./sandbox-stitches` inside main(), below.
(globalThis as { fetch?: unknown }).fetch = createFetchShim(allHandlers);

function flag(argv: string[], ...names: string[]): string | undefined {
    for (let i = 0; i < argv.length; i++) {
        if (names.includes(argv[i] ?? '')) return argv[i + 1];
    }
    return undefined;
}

async function main(): Promise<void> {
    // Imported dynamically so the default registry's stitches are constructed
    // AFTER the sim shim above (the default adapter captures fetch at build time).
    const { sandboxRegistry } = await import('./sandbox-stitches');
    let registry: StitchRegistry = sandboxRegistry;

    const modulePath = flag(process.argv.slice(2), '--module', '-m');
    if (modulePath) {
        const url = pathToFileURL(resolve(process.cwd(), modulePath)).href;
        registry = collectStitches(await import(url));
    }

    const handle = runSandboxStdio(registry);
    const names = Object.keys(registry);
    process.stderr.write(
        `stitch-sandbox: run_in_sandbox + run_stitch (sim) + list_stitches over MCP (stdio); ` +
            `${names.length} stitch(es): ${names.join(', ')}\n`,
    );

    await new Promise<void>((res) => {
        process.stdin.once('close', res);
        process.once('SIGINT', res);
        process.once('SIGTERM', res);
    });
    handle.close();
}

void main();

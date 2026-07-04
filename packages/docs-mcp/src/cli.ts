// `stitchapi-docs-mcp` bin — starts the local docs server over stdio. No
// subcommands: unlike `stitch` (run/serve/mcp/…), this package does exactly
// one thing, so argv only needs --help/--version, not a command dispatcher.
import { createServer } from './server';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const HELP = `stitchapi-docs-mcp — StitchAPI documentation search over MCP stdio, fully local

Runs entirely on this machine: the docs corpus and the embedding index ship
bundled with this package, and queries are embedded locally too (transformers.js,
downloaded once into an OS cache dir on first run, then reused). No query, and
no doc content, is ever sent to stitchapi.dev or anywhere else.

usage:
  stitchapi-docs-mcp             start the server (stdio transport)
  stitchapi-docs-mcp --help      show this help
  stitchapi-docs-mcp --version   print the version

Point an MCP-capable agent/host at this command (not a URL) to add it as a
local server. See https://stitchapi.dev/docs/agents for the hosted
(stitchapi.dev/api/mcp) alternative if a local process isn't an option.
`;

export async function main(argv: string[]): Promise<number> {
    if (argv.includes('--help') || argv.includes('-h')) {
        process.stdout.write(HELP);
        return 0;
    }
    if (argv.includes('--version') || argv.includes('-v')) {
        process.stdout.write(`${__PKG_VERSION__}\n`);
        return 0;
    }

    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    return 0;
}

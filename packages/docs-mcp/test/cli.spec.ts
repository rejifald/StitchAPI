// main()'s --help/--version short-circuit paths. Both return before touching
// createServer()/StdioServerTransport, so no MCP machinery needs to be mocked
// here — the default (server-start) path isn't covered by this file, since it
// would actually open a stdio transport; that's exercised by server.spec.ts's
// createServer()-level coverage instead.
import { main } from '../src/cli';

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('main()', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('--help prints usage and exits 0', async () => {
        const write = vi
            .spyOn(process.stdout, 'write')
            .mockImplementation(() => true);

        const code = await main(['--help']);

        expect(code).toBe(0);
        expect(write).toHaveBeenCalledTimes(1);
        expect(write.mock.calls[0]?.[0]).toContain('stitchapi-docs-mcp');
    });

    it('-h is equivalent to --help', async () => {
        const write = vi
            .spyOn(process.stdout, 'write')
            .mockImplementation(() => true);

        expect(await main(['-h'])).toBe(0);
        expect(write).toHaveBeenCalledTimes(1);
    });

    it('--version prints the package version and exits 0', async () => {
        const write = vi
            .spyOn(process.stdout, 'write')
            .mockImplementation(() => true);

        const code = await main(['--version']);

        expect(code).toBe(0);
        expect(write).toHaveBeenCalledWith(`${__PKG_VERSION__}\n`);
    });

    it('-v is equivalent to --version', async () => {
        const write = vi
            .spyOn(process.stdout, 'write')
            .mockImplementation(() => true);

        expect(await main(['-v'])).toBe(0);
        expect(write).toHaveBeenCalledWith(`${__PKG_VERSION__}\n`);
    });

    it('--help takes precedence over other args', async () => {
        const write = vi
            .spyOn(process.stdout, 'write')
            .mockImplementation(() => true);

        expect(await main(['--version', '--help'])).toBe(0);
        expect(write.mock.calls[0]?.[0]).toContain('stitchapi-docs-mcp');
    });
});

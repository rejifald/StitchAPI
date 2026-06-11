// Minimal zero-dependency preview server for the StitchAPI docs playground.
//
// Serves a single self-contained page that previews the <StitchPlayground> shell
// (editor + output panel — execution is MOCKED, the real engine is deferred) plus
// the Mermaid build-stitch architecture diagram. No build step, Node built-ins only,
// in the spirit of playground/server.ts.
//
// Run via the Claude `preview` launch config (node docs/playground/preview/server.mjs)
// or directly:  PORT=3000 node docs/playground/preview/server.mjs
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);

const server = createServer(async (_req, res) => {
    try {
        const html = await readFile(join(here, 'index.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
    } catch (e) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('preview error: ' + (e && e.message ? e.message : String(e)));
    }
});

server.listen(PORT, () => {
    console.log(`StitchAPI docs playground preview → http://localhost:${PORT}`);
});

// Live playground server: serves the UI, lists demos, and streams each demo's stitch event
// stream to the browser over SSE. Run: bash playground/run.sh
import { startMockServer } from '../test/support/mock-server';
import { demos } from './demos';

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';

process.env.STITCH_TRACE_FILE = join(tmpdir(), 'stitch-playground.jsonl');

const PORT = Number(process.env.PORT ?? 5174);
const PUBLIC = join(__dirname, 'public');
const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    const path = url.pathname;
    try {
        if (path === '/api/demos') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
                JSON.stringify(
                    demos.map((d) => ({
                        id: d.id,
                        title: d.title,
                        blurb: d.blurb,
                        group: d.group,
                    })),
                ),
            );
            return;
        }
        if (path.startsWith('/api/run/')) {
            await runDemo(
                decodeURIComponent(path.slice('/api/run/'.length)),
                res,
            );
            return;
        }
        await serveStatic(path === '/' ? '/index.html' : path, res);
    } catch (e) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('error: ' + (e as Error).message);
    }
});

async function serveStatic(p: string, res: ServerResponse): Promise<void> {
    const file = normalize(join(PUBLIC, p));
    if (!file.startsWith(PUBLIC)) {
        res.writeHead(403);
        res.end('forbidden');
        return;
    }
    try {
        const data = await readFile(file);
        res.writeHead(200, {
            'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        });
        res.end(data);
    } catch {
        res.writeHead(404);
        res.end('not found');
    }
}

async function runDemo(id: string, res: ServerResponse): Promise<void> {
    const demo = demos.find((d) => d.id === id);
    if (!demo) {
        res.writeHead(404);
        res.end('unknown demo');
        return;
    }
    res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
    });
    const send = (event: string, data: unknown) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const mock = await startMockServer();
    try {
        const { plays, note } = demo.setup(mock);
        send('meta', {
            id: demo.id,
            title: demo.title,
            note,
            plays: plays.length,
        });
        for (let i = 0; i < plays.length; i++) {
            send('play', { index: i, label: plays[i].label });
            for await (const ev of plays[i].stitch.stream(plays[i].input))
                send('stitch', { play: i, ...ev });
        }
    } catch (e) {
        send('fail', { message: (e as Error).message });
    } finally {
        await mock.close();
        send('end', {});
        res.end();
    }
}

server.listen(PORT, () =>
    console.log(`StitchAPI playground → http://localhost:${PORT}`),
);

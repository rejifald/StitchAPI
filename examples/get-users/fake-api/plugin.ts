import { handleRequest } from './handler';

import type { IncomingMessage } from 'node:http';

import type { Connect, Plugin, PreviewServer, ViteDevServer } from 'vite';

// Connect middleware that turns our framework-agnostic handler into something a
// Vite server can serve. Requests to /api/* are answered locally; everything
// else falls through to Vite's normal asset handling.
const middleware: Connect.NextHandleFunction = (rawReq, res, next) => {
    const req = rawReq as IncomingMessage;
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (!url.pathname.startsWith('/api/')) {
        return next();
    }

    const result = handleRequest(req.method ?? 'GET', url.pathname, url.searchParams);

    if (!result) {
        return next();
    }

    res.statusCode = result.status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result.body));
};

/**
 * Mounts the fake API on both the dev server (`vite`) and the preview server
 * (`vite preview`) so the live example works in either mode — including inside
 * CodeSandbox, which runs `npm run dev`.
 */
export function fakeApi(): Plugin {
    return {
        name: 'stitchapi-fake-api',
        configureServer(server: ViteDevServer) {
            server.middlewares.use(middleware);
        },
        configurePreviewServer(server: PreviewServer) {
            server.middlewares.use(middleware);
        },
    };
}

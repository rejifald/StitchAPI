import { describe, expect, it, vi } from 'vitest';

// The route reaches the docs corpus through these two modules, and they pull in
// `collections/server` — a module Next generates at build time, so it does not
// resolve under vitest. Stub them: what is under test here is the mcp-handler
// wiring (registerTool + createMcpHandler), not retrieval.
vi.mock('@/lib/search-index/search', () => ({
    searchDocs: vi.fn(async () => []),
}));
vi.mock('@/lib/search-index/get-doc', () => ({
    getDoc: vi.fn(async () => null),
}));

const { POST } = await import('@/app/api/mcp/route');

const INIT = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'probe', version: '0.0.0' },
    },
};

function mcpRequest(body: unknown): Request {
    return new Request('https://stitchapi.dev/api/mcp', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(body),
    });
}

/** Streamable HTTP may answer as JSON or as a single SSE frame. */
async function readRpc(res: Response): Promise<any> {
    const text = await res.text();
    if (text.startsWith('event:') || text.includes('\ndata:')) {
        const line = text.split('\n').find((l) => l.startsWith('data:'));
        return JSON.parse(line!.slice(5).trim());
    }
    return JSON.parse(text);
}

describe('hosted docs MCP route', () => {
    it('completes an initialize handshake', async () => {
        const res = await POST(mcpRequest(INIT));
        expect(res.status).toBe(200);
        const rpc = await readRpc(res);
        expect(rpc.result.serverInfo).toMatchObject({ name: 'stitchapi-docs' });
    });

    it('advertises both tools with their input schemas', async () => {
        await POST(mcpRequest(INIT));
        const res = await POST(
            mcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
        );
        const rpc = await readRpc(res);
        const names = rpc.result.tools.map((t: { name: string }) => t.name);
        expect(names).toContain('search_docs');
        expect(names).toContain('get_doc');
        const search = rpc.result.tools.find(
            (t: { name: string }) => t.name === 'search_docs',
        );
        expect(search.inputSchema.properties).toHaveProperty('query');
    });
});

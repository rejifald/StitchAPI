// End-to-end coverage of the MCP tool contract — the JSON shape callers
// actually depend on. Drives real tool calls through the SDK's in-memory
// transport (Client <-> McpServer), rather than reimplementing the mapping
// logic in the test, so a schema/shape regression in server.ts is caught the
// same way a real MCP client would hit it. searchDocs()/getDoc() are mocked so
// this doesn't need the bundled data/ files or the embedding model.
import { createServer } from '../src/server';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const searchDocsMock = vi.fn();
vi.mock('../src/search', () => ({
    searchDocs: (...args: unknown[]) => searchDocsMock(...args),
}));

const getDocMock = vi.fn();
vi.mock('../src/get-doc', () => ({
    getDoc: (...args: unknown[]) => getDocMock(...args),
}));

async function connectedClient(): Promise<Client> {
    const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
    const client = new Client({
        name: 'docs-mcp-test-client',
        version: '0.0.0',
    });
    const server = createServer();
    await Promise.all([
        client.connect(clientTransport),
        server.connect(serverTransport),
    ]);
    return client;
}

interface TextContent {
    type: 'text';
    text: string;
}

function textOf(result: unknown): string {
    const content = (result as { content: TextContent[] }).content;
    const first = content[0];
    if (!first) throw new Error('expected at least one content item');
    return first.text;
}

function isErrorOf(result: unknown): boolean {
    return (result as { isError?: boolean }).isError === true;
}

describe('search_docs tool', () => {
    beforeEach(() => {
        searchDocsMock.mockReset();
    });

    it('maps hits to {title,url,excerpt,score}: dedups title when heading equals it, composes it otherwise, builds an absolute url from path + anchor, truncates a long excerpt, and rounds score to 4 decimals', async () => {
        const longText = 'word '.repeat(200); // > 300 chars, forces truncation
        searchDocsMock.mockResolvedValue([
            {
                path: '/docs/guides/resilience/retry',
                title: 'Retry & backoff',
                heading: 'Options',
                anchor: 'options',
                text: longText,
                score: 0.123456789,
            },
            {
                path: '/docs/guides/y',
                title: 'Y',
                heading: 'Y',
                anchor: '',
                text: 'short body',
                score: 0.5,
            },
        ]);

        const client = await connectedClient();
        const result = await client.callTool({
            name: 'search_docs',
            arguments: { query: 'how do I retry' },
        });

        expect(searchDocsMock).toHaveBeenCalledWith('how do I retry', {
            limit: 5,
        });

        const results = JSON.parse(textOf(result));

        expect(results[0].title).toBe('Retry & backoff — Options');
        expect(results[0].url).toBe(
            'https://stitchapi.dev/docs/guides/resilience/retry#options',
        );
        expect(results[0].score).toBe(0.1235);
        expect(results[0].excerpt.endsWith('…')).toBe(true);
        expect(results[0].excerpt.length).toBeLessThan(longText.length);

        // heading === title -> no " — heading" suffix; no anchor -> no trailing '#'.
        expect(results[1].title).toBe('Y');
        expect(results[1].url).toBe('https://stitchapi.dev/docs/guides/y');
    });

    it('passes an explicit limit through to searchDocs', async () => {
        searchDocsMock.mockResolvedValue([]);
        const client = await connectedClient();

        await client.callTool({
            name: 'search_docs',
            arguments: { query: 'x', limit: 3 },
        });

        expect(searchDocsMock).toHaveBeenCalledWith('x', { limit: 3 });
    });

    it('rejects a query longer than the schema max before it reaches searchDocs', async () => {
        const client = await connectedClient();

        // The SDK surfaces a schema-validation failure as a normal
        // isError:true tool result (not a rejected callTool() promise).
        const result = await client.callTool({
            name: 'search_docs',
            arguments: { query: 'a'.repeat(600) },
        });

        expect(isErrorOf(result)).toBe(true);
        expect(textOf(result)).toMatch(/512 characters/);
        expect(searchDocsMock).not.toHaveBeenCalled();
    });
});

describe('get_doc tool', () => {
    beforeEach(() => {
        getDocMock.mockReset();
    });

    it('returns the full markdown for a found doc', async () => {
        getDocMock.mockReturnValue({
            title: 'Throttle',
            url: '/docs/guides/resilience/throttle',
            markdown: '# Throttle\n\nBody.',
        });
        const client = await connectedClient();

        const result = await client.callTool({
            name: 'get_doc',
            arguments: { slug: 'guides/resilience/throttle' },
        });

        expect(getDocMock).toHaveBeenCalledWith({
            url: undefined,
            slug: 'guides/resilience/throttle',
        });
        expect(textOf(result)).toBe('# Throttle\n\nBody.');
        expect(isErrorOf(result)).toBe(false);
    });

    it('is an isError result with a specific message when neither url nor slug is given', async () => {
        const client = await connectedClient();

        const result = await client.callTool({
            name: 'get_doc',
            arguments: {},
        });

        expect(isErrorOf(result)).toBe(true);
        expect(textOf(result)).toBe('Provide a `url` or `slug` to fetch.');
        expect(getDocMock).not.toHaveBeenCalled();
    });

    it('is an isError result naming the input when the doc is not found', async () => {
        getDocMock.mockReturnValue(null);
        const client = await connectedClient();

        const result = await client.callTool({
            name: 'get_doc',
            arguments: { slug: 'nope' },
        });

        expect(isErrorOf(result)).toBe(true);
        expect(textOf(result)).toBe('No StitchAPI doc found for nope.');
    });
});

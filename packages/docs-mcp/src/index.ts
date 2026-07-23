// Library entry — for embedding the local docs server in another process
// (e.g. a custom MCP host) instead of running the `stitchapi-docs-mcp` bin.
export { createServer } from './server';
export { type DocResult, getDoc } from './get-doc';
export { type DocSearchHit, type SearchOptions, searchDocs } from './search';

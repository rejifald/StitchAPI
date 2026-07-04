// Measures the shared config constants + parseDocPath BEHAVIOR from either
// side of the docs-mcp hand-mirror (see packages/docs-mcp/README.md "Keeping
// this in sync"): apps/docs/lib/search-index/* (the hosted stitchapi.dev/api/mcp
// server) vs packages/docs-mcp/src/* (the local stdio server). The two are
// deliberately duplicated code, not shared — this script is the yakir
// `docs-mcp-config-parity` tether's measurement: two `command` sites run it
// with different targets, and yakir fails the build if their (whole-stdout,
// fingerprinted) output ever disagrees.
//
// Run: node --import tsx/esm scripts/probe-docs-mcp-parity.mjs <apps-docs|docs-mcp>
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const target = process.argv[2];
if (target !== 'apps-docs' && target !== 'docs-mcp') {
    console.error('usage: probe-docs-mcp-parity.mjs <apps-docs|docs-mcp>');
    process.exit(1);
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function importFrom(relativePath) {
    return import(pathToFileURL(resolve(ROOT, relativePath)).href);
}

function extract(relativePath, pattern) {
    const text = readFileSync(resolve(ROOT, relativePath), 'utf8');
    const match = pattern.exec(text);
    if (!match) {
        throw new Error(
            `probe-docs-mcp-parity: pattern ${pattern} not found in ${relativePath}`,
        );
    }
    return match[1];
}

// The same inputs both packages' doc-path.spec.ts cover; any behavioral
// divergence on any of these fails the tether.
const DOC_PATH_CASES = [
    { url: 'https://stitchapi.dev/docs/guides/resilience/throttle#options' },
    { url: '/docs/guides/auth/bearer' },
    { slug: 'guides/data/pagination' },
    { url: '/docs/concepts/the-stitch?x=1#why' },
    { slug: 'errors/stitch-drift', url: 'https://stitchapi.dev/docs/other' },
    { url: '/docs' },
    { url: 'https://stitchapi.dev/docs' },
    {},
    { url: '   ' },
];

let result;
if (target === 'apps-docs') {
    const config = await importFrom('apps/docs/lib/search-index/config.ts');
    const { HYBRID_WEIGHTS, FIELD_BOOST } = await importFrom(
        'apps/docs/lib/search-index/search.ts',
    );
    const { parseDocPath } = await importFrom(
        'apps/docs/lib/search-index/doc-path.ts',
    );
    const { siteUrl } = await importFrom('apps/docs/lib/shared.ts');
    const excerptLen = Number(
        extract('apps/docs/app/api/mcp/route.ts', /EXCERPT_LEN = (\d+)/),
    );
    result = {
        embedModel: config.EMBED_MODEL,
        embedDtype: config.EMBED_DTYPE,
        embedDim: config.EMBED_DIM,
        vectorField: config.VECTOR_FIELD,
        maxQueryLen: config.MAX_QUERY_LEN,
        hybridWeights: HYBRID_WEIGHTS,
        fieldBoost: FIELD_BOOST,
        siteUrl,
        excerptLen,
        docPathResults: DOC_PATH_CASES.map((input) => ({
            input,
            output: parseDocPath(input),
        })),
    };
} else {
    const config = await importFrom('packages/docs-mcp/src/config.ts');
    const { parseDocPath } = await importFrom(
        'packages/docs-mcp/src/doc-path.ts',
    );
    const siteUrl = extract(
        'packages/docs-mcp/src/server.ts',
        /SITE_URL = '([^']+)'/,
    );
    const excerptLen = Number(
        extract('packages/docs-mcp/src/server.ts', /EXCERPT_LEN = (\d+)/),
    );
    result = {
        embedModel: config.EMBED_MODEL,
        embedDtype: config.EMBED_DTYPE,
        embedDim: config.EMBED_DIM,
        vectorField: config.VECTOR_FIELD,
        maxQueryLen: config.MAX_QUERY_LEN,
        hybridWeights: config.HYBRID_WEIGHTS,
        fieldBoost: config.FIELD_BOOST,
        siteUrl,
        excerptLen,
        docPathResults: DOC_PATH_CASES.map((input) => ({
            input,
            output: parseDocPath(input),
        })),
    };
}

// Both branches build `result` with the same literal key order, so this is
// byte-stable across the two targets whenever the underlying values agree —
// no custom key-sorting needed (a JSON.stringify array replacer would apply
// the same allowlist at every nesting level and strip the nested fields).
console.log(JSON.stringify(result));

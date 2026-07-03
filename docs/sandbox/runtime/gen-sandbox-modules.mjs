#!/usr/bin/env node

/**
 * Generate `sandbox-modules.generated.ts` from `playground-packages.mjs`.
 *
 * esbuild can only bundle a package it sees as a STATIC `import * as … from
 * '<specifier>'` — you can't build the registry from a runtime loop. So this
 * emits one static namespace import per declared package plus the specifier →
 * namespace map the worker exposes as its module registry (worker-entry's
 * `__stitchImport`). Run by `build:sandbox` and `build:mcp` before the esbuild
 * bundle; the output is committed (prettier-ignored via `**\/*.generated.ts`)
 * so tsc/dev see it without a pre-step.
 *
 * Usage:  node docs/sandbox/runtime/gen-sandbox-modules.mjs
 *         node docs/sandbox/runtime/gen-sandbox-modules.mjs --emit   (stdout only)
 */
import { PLAYGROUND_PACKAGES } from './playground-packages.mjs';

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, 'sandbox-modules.generated.ts');

function render() {
    const imports = PLAYGROUND_PACKAGES.map(
        (p, i) => `import * as m${i} from ${JSON.stringify(p.specifier)};`,
    ).join('\n');
    const entries = PLAYGROUND_PACKAGES.map(
        (p, i) => `    ${JSON.stringify(p.specifier)}: m${i},`,
    ).join('\n');

    return `// @generated — do not edit by hand.
// Regenerate: node docs/sandbox/runtime/gen-sandbox-modules.mjs
// Source of truth: docs/sandbox/runtime/playground-packages.mjs
//
// The curated module registry a playground snippet's \`import { x } from
// '<specifier>'\` resolves against (worker-entry's \`__stitchImport\`), beyond the
// core \`stitchapi\` surface which is injected name-by-name separately.
${imports}

export const sandboxModules: Record<string, unknown> = {
${entries}
};
`;
}

const out = render();
if (process.argv.includes('--emit')) {
    process.stdout.write(out);
} else {
    writeFileSync(OUT, out);
    console.log(
        `[sandbox-modules] wrote ${PLAYGROUND_PACKAGES.length} modules → ${OUT}`,
    );
}

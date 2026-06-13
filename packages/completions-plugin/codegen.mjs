/**
 * generatePlaygroundCompletions — scans one or more packages for exported
 * *Config interfaces, cross-checks them against the package's public exports,
 * and writes a single PLAYGROUND_COMPLETIONS map for the editor.
 *
 * Discovery rule (per package):
 *   1. Collect every exported `*Config` interface across src/**\/*.ts
 *   2. Derive the function name: `StitchConfig → stitch`, `SeamConfig → seam`
 *   3. Only include the interface if that function name appears in src/index.ts exports
 *
 * Adding a new primitive requires no changes here or in next.config — just
 * export `XConfig` + `x` from the package's index and it appears automatically.
 *
 * @param {object} opts
 * @param {string[]} opts.packages  Absolute paths to package roots (must have src/index.ts).
 * @param {string}   opts.outputFile  Absolute path to write the generated .ts file.
 */
import { readdirSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { join, resolve } from 'path';

const req = createRequire(import.meta.url);

/* ── file helpers ─────────────────────────────────────────────────────────── */

function findTsFiles(dir) {
    const results = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
                results.push(...findTsFiles(full));
            }
        } else if (
            entry.isFile() &&
            entry.name.endsWith('.ts') &&
            !entry.name.endsWith('.d.ts') &&
            !entry.name.endsWith('.test.ts') &&
            !entry.name.endsWith('.spec.ts')
        ) {
            results.push(full);
        }
    }
    return results;
}

/* ── TypeScript helpers ───────────────────────────────────────────────────── */

/** Returns the set of value names exported from an index.ts file. */
function getExportedNames(ts, indexFile) {
    const program = ts.createProgram([indexFile], {
        noEmit: true,
        skipLibCheck: true,
    });
    const sf = program.getSourceFile(indexFile);
    if (!sf) return new Set();

    const names = new Set();
    ts.forEachChild(sf, (node) => {
        // export { a, b } from '...'
        if (
            ts.isExportDeclaration(node) &&
            node.exportClause &&
            ts.isNamedExports(node.exportClause)
        ) {
            for (const el of node.exportClause.elements) {
                names.add(el.name.text);
            }
        }
        // export const / export function / export class
        const hasExport = node.modifiers?.some(
            (m) => m.kind === ts.SyntaxKind.ExportKeyword,
        );
        if (hasExport) {
            if (ts.isVariableStatement(node)) {
                for (const decl of node.declarationList.declarations) {
                    if (ts.isIdentifier(decl.name)) names.add(decl.name.text);
                }
            } else if (
                (ts.isFunctionDeclaration(node) ||
                    ts.isClassDeclaration(node)) &&
                node.name
            ) {
                names.add(node.name.text);
            }
        }
    });
    return names;
}

/** `'StitchConfig' → 'stitch'`, `'SeamConfig' → 'seam'`. */
function configToFunctionName(interfaceName) {
    const prefix = interfaceName.replace(/Config$/, '');
    return prefix.charAt(0).toLowerCase() + prefix.slice(1);
}

/** Extract Completion entries from a *Config interface node. */
function extractEntries(ts, iface, sf) {
    function jsDocSummary(node) {
        const docs = node.jsDoc;
        if (!docs?.length) return '';
        const last = docs[docs.length - 1];
        if (!last.comment) return '';
        const text =
            typeof last.comment === 'string'
                ? last.comment
                : last.comment.map((c) => c.text ?? '').join('');
        return text.trim().replace(/\s*\n\s*/g, ' ');
    }

    function typeText(member) {
        if (!member.type) return 'unknown';
        return member.type
            .getText(sf)
            .replace(/\s*\n\s*/g, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim();
    }

    const entries = [];
    for (const member of iface.members) {
        if (!ts.isPropertySignature(member)) continue;
        entries.push({
            label: member.name.getText(sf),
            detail: typeText(member),
            info: jsDocSummary(member),
        });
    }
    return entries;
}

/** Scan src/ of a package for exported *Config interfaces matched to exports. */
function scanPackage(ts, packageRoot) {
    const srcDir = resolve(packageRoot, 'src');
    const indexFile = resolve(srcDir, 'index.ts');

    const exportedNames = getExportedNames(ts, indexFile);
    const srcFiles = findTsFiles(srcDir);

    // Build one program over all source files for efficient shared parsing.
    const program = ts.createProgram(srcFiles, {
        noEmit: true,
        skipLibCheck: true,
    });

    const found = []; // [{ functionName, interfaceName, entries }]

    for (const file of srcFiles) {
        const sf = program.getSourceFile(file);
        if (!sf) continue;

        ts.forEachChild(sf, (node) => {
            if (!ts.isInterfaceDeclaration(node)) return;
            if (!node.name.text.endsWith('Config')) return;

            const isExported = node.modifiers?.some(
                (m) => m.kind === ts.SyntaxKind.ExportKeyword,
            );
            if (!isExported) return;

            const fnName = configToFunctionName(node.name.text);
            if (!exportedNames.has(fnName)) return;

            found.push({
                functionName: fnName,
                interfaceName: node.name.text,
                entries: extractEntries(ts, node, sf),
            });
        });
    }

    return found;
}

/* ── emit ─────────────────────────────────────────────────────────────────── */

function renderEntry({ label, detail, info }) {
    return (
        `        {\n` +
        `            label: ${JSON.stringify(label)},\n` +
        `            type: 'property' as const,\n` +
        `            detail: ${JSON.stringify(detail)},\n` +
        (info ? `            info: ${JSON.stringify(info)},\n` : '') +
        `        }`
    );
}

/* ── public API ───────────────────────────────────────────────────────────── */

export async function generatePlaygroundCompletions({ packages, outputFile }) {
    const ts = req('typescript');

    const allFound = packages.flatMap((pkgRoot) => {
        const results = scanPackage(ts, pkgRoot);
        for (const r of results) {
            console.log(
                `[completions-plugin] ${r.functionName}: ${r.entries.length} completions from ${r.interfaceName} (${pkgRoot})`,
            );
        }
        return results;
    });

    const blocks = allFound.map(({ functionName, entries }) => {
        const rendered = entries.map(renderEntry).join(',\n');
        return `    ${JSON.stringify(functionName)}: [\n${rendered},\n    ]`;
    });

    const content = [
        `// @generated — do not edit by hand.`,
        `// Regenerate: pnpm --filter @stitchapi/docs run gen:completions`,
        `import type { Completion } from '@codemirror/autocomplete';`,
        ``,
        `export const PLAYGROUND_COMPLETIONS: Record<string, Completion[]> = {`,
        blocks.join(',\n'),
        `};`,
        ``,
    ].join('\n');

    writeFileSync(outputFile, content, 'utf8');
    console.log(`[completions-plugin] wrote → ${outputFile}`);
}

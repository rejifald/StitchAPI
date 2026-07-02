/**
 * generatePlaygroundCompletions — scans packages for exported *Config
 * interfaces and their matching instance interfaces, then writes two maps:
 *
 *   PLAYGROUND_COMPLETIONS         — config keys inside primitive({…}) calls
 *   PLAYGROUND_INSTANCE_COMPLETIONS — members on the value a primitive returns
 *
 * Discovery rules (per package):
 *   Config  : every exported XConfig where x is in src/index.ts exports
 *   Instance: exported X (same prefix, no Config suffix) alongside each XConfig
 *
 * e.g. StitchConfig → stitch call-arg completions
 *      Stitch        → .stream() / .with() / … on the returned instance
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
            if (entry.name !== 'node_modules' && !entry.name.startsWith('.'))
                results.push(...findTsFiles(full));
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

function getExportedNames(ts, indexFile) {
    const program = ts.createProgram([indexFile], {
        noEmit: true,
        skipLibCheck: true,
    });
    const sf = program.getSourceFile(indexFile);
    if (!sf) return new Set();

    const names = new Set();
    ts.forEachChild(sf, (node) => {
        if (
            ts.isExportDeclaration(node) &&
            node.exportClause &&
            ts.isNamedExports(node.exportClause)
        ) {
            for (const el of node.exportClause.elements)
                names.add(el.name.text);
        }
        const hasExport = node.modifiers?.some(
            (m) => m.kind === ts.SyntaxKind.ExportKeyword,
        );
        if (hasExport) {
            if (ts.isVariableStatement(node)) {
                for (const d of node.declarationList.declarations)
                    if (ts.isIdentifier(d.name)) names.add(d.name.text);
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

function configToFunctionName(interfaceName) {
    const prefix = interfaceName.replace(/Config$/, '');
    return prefix.charAt(0).toLowerCase() + prefix.slice(1);
}

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

function collapseWhitespace(s) {
    return s
        .replace(/\s*\n\s*/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

/** Property signatures only — used for *Config interfaces (call-arg completions). */
function extractConfigEntries(ts, iface, sf) {
    const entries = [];
    for (const member of iface.members) {
        if (!ts.isPropertySignature(member)) continue;
        entries.push({
            type: 'property',
            label: member.name.getText(sf),
            detail: member.type
                ? collapseWhitespace(member.type.getText(sf))
                : 'unknown',
            info: jsDocSummary(member),
        });
    }
    return entries;
}

/** Property + method signatures — used for instance interfaces (dot completions). */
function extractInstanceEntries(ts, iface, sf) {
    const entries = [];
    for (const member of iface.members) {
        if (ts.isCallSignatureDeclaration(member)) continue; // skip callable part

        if (ts.isPropertySignature(member)) {
            entries.push({
                type: 'property',
                label: member.name.getText(sf),
                detail: member.type
                    ? collapseWhitespace(member.type.getText(sf))
                    : 'unknown',
                info: jsDocSummary(member),
            });
        } else if (ts.isMethodSignature(member)) {
            const params = member.parameters
                .map((p) => collapseWhitespace(p.getText(sf)))
                .join(', ');
            const ret = member.type
                ? collapseWhitespace(member.type.getText(sf))
                : 'void';
            entries.push({
                type: 'method',
                label: member.name.getText(sf),
                detail: `(${params}) => ${ret}`,
                info: jsDocSummary(member),
            });
        }
    }
    return entries;
}

/** Scan src/ of a package, return config + instance entries per primitive. */
function scanPackage(ts, packageRoot) {
    const srcDir = resolve(packageRoot, 'src');
    const indexFile = resolve(srcDir, 'index.ts');
    const exportedNames = getExportedNames(ts, indexFile);
    const srcFiles = findTsFiles(srcDir);

    const program = ts.createProgram(srcFiles, {
        noEmit: true,
        skipLibCheck: true,
    });

    // Collect all exported interfaces by name across all source files.
    const exportedIfaces = new Map(); // name → { node, sf }
    for (const file of srcFiles) {
        const sf = program.getSourceFile(file);
        if (!sf) continue;
        ts.forEachChild(sf, (node) => {
            if (!ts.isInterfaceDeclaration(node)) return;
            const exported = node.modifiers?.some(
                (m) => m.kind === ts.SyntaxKind.ExportKeyword,
            );
            if (exported) exportedIfaces.set(node.name.text, { node, sf });
        });
    }

    const found = [];
    for (const [ifaceName, { node, sf }] of exportedIfaces) {
        if (!ifaceName.endsWith('Config')) continue;
        const fnName = configToFunctionName(ifaceName);
        if (!exportedNames.has(fnName)) continue;

        // Instance interface: same prefix, no Config suffix (StitchConfig → Stitch)
        const prefix = ifaceName.replace(/Config$/, '');
        const instanceIface = exportedIfaces.get(prefix);

        found.push({
            functionName: fnName,
            configEntries: extractConfigEntries(ts, node, sf),
            instanceEntries: instanceIface
                ? extractInstanceEntries(
                      ts,
                      instanceIface.node,
                      instanceIface.sf,
                  )
                : [],
        });

        // stderr, so `--emit` stdout stays pure (yakir hashes it against the file).
        console.error(
            `[completions-plugin] ${fnName}: ${found[found.length - 1].configEntries.length} config, ` +
                `${found[found.length - 1].instanceEntries.length} instance completions`,
        );
    }

    return found;
}

/* ── emit ─────────────────────────────────────────────────────────────────── */

function renderEntry({ type, label, detail, info }) {
    return (
        `        {\n` +
        `            label: ${JSON.stringify(label)},\n` +
        `            type: ${JSON.stringify(type)},\n` +
        `            detail: ${JSON.stringify(detail)},\n` +
        (info ? `            info: ${JSON.stringify(info)},\n` : '') +
        `        }`
    );
}

function renderBlock(map) {
    return Object.entries(map)
        .map(
            ([key, entries]) =>
                `    ${JSON.stringify(key)}: [\n${entries.map(renderEntry).join(',\n')},\n    ]`,
        )
        .join(',\n');
}

/* ── public API ───────────────────────────────────────────────────────────── */

/**
 * Build the generated-file content from a set of packages, without writing it.
 * Exposed so a drift check (yakir's `playground-completions` tether) can compare
 * the canonical output to the committed file without touching disk.
 */
export function renderPlaygroundCompletions({ packages }) {
    const ts = req('typescript');

    const allFound = packages.flatMap((pkgRoot) => scanPackage(ts, pkgRoot));

    const configMap = Object.fromEntries(
        allFound.map((r) => [r.functionName, r.configEntries]),
    );
    const instanceMap = Object.fromEntries(
        allFound
            .filter((r) => r.instanceEntries.length > 0)
            .map((r) => [r.functionName, r.instanceEntries]),
    );

    return [
        `// @generated — do not edit by hand.`,
        `// Regenerate: pnpm --filter @stitchapi/docs run gen:completions`,
        `import type { Completion } from '@codemirror/autocomplete';`,
        ``,
        `/** Config-key completions inside primitive({…}) call arguments. */`,
        `export const PLAYGROUND_COMPLETIONS: Record<string, Completion[]> = {`,
        renderBlock(configMap),
        `};`,
        ``,
        `/** Member completions on the value returned by a primitive call. */`,
        `export const PLAYGROUND_INSTANCE_COMPLETIONS: Record<string, Completion[]> = {`,
        renderBlock(instanceMap),
        `};`,
        ``,
    ].join('\n');
}

export async function generatePlaygroundCompletions({ packages, outputFile }) {
    const content = renderPlaygroundCompletions({ packages });
    writeFileSync(outputFile, content, 'utf8');
    console.log(`[completions-plugin] wrote → ${outputFile}`);
}

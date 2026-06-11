// Loads a user's stitches module and resolves stitches by name. Shared by every
// non-function surface (CLI `run`, HTTP `serve`, MCP) so they agree on what "the
// stitch named X" means: a stitch exported from the module, keyed by its export
// name and, as a fallback, its configured `name`.
import { type Stitch, isStitch } from './types';

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export type StitchRegistry = Record<string, Stitch>;

// Module names probed (in order) when no explicit module path is given.
export const DEFAULT_MODULES = [
    'stitches.ts',
    'stitches.mjs',
    'stitches.js',
    'stitches.cjs',
    'stitch.config.ts',
    'stitch.config.mjs',
    'stitch.config.js',
];

// Pull every stitch out of a module's exports. A stitch is recognized structurally
// (see isStitch), so this works regardless of how the module was authored:
//   - named exports that are stitches      → keyed by the export name
//   - a `default` export that is a stitch  → keyed "default"
//   - a `default` (or any) plain object    → contributes its stitch-valued members
// Non-stitch values are ignored; later entries win on name collision.
export function collectStitches(mod: unknown): StitchRegistry {
    const out: StitchRegistry = {};
    if (!mod || typeof mod !== 'object') return out;

    const addMembers = (obj: Record<string, unknown>): void => {
        for (const [k, v] of Object.entries(obj)) if (isStitch(v)) out[k] = v;
    };

    for (const [key, value] of Object.entries(mod as Record<string, unknown>)) {
        if (isStitch(value)) {
            out[key === 'default' ? (value.__config.name ?? 'default') : key] =
                value;
        } else if (
            value &&
            typeof value === 'object' &&
            !Array.isArray(value)
        ) {
            // a registry-shaped export, e.g. `export default { listX, getY }`
            addMembers(value as Record<string, unknown>);
        }
    }
    return out;
}

// Resolve a stitch by name: exact export-key match first, then a stitch whose
// configured `name` matches. Throws a helpful, listing error when absent.
export function selectStitch(registry: StitchRegistry, name: string): Stitch {
    const direct = registry[name];
    if (direct) return direct;
    for (const s of Object.values(registry))
        if (s.__config.name === name) return s;

    const available = Object.keys(registry).sort();
    const err = new Error(
        available.length
            ? `unknown stitch "${name}". Available: ${available.join(', ')}`
            : `unknown stitch "${name}" — no stitches found in the module`,
    );
    err.name = 'UnknownStitchError';
    throw err;
}

// Find the stitches module: an explicit path (relative to cwd) or the first
// existing default candidate. Throws when nothing is found.
export function resolveModulePath(
    explicit: string | undefined,
    cwd: string,
): string {
    if (explicit) return resolve(cwd, explicit);
    for (const candidate of DEFAULT_MODULES) {
        const full = resolve(cwd, candidate);
        if (existsSync(full)) return full;
    }
    const err = new Error(
        `no stitches module found (looked for ${DEFAULT_MODULES.join(', ')}). ` +
            `Pass --module <path>.`,
    );
    err.name = 'ModuleNotFoundError';
    throw err;
}

// How a module path becomes a module object. The default uses Node's ESM loader;
// callers can inject a TypeScript-aware importer (or a stub, in tests).
export type ModuleImporter = (url: string) => Promise<unknown>;
const defaultImporter: ModuleImporter = (url) => import(url);

// Import a module by path and collect its stitches. `.ts` modules require the host
// to have a TypeScript loader registered (e.g. run under tsx); point `--module` at
// compiled JS otherwise.
export async function loadStitches(
    modulePath: string,
    importer: ModuleImporter = defaultImporter,
): Promise<StitchRegistry> {
    const abs = resolve(modulePath);
    const mod = await importer(pathToFileURL(abs).href);
    return collectStitches(mod);
}

// Direct unit tests for src/registry.ts — the stitch-discovery layer shared by the CLI,
// HTTP serve, and MCP surfaces. cli.spec.ts already covers the happy paths (named +
// nested + default-object collection, select-by-key, the populated unknown-name
// error, and loadStitches' URL handling). These cover the branches it leaves open:
//
//   collectStitches  — a `default` export that is *itself* a stitch (keyed by its
//                       configured name, else "default"), non-object module input,
//                       and the "later entries win on name collision" rule.
//   selectStitch     — own-key-only resolution (no configured-name fallback, no inherited
//                       `Object.prototype` keys — #866), and the *empty* registry error path
//                       (a distinct message + the typed error name).
//   resolveModulePath — has no direct test today: explicit-path resolution, default-
//                       candidate probing order, and the ModuleNotFoundError throw.
import { stitch } from '../src';
import {
    collectStitches,
    resolveModulePath,
    selectStitch,
} from '../src/registry';

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const mk = (extra: Record<string, unknown> = {}) =>
    stitch({ baseUrl: 'http://x', path: '/p', ...extra });

describe('collectStitches', () => {
    it('keys a stitch default export by its configured name', () => {
        const primary = mk({ name: 'primary' });
        expect(collectStitches({ default: primary })).toEqual({
            primary,
        });
    });

    it('keys an unnamed stitch default export as "default"', () => {
        const anon = mk();
        expect(collectStitches({ default: anon })).toEqual({ default: anon });
    });

    it('returns an empty registry for non-object module input', () => {
        expect(collectStitches(null)).toEqual({});
        expect(collectStitches(undefined)).toEqual({});
        expect(collectStitches(42)).toEqual({});
        expect(collectStitches('not a module')).toEqual({});
    });

    it('lets a later entry win on a name collision', () => {
        const first = mk({ path: '/first' });
        const second = mk({ path: '/second' });
        // top-level `dup` is collected first, then the nested `dup` overwrites it.
        const reg = collectStitches({ dup: first, nested: { dup: second } });
        expect(reg['dup']).toBe(second);
    });
});

describe('selectStitch', () => {
    it('resolves the export key, even when another stitch is *named* that', () => {
        const byKey = mk({ name: 'other' });
        const byName = mk({ name: 'target' });
        const reg = { target: byKey, something: byName };
        expect(selectStitch(reg, 'target')).toBe(byKey);
    });

    // #866 — the callable identity is exactly what `list_stitches` / `GET /` show. A configured-name
    // fallback kept a stitch the registry RENAMED (to hide it) answering to its original name.
    it('does not fall back to a configured name', () => {
        const reg = { safeAlias: mk({ name: 'dangerous' }) };
        expect(() => selectStitch(reg, 'dangerous')).toThrow(
            'unknown stitch "dangerous". Available: safeAlias',
        );
    });

    it.each(['constructor', 'toString', 'hasOwnProperty', '__proto__'])(
        'treats the inherited key %s as an unknown stitch',
        (name) => {
            const reg = { a: mk() };
            expect(() => selectStitch(reg, name)).toThrow(
                `unknown stitch "${name}". Available: a`,
            );
        },
    );

    it('resolves an own key that shadows an Object.prototype name', () => {
        const own = mk();
        expect(selectStitch({ constructor: own }, 'constructor')).toBe(own);
    });

    it('throws a typed, empty-registry error when nothing is registered', () => {
        let caught: unknown;
        try {
            selectStitch({}, 'whatever');
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).name).toBe('UnknownStitchError');
        expect((caught as Error).message).toMatch(
            /no stitches found in the module/,
        );
    });
});

describe('resolveModulePath', () => {
    it('resolves an explicit path against the cwd', () => {
        expect(resolveModulePath('sub/mod.ts', '/base')).toBe(
            resolve('/base', 'sub/mod.ts'),
        );
    });

    it('probes the default candidates in order and returns the first that exists', () => {
        const dir = mkdtempSync(join(tmpdir(), 'stitch-registry-'));
        // stitches.js is earlier in DEFAULT_MODULES than stitch.config.js; both exist,
        // so the earlier candidate must win (and the absent stitches.ts/.mjs are skipped).
        writeFileSync(join(dir, 'stitches.js'), 'export const a = 1;\n');
        writeFileSync(join(dir, 'stitch.config.js'), 'export const b = 1;\n');
        expect(resolveModulePath(undefined, dir)).toBe(
            resolve(dir, 'stitches.js'),
        );
    });

    it('throws a typed ModuleNotFoundError when no candidate exists', () => {
        const dir = mkdtempSync(join(tmpdir(), 'stitch-registry-empty-'));
        let caught: unknown;
        try {
            resolveModulePath(undefined, dir);
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).name).toBe('ModuleNotFoundError');
        expect((caught as Error).message).toMatch(/no stitches module found/);
    });
});

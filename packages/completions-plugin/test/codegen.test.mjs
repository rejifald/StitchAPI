// Tests for @stitchapi/completions-plugin: the codegen that scans a package for
// exported *Config interfaces and emits the playground completions maps, plus the
// webpack plugin wrapper's error-swallowing. Uses Node's built-in test runner
// (no deps); each test builds a throwaway fixture package in a temp dir.
import {
    PlaygroundCompletionsPlugin,
    generatePlaygroundCompletions,
} from '../index.mjs';

import assert from 'node:assert/strict';
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

/** Create a throwaway package with `src/index.ts`; returns its root. */
function fixturePackage(indexTs) {
    const root = mkdtempSync(join(tmpdir(), 'stitch-completions-'));
    const src = join(root, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'index.ts'), indexTs, 'utf8');
    return root;
}

test('emits config + instance completions for a matched primitive', async () => {
    const pkg = fixturePackage(
        [
            'export function stitch() {}',
            'export interface StitchConfig {',
            '    /** The base URL. */',
            '    baseUrl: string;',
            '}',
            'export interface Stitch {',
            '    /** Stream the response. */',
            '    stream(): void;',
            '}',
            '',
        ].join('\n'),
    );
    const out = join(pkg, 'out.generated.ts');
    try {
        await generatePlaygroundCompletions({
            packages: [pkg],
            outputFile: out,
        });
        const content = readFileSync(out, 'utf8');

        assert.match(content, /@generated/);
        assert.match(content, /PLAYGROUND_COMPLETIONS/);
        assert.match(content, /PLAYGROUND_INSTANCE_COMPLETIONS/);
        // StitchConfig → `stitch` call-arg completions, incl. the baseUrl key.
        assert.match(content, /stitch/);
        assert.match(content, /baseUrl/);
        // The Stitch instance interface → the stream() member completion.
        assert.match(content, /stream/);
    } finally {
        rmSync(pkg, { recursive: true, force: true });
    }
});

test('a `{@link …}` in a doc comment renders its target, not a gap', async () => {
    // TypeScript models `{@link X}` as a JSDocLink node whose `.text` holds only the trailing
    // LABEL — the target lives on `.name`. Joining `.text` alone dropped the reference and left
    // the prose dangling around the hole ("Spell the slots as  declares them"), which shipped
    // into four real playground tooltips before this was fixed.
    const pkg = fixturePackage(
        [
            'export function stitch() {}',
            'export interface StitchInput { params?: unknown }',
            'export interface Other { nested?: unknown }',
            'export interface StitchConfig {',
            '    /** Spell it as {@link StitchInput} declares it. */',
            '    baseUrl: string;',
            '    /** See {@link Other.nested} for the shape. */',
            '    path: string;',
            '    /** Use {@link StitchInput the input bag} instead. */',
            '    url: string;',
            '}',
            '',
        ].join('\n'),
    );
    const out = join(pkg, 'out.generated.ts');
    try {
        await generatePlaygroundCompletions({
            packages: [pkg],
            outputFile: out,
        });
        const content = readFileSync(out, 'utf8');

        // A bare link renders its target.
        assert.match(
            content,
            /Spell it as StitchInput declares it\./,
            'bare {@link Target} should render the target name',
        );
        // A qualified target keeps its dotted path.
        assert.match(
            content,
            /See Other\.nested for the shape\./,
            'qualified {@link A.b} should render as A.b',
        );
        // An explicit label wins over the target, as JSDoc renders it.
        assert.match(
            content,
            /Use the input bag instead\./,
            '{@link Target label} should render the label',
        );
        // The regression itself: no doubled space anywhere in an emitted `info`.
        for (const [, info] of content.matchAll(/info: "(.*?)",\n/g))
            assert.doesNotMatch(
                info,
                / {2}/,
                `emitted info should not contain a doubled space: ${info}`,
            );
    } finally {
        rmSync(pkg, { recursive: true, force: true });
    }
});

test('emits empty maps for a package with no *Config interface', async () => {
    const pkg = fixturePackage('export const x = 1;\n');
    const out = join(pkg, 'out.generated.ts');
    try {
        await generatePlaygroundCompletions({
            packages: [pkg],
            outputFile: out,
        });
        const content = readFileSync(out, 'utf8');

        // The maps are still declared, but carry no derived entries.
        assert.match(content, /PLAYGROUND_COMPLETIONS/);
        assert.doesNotMatch(content, /baseUrl/);
    } finally {
        rmSync(pkg, { recursive: true, force: true });
    }
});

test('a *Config whose function name is NOT exported is skipped', async () => {
    // `WidgetConfig` → `widget`, but `widget` is not exported from index.ts, so
    // the discovery rule drops it.
    const pkg = fixturePackage(
        [
            'export const x = 1;',
            'export interface WidgetConfig {',
            '    size: number;',
            '}',
            '',
        ].join('\n'),
    );
    const out = join(pkg, 'out.generated.ts');
    try {
        await generatePlaygroundCompletions({
            packages: [pkg],
            outputFile: out,
        });
        const content = readFileSync(out, 'utf8');
        assert.doesNotMatch(content, /widget/);
        assert.doesNotMatch(content, /size/);
    } finally {
        rmSync(pkg, { recursive: true, force: true });
    }
});

test('PlaygroundCompletionsPlugin.apply taps beforeCompile and swallows errors', async () => {
    let tapped;
    const compiler = {
        hooks: {
            beforeCompile: {
                tapAsync(name, fn) {
                    assert.equal(name, 'PlaygroundCompletionsPlugin');
                    tapped = fn;
                },
            },
        },
    };

    // A non-existent package makes generatePlaygroundCompletions throw; apply must
    // swallow it and still call webpack's callback so the build proceeds.
    new PlaygroundCompletionsPlugin({
        packages: ['/no/such/package-xyz-stitchapi'],
        outputFile: join(tmpdir(), 'unused.generated.ts'),
    }).apply(compiler);

    assert.equal(typeof tapped, 'function', 'registered a beforeCompile hook');

    let called = false;
    await new Promise((resolve) => {
        tapped({}, () => {
            called = true;
            resolve();
        });
    });
    assert.equal(called, true, 'callback invoked despite the codegen error');
});

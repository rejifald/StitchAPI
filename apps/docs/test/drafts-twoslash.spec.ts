import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTwoslasher } from 'twoslash';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Type-checks the TypeScript in `content/drafts/*.mdx` against the REAL `stitchapi`
// types, the same guarantee `next build` gives blog posts — but for drafts that live
// OUTSIDE any fumadocs collection, so they are verified yet never published (no route,
// no sitemap, no RSS). Every ```ts twoslash``` block is run through the twoslash
// compiler; a type error throws and fails the block. In-block `// @noErrors` /
// `// @errors: <code>` directives are honored by twoslash, so an intentional
// anti-pattern snippet can opt out explicitly.
//
// Build-dependent, like the other lib/-consuming suites (mcp-e2e, sandbox): twoslash
// resolves `stitchapi` from packages/core/lib, so when core is not built this suite
// self-skips rather than failing with a confusing "Cannot find module" (2307). In the
// CI `verify` job `pnpm check:types` builds core (build:typed-deps) before `pnpm test`,
// so it runs for real there.

const DOCS_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const DRAFTS = resolve(DOCS_ROOT, 'content', 'drafts');
const CORE_TYPES = resolve(
    DOCS_ROOT,
    '..',
    '..',
    'packages',
    'core',
    'lib',
    'index.d.mts',
);

const TS_LANGS = new Set(['ts', 'typescript', 'tsx']);

interface Block {
    slug: string;
    line: number;
    lang: 'ts' | 'tsx';
    code: string;
}

/** Every ```ts twoslash``` / ```tsx twoslash``` block across all drafts, with its body. */
function readTwoslashBlocks(): Block[] {
    if (!existsSync(DRAFTS)) return [];
    const blocks: Block[] = [];
    for (const entry of readdirSync(DRAFTS, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.mdx')) continue;
        const slug = basename(entry.name, '.mdx');
        const lines = readFileSync(join(DRAFTS, entry.name), 'utf8').split(
            '\n',
        );
        let open: { line: number; info: string; body: string[] } | null = null;
        lines.forEach((raw, i) => {
            const fence = /^```(.*)$/.exec(raw);
            if (fence && !open) {
                open = { line: i + 1, info: fence[1].trim(), body: [] };
                return;
            }
            if (fence && open) {
                const lang = open.info.split(/\s+/)[0];
                if (TS_LANGS.has(lang) && /\btwoslash\b/.test(open.info)) {
                    blocks.push({
                        slug,
                        line: open.line,
                        lang: lang === 'tsx' ? 'tsx' : 'ts',
                        code: open.body.join('\n'),
                    });
                }
                open = null;
                return;
            }
            if (open) open.body.push(raw);
        });
    }
    return blocks;
}

const twoslasher = createTwoslasher({
    vfsRoot: DOCS_ROOT,
    compilerOptions: {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        jsx: ts.JsxEmit.ReactJSX,
        strict: true,
        experimentalDecorators: true,
        skipLibCheck: true,
        noEmit: true,
    },
});

const blocks = readTwoslashBlocks();
const coreBuilt = existsSync(CORE_TYPES);

describe.skipIf(!coreBuilt)('drafts twoslash type-check', () => {
    it('found twoslash blocks to check', () => {
        expect(blocks.length).toBeGreaterThan(0);
    });

    for (const block of blocks) {
        it(`${block.slug}.mdx:${block.line} type-checks against real stitchapi types`, () => {
            // twoslasher throws a TwoslashError listing the compiler errors when a
            // block does not type-check (and honors in-block // @errors / // @noErrors).
            expect(() => twoslasher(block.code, block.lang)).not.toThrow();
        });
    }
});

describe.runIf(!coreBuilt)('drafts twoslash type-check (skipped)', () => {
    it('core is not built — run `pnpm check:types` first to verify drafts', () => {
        expect(coreBuilt).toBe(false);
    });
});

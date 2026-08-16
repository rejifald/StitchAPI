// Ask the COMPILER which failover spellings exist, instead of grepping for them.
//
// "There is no sequential-fallback combinator" and "I could not find the sequential-fallback
// combinator" are different findings, and only one of them is the library's problem. So the honest
// way to establish what the `stitchapi/pipe` vocabulary contains is to hand the compiler one
// candidate statement per spelling and read back its diagnostics: a namespace access
// (`pipe.fallback`) fails with 2339 when the export does not exist, and an unknown key inside a
// house envelope fails with a `NoUnknownNestedKeys` diagnostic naming the slot
// (types.ts:411-448). A line that compiles is a spelling that EXISTS.
//
// The fixture is written to a temp dir (not into the repo) and deleted afterwards, so this leaves
// nothing behind and never lands in `prettier --check`. It imports core by ABSOLUTE path, which is
// why it can live outside the tree.
//
// `typescript` is loaded through a `require` ANCHORED AT `packages/core`, which is the workspace
// package that declares it. A bare `import ts from 'typescript'` resolves under `tsx` and NOT under
// plain Node from this directory (pnpm gives `docs/` no `node_modules`), so the bare form would be
// a script that runs one way and typechecks another. The compiler surface used is tiny, so it is
// declared structurally here rather than imported as a type.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Absolute path to core's barrel, so the fixture can be compiled from anywhere. */
export const CORE = join(HERE, '../../../../packages/core/src/index');
/** Absolute path to the `stitchapi/pipe` subpath module — where the combinators live. */
export const PIPE = join(HERE, '../../../../packages/core/src/pipe');

/** The slice of the TypeScript compiler API this probe uses. */
interface TsCompiler {
    readonly ScriptTarget: Record<string, number>;
    readonly ModuleKind: Record<string, number>;
    readonly ModuleResolutionKind: Record<string, number>;
    createProgram(
        rootNames: readonly string[],
        options: Record<string, unknown>,
    ): unknown;
    getPreEmitDiagnostics(program: unknown): readonly {
        code: number;
        start?: number | undefined;
        file?:
            | {
                  fileName: string;
                  getLineAndCharacterOfPosition(pos: number): { line: number };
              }
            | undefined;
    }[];
}

const ts = createRequire(join(HERE, '../../../../packages/core/package.json'))(
    'typescript',
) as TsCompiler;

export interface Candidate {
    /** What a reader would call this spelling — printed in the report. */
    label: string;
    /** One statement. Compiles ⇒ the spelling exists. */
    code: string;
}

export interface ProbeResult extends Candidate {
    compiles: boolean;
    /** First diagnostic code, e.g. 2339 (no such property) or 2353 (unknown object key). */
    diagnostic?: number;
}

/**
 * Typecheck each candidate as its own statement in one program and report which compile.
 * Diagnostics are attributed by LINE, so each candidate must be a single line.
 *
 * The header puts a namespace `pipe`, a `stitch` factory and two ready-made stitches (`a`, `b`) in
 * scope, so a candidate can probe either a missing EXPORT or a missing CONFIG KEY.
 */
export function probeSpellings(
    candidates: readonly Candidate[],
): ProbeResult[] {
    const dir = mkdtempSync(join(tmpdir(), 'stitch-failover-probe-'));
    const file = join(dir, 'probe.ts');
    const header = [
        `import * as pipe from ${JSON.stringify(PIPE)};`,
        `import { stitch } from ${JSON.stringify(CORE)};`,
        `const a = stitch({ url: 'https://primary.test/v1/complete' });`,
        `const b = stitch({ url: 'https://backup.test/generate' });`,
        `void [pipe, stitch, a, b];`,
    ];
    try {
        writeFileSync(
            file,
            [...header, ...candidates.map((c) => c.code)].join('\n'),
        );
        const program = ts.createProgram([file], {
            target: ts.ScriptTarget['ES2022'],
            module: ts.ModuleKind['ESNext'],
            moduleResolution: ts.ModuleResolutionKind['Bundler'],
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            exactOptionalPropertyTypes: true,
            noUncheckedIndexedAccess: true,
        });
        const byLine = new Map<number, number>();
        for (const d of ts.getPreEmitDiagnostics(program)) {
            if (d.file?.fileName !== file || d.start === undefined) continue;
            const { line } = d.file.getLineAndCharacterOfPosition(d.start);
            if (!byLine.has(line)) byLine.set(line, d.code);
        }
        return candidates.map((c, i) => {
            const diagnostic = byLine.get(header.length + i);
            return diagnostic === undefined
                ? { ...c, compiles: true }
                : { ...c, compiles: false, diagnostic };
        });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/** The spellings that compiled — the vocabulary that actually exists. */
export const accepted = (results: readonly ProbeResult[]): string[] =>
    results.filter((r) => r.compiles).map((r) => r.label);

/** The spellings the compiler refused. */
export const rejected = (results: readonly ProbeResult[]): string[] =>
    results.filter((r) => !r.compiles).map((r) => r.label);

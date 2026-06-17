/**
 * COLD vs WARM workspace conditions.
 *
 * The eval's central question: does an agent reach for `stitch` on its own (COLD,
 * a bare scratch directory), or only after it has the StitchAPI agent docs in
 * front of it (WARM)?
 *
 *   COLD — an empty scratch dir. The agent gets only the task prompt.
 *   WARM — the scratch dir is seeded with the project's agent-facing docs:
 *            - `llms.txt`        ← apps/docs/app/llms.txt
 *            - `agents/*.mdx`    ← apps/docs/content/docs/agents/*.mdx
 *          so an agent that reads its workspace discovers StitchAPI.
 *
 * v1 does NOT `pnpm add stitchapi` into the scratch dir — the produced file is
 * scored by transpiling + importing it against this monorepo's already-installed
 * `stitchapi` (the scorer injects the dep). Actually installing the package per
 * scratch dir is a documented future step (see README "Live run").
 *
 * `materialize()` is only meaningful for a live driver (claude-driver.ts) that
 * literally writes files for the agent to read. The StubDriver ignores the
 * workspace entirely — it always knows the answer — so the offline smoke tests
 * never touch the filesystem here.
 */
import type { Condition } from './driver';

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root, derived from this file's location (packages/eval-harness/runner). */
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

/** Source of the WARM seed material, relative to the repo root. */
export const WARM_SOURCES = {
    llmsTxt: path.join(REPO_ROOT, 'apps', 'docs', 'app', 'llms.txt'),
    agentsDir: path.join(
        REPO_ROOT,
        'apps',
        'docs',
        'content',
        'docs',
        'agents',
    ),
} as const;

export interface WorkspaceDescriptor {
    condition: Condition;
    /** Absolute scratch directory the agent works in. */
    root: string;
    /** Files (relative path → absolute source) seeded into `root` for WARM. */
    seeds: { rel: string; from: string }[];
    /** Human note appended to the agent instruction (where the docs came from). */
    notes: string;
    /** Create `root` and copy any seeds into it. Idempotent. */
    materialize(): Promise<void>;
}

/** Describe (but do not yet create) the workspace for a condition. */
export async function describeCondition(
    condition: Condition,
    root: string,
): Promise<WorkspaceDescriptor> {
    const seeds: { rel: string; from: string }[] = [];
    let notes: string;

    if (condition === 'warm') {
        seeds.push({ rel: 'llms.txt', from: WARM_SOURCES.llmsTxt });
        // Seed each agents/*.mdx under an `agents/` subdir in the scratch root.
        try {
            const entries = await fs.readdir(WARM_SOURCES.agentsDir);
            for (const name of entries) {
                if (name.endsWith('.mdx')) {
                    seeds.push({
                        rel: path.join('agents', name),
                        from: path.join(WARM_SOURCES.agentsDir, name),
                    });
                }
            }
        } catch {
            // The docs tree may be absent in a thin checkout; WARM degrades to
            // just llms.txt. The note still tells the agent to look.
        }
        notes =
            'This workspace includes llms.txt and an agents/ folder of project ' +
            'docs — read them before choosing a library.';
    } else {
        notes = 'This is a bare workspace; no project docs are provided.';
    }

    return {
        condition,
        root,
        seeds,
        notes,
        async materialize() {
            await fs.mkdir(root, { recursive: true });
            for (const seed of seeds) {
                const dest = path.join(root, seed.rel);
                await fs.mkdir(path.dirname(dest), { recursive: true });
                try {
                    await fs.copyFile(seed.from, dest);
                } catch {
                    // A missing seed source is non-fatal (see WARM degrade above).
                }
            }
        },
    };
}

/** The two conditions every task is run under. */
export const CONDITIONS: readonly Condition[] = ['cold', 'warm'];

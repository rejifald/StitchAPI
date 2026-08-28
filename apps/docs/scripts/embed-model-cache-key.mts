// Prints the cache identity of the vendored embedding model (MODEL_DIR — see
// lib/search-index/config.ts), for the `search-relevance` job's actions/cache
// key in .github/workflows/verify.yml.
//
// The point is what is NOT in the key: the lockfile. The job used to key this
// cache on `hashFiles('pnpm-lock.yaml')` with no restore-keys, which made the
// highest-volume PR class here — a dependabot bump, i.e. a PR whose only change
// IS the lockfile — a guaranteed cache miss and a guaranteed ~83 MB HuggingFace
// CDN download. Since Actions cache ref-scoping also stops one PR from reading a
// sibling PR's entry, those misses never healed: the repo accumulated eight
// near-identical 83 MB entries under eight different lockfile hashes, none of
// which could serve the next PR. On 2026-08-28 four dependabot runs started
// within 40 seconds, three won the race, and the fourth (#758) took a 429 and
// failed the job before a single relevance assertion ran.
//
// So key it on what the vendored files actually depend on:
//   EMBED_MODEL  — which HuggingFace repo is downloaded
//   EMBED_DTYPE  — which ONNX weight variant within it
//   @huggingface/transformers version — the on-disk layout embed.ts reads back
//
// A lockfile-only change now hits the key exactly. A transformers bump misses it
// and re-fetches, which is what the old key's comment claimed it wanted; the
// job's `restore-keys: embed-model-` still seeds that run from the previous
// copy, so even the miss stays network-free in practice.
import { EMBED_DTYPE, EMBED_MODEL } from '../lib/search-index/config';

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

/** Installed version of `@huggingface/transformers`, from its package.json.
 * Resolved through its entry point and walked up, because the package does not
 * export `./package.json` (ERR_PACKAGE_PATH_NOT_EXPORTED). */
function transformersVersion(): string {
    const require = createRequire(import.meta.url);
    let dir = dirname(require.resolve('@huggingface/transformers'));
    for (let up = 0; up < 6; up++) {
        try {
            const pkg = JSON.parse(
                readFileSync(resolve(dir, 'package.json'), 'utf8'),
            ) as { name?: string; version?: string };
            if (pkg.name === '@huggingface/transformers' && pkg.version) {
                return pkg.version;
            }
        } catch {
            // Keep walking — not every ancestor directory has a package.json.
        }
        dir = dirname(dir);
    }
    throw new Error(
        '[embed-model-cache-key] could not resolve @huggingface/transformers version',
    );
}

// Actions cache keys are plain text; keep to the charset verify.yml's other keys
// use, so a model id like `Xenova/all-MiniLM-L6-v2` stays readable in the log.
const key =
    `embed-model-${EMBED_MODEL}-${EMBED_DTYPE}-transformers${transformersVersion()}`
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .toLowerCase();

// Bare key on the last line — the workflow reads it with `tail -n1`.
console.log(key);

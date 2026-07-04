#!/usr/bin/env node

/**
 * Drift gate for the generated demo media (docs/media/README.md): if a
 * branch changes the scene or the generator, the committed README webp
 * pair must be regenerated in the same branch — otherwise the "generated,
 * not hand-recorded" promise silently breaks and stale assets ship.
 *
 * Mirrors the repo's other drift gates (yakir, check:contract): cheap
 * path comparison, no build. Escape hatch for intentionally-deferred
 * regens: STITCH_MEDIA_STALE_OK=1.
 */
import { execFileSync } from 'node:child_process';

const SOURCES = ['apps/docs/app/demo/', 'scripts/gen-demo.mjs'];
const ASSETS = [
    'docs/media/demo.webp',
    'docs/media/demo-dark.webp',
    'docs/media/demo@2x.webp',
    'docs/media/demo-dark@2x.webp',
];

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

if (process.env.STITCH_MEDIA_STALE_OK === '1') {
    console.log('media-freshness: skipped (STITCH_MEDIA_STALE_OK=1)');
    process.exit(0);
}

let base;
try {
    base = git('merge-base', 'HEAD', 'origin/main');
} catch {
    console.log('media-freshness: no origin/main merge-base — skipping');
    process.exit(0);
}
if (base === git('rev-parse', 'HEAD')) {
    console.log('media-freshness: HEAD is on origin/main — nothing to check');
    process.exit(0);
}

const changed = git('diff', '--name-only', `${base}..HEAD`).split('\n');
const touchedSource = changed.some((f) =>
    SOURCES.some((s) => (s.endsWith('/') ? f.startsWith(s) : f === s)),
);
const touchedAssets = ASSETS.every((a) => changed.includes(a));

if (touchedSource && !touchedAssets) {
    console.error(
        'media-freshness: the demo scene/generator changed on this branch but the\n' +
            `committed README embed (${ASSETS.join(', ')})\n` +
            'was not regenerated. Run `pnpm gen:media` and commit the webp pair, or\n' +
            'set STITCH_MEDIA_STALE_OK=1 to defer intentionally.',
    );
    process.exit(1);
}
console.log('media-freshness: OK');

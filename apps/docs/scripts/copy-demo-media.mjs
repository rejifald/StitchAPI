// Copy the committed demo webp pairs (docs/media, tracked in git) into
// public/media so <DemoMedia /> can serve them. public/media is
// gitignored — docs/media stays the single committed location (the README
// references it), and this keeps the two from drifting.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '../..');
const src = join(repoRoot, 'docs/media');
const dest = join(appRoot, 'public/media');

const FILES = [
    'demo.webp',
    'demo@2x.webp',
    'demo-dark.webp',
    'demo-dark@2x.webp',
    'demo-clip.mp4',
    'demo-dark-clip.mp4',
];

// Missing files are skipped, not fatal: `pnpm gen:media` itself boots this
// dev server BEFORE the assets exist (fresh clone / renamed assets), and
// the site renders fine without the embeds until they're generated.
mkdirSync(dest, { recursive: true });
let copied = 0;
const missing = [];
for (const file of FILES) {
    if (!existsSync(join(src, file))) {
        missing.push(file);
        continue;
    }
    copyFileSync(join(src, file), join(dest, file));
    copied++;
}
console.log(
    `copied ${copied}/${FILES.length} demo media files → public/media` +
        (missing.length
            ? ` (missing: ${missing.join(', ')} — run \`pnpm gen:media\`)`
            : ''),
);

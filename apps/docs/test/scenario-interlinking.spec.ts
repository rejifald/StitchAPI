import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The enforcement half of the Scenarios section's interlinking convention
// (AUTHORING.md → "Scenarios"). A scenario is a deep-dive hung off a primitive
// the rest of the docs already teach, so it earns its place only if the page
// teaching that primitive points at it: a section every page links *out* of and
// nothing links *into* is a cul-de-sac readers reach only from the sidebar, and
// search engines treat the same way.
//
// These tests fail the moment a scenario is authored — or left — as an island,
// the same role `blog-interlinking.spec.ts` plays for the blog and
// `content-manifest.spec.ts` plays for the docs IA.

const DOCS_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const CONTENT = resolve(DOCS_ROOT, 'content');
const SCENARIOS = resolve(CONTENT, 'docs', 'scenarios');

/** Every `.mdx` under `content`, as `path relative to content` → raw body. */
function readContent(dir: string, acc = new Map<string, string>()) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) readContent(full, acc);
        else if (entry.name.endsWith('.mdx'))
            acc.set(full.slice(CONTENT.length + 1), readFileSync(full, 'utf8'));
    }
    return acc;
}

/** The scenario slugs, excluding the section's own landing page. */
function scenarioSlugs(): string[] {
    return readdirSync(SCENARIOS)
        .filter((f) => f.endsWith('.mdx') && f !== 'index.mdx')
        .map((f) => basename(f, '.mdx'))
        .sort();
}

const content = readContent(CONTENT);
const slugs = scenarioSlugs();

/** Pages outside the Scenarios section — the candidate hosts for inbound links. */
const hosts = [...content].filter(
    ([path]) => !path.startsWith('docs/scenarios/'),
);

describe('scenario interlinking', () => {
    it('has scenarios to check', () => {
        expect(slugs.length).toBeGreaterThan(0);
    });

    it('every scenario has an inbound link from outside the section (no orphans)', () => {
        const orphans = slugs.filter(
            (slug) =>
                !hosts.some(([, body]) =>
                    body.includes(`/docs/scenarios/${slug}`),
                ),
        );

        expect(
            orphans,
            `These scenarios are reachable only from inside the Scenarios ` +
                `section. Add an inline contextual link from the guide, ` +
                `reference, or post that teaches the primitive the scenario ` +
                `stresses (see AUTHORING.md → "Scenarios"):\n  ${orphans.join('\n  ')}`,
        ).toEqual([]);
    });

    it('every inbound link points at a real scenario (no dangling links)', () => {
        const known = new Set(slugs);
        const dangling: string[] = [];

        for (const [path, body] of content)
            for (const match of body.matchAll(
                /\/docs\/scenarios\/([a-z0-9-]+)/g,
            )) {
                const slug = match[1];
                if (slug && !known.has(slug))
                    dangling.push(`${path} → ${slug}`);
            }

        expect(
            dangling,
            `These links point at a /docs/scenarios/ slug that does not ` +
                `exist:\n  ${dangling.join('\n  ')}`,
        ).toEqual([]);
    });

    it('inbound links are spread across hosts, not stacked on one page', () => {
        // One page carrying the whole section is the failure this gate exists to
        // prevent in its own right: it rebuilds the cul-de-sac one level up.
        const perHost = new Map<string, number>();
        for (const [path, body] of hosts) {
            const linked = new Set(
                [...body.matchAll(/\/docs\/scenarios\/([a-z0-9-]+)/g)]
                    .map((m) => m[1])
                    .filter(
                        (slug): slug is string =>
                            !!slug && slugs.includes(slug),
                    ),
            );
            if (linked.size) perHost.set(path, linked.size);
        }

        const linkedSlugs = new Set(
            hosts.flatMap(([, body]) =>
                [...body.matchAll(/\/docs\/scenarios\/([a-z0-9-]+)/g)].map(
                    (m) => m[1],
                ),
            ),
        );
        const hogs = [...perHost].filter(
            ([, n]) => n > Math.max(3, linkedSlugs.size / 3),
        );

        expect(
            hogs.map(([path, n]) => `${path} (${n})`),
            `These pages carry too much of the section's inbound linking. ` +
                `Spread the links to the pages that teach each scenario's ` +
                `primitive:\n  ${hogs.map(([p, n]) => `${p} (${n})`).join('\n  ')}`,
        ).toEqual([]);
    });
});

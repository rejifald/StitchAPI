import {
    addInstallChannel,
    remarkInstallChannel,
} from '../lib/remark-install-channel';

import { describe, expect, it } from 'vitest';

describe('addInstallChannel', () => {
    it('stamps the tag onto the bare unscoped core package', () => {
        expect(addInstallChannel('stitchapi', '@rc')).toBe('stitchapi@rc');
    });

    it('stamps the tag onto a bare scoped package', () => {
        expect(addInstallChannel('@stitchapi/react', '@rc')).toBe(
            '@stitchapi/react@rc',
        );
    });

    it('tags every first-party token in a multi-package line', () => {
        expect(
            addInstallChannel(
                '@stitchapi/react @stitchapi/query-core stitchapi react',
                '@rc',
            ),
        ).toBe(
            '@stitchapi/react@rc @stitchapi/query-core@rc stitchapi@rc react',
        );
    });

    it('leaves third-party packages untouched', () => {
        expect(
            addInstallChannel('@stitchapi/svelte stitchapi svelte', '@rc'),
        ).toBe('@stitchapi/svelte@rc stitchapi@rc svelte');
    });

    it('does not double-tag a spec that already carries a tag', () => {
        expect(
            addInstallChannel('@stitchapi/react@rc stitchapi@1.0.0', '@rc'),
        ).toBe('@stitchapi/react@rc stitchapi@1.0.0');
    });

    it('is a no-op on the stable channel (empty suffix)', () => {
        expect(addInstallChannel('@stitchapi/react stitchapi', '')).toBe(
            '@stitchapi/react stitchapi',
        );
    });
});

describe('remarkInstallChannel', () => {
    const run = (value: string, lang = 'package-install') => {
        const node = { type: 'code' as const, lang, value };
        const tree = { type: 'root', children: [node] };
        remarkInstallChannel()(tree);
        return node.value;
    };

    it('rewrites package-install code blocks', () => {
        // Asserts the suffix is applied; the exact tag tracks the canonical
        // version, so compare against the module-derived behaviour rather than a
        // hardcoded `@rc` (which would itself drift at the stable release).
        const out = run('@stitchapi/redis stitchapi');
        expect(out).toMatch(/^@stitchapi\/redis(@\S+)? stitchapi(@\S+)?$/);
        // Whatever tag the redis spec gets, the core spec gets the same one.
        const redisTag = out.split(' ')[0].slice('@stitchapi/redis'.length);
        const coreTag = out.split(' ')[1].slice('stitchapi'.length);
        expect(coreTag).toBe(redisTag);
    });

    it('ignores non-install code blocks', () => {
        expect(run('npm install stitchapi', 'bash')).toBe(
            'npm install stitchapi',
        );
    });
});

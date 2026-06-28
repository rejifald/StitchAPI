import { gitConfig } from './shared';

import { NpmIcon } from '@/app/(home)/components/primitives';
import { Logo } from '@/components/logo';

import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

export function baseOptions(): BaseLayoutProps {
    return {
        nav: {
            // JSX supported
            title: <Logo />,
        },
        links: [
            {
                text: 'Docs',
                url: '/docs',
            },
            {
                text: 'Blog',
                url: '/blog',
            },
            {
                text: 'Playground',
                url: '/playground',
            },
            {
                type: 'icon',
                label: 'npm',
                icon: <NpmIcon />,
                text: 'npm',
                url: 'https://www.npmjs.com/package/stitchapi',
                external: true,
            },
        ],
        githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
    };
}

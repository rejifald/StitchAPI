import { gitConfig } from './shared';

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
                text: 'Playground',
                url: '/playground',
            },
            {
                text: 'npm',
                url: 'https://www.npmjs.com/package/stitchapi',
                external: true,
            },
        ],
        githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
    };
}

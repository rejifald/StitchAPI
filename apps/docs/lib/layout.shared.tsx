import { npmUrl } from './shared';

import { GithubStarButton } from '@/app/(home)/components/github-star-button';
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
                url: npmUrl,
                external: true,
            },
            // "Star on GitHub" CTA with a live count — supersedes the plain
            // `githubUrl` icon (removed) so there is one GitHub affordance, and
            // it rides the right ("secondary") side of the nav on every page.
            {
                type: 'custom',
                secondary: true,
                children: <GithubStarButton />,
            },
        ],
    };
}

import { npmUrl } from './shared';

import { NpmIcon } from '@/app/(home)/components/primitives';
import { StarButton } from '@/app/(home)/components/star-cta';
import { Logo } from '@/components/logo';

import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

export function baseOptions({
    /**
     * The docs layout folds nav links into the sidebar, where the star card
     * already lives — two identical asks in one column. Pass `false` there.
     */
    starLink = true,
}: { starLink?: boolean } = {}): BaseLayoutProps {
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
            // Stands in for the plain `githubUrl` icon fumadocs would render —
            // same destination, but it carries the ask. Two GitHub links in one
            // nav would only split the click.
            ...(starLink
                ? ([
                      {
                          type: 'custom',
                          secondary: true,
                          children: (
                              <StarButton className="rounded-lg px-3 py-1.5 text-xs" />
                          ),
                      },
                  ] as const)
                : []),
        ],
    };
}

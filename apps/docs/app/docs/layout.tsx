import { StarCard } from '@/app/(home)/components/star-cta';
import { baseOptions } from '@/lib/layout.shared';
import { source } from '@/lib/source';

import { DocsLayout } from 'fumadocs-ui/layouts/docs';

export default function Layout({ children }: LayoutProps<'/docs'>) {
    return (
        <DocsLayout
            tree={source.getPageTree()}
            sidebar={{ footer: <StarCard /> }}
            {...baseOptions({ starLink: false })}
        >
            {children}
        </DocsLayout>
    );
}

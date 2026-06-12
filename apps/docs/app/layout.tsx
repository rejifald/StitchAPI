import './global.css';

import { siteUrl } from '@/lib/shared';

import 'fumadocs-twoslash/twoslash.css';
import { Banner } from 'fumadocs-ui/components/banner';
import { RootProvider } from 'fumadocs-ui/provider/next';
import { Construction } from 'lucide-react';
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';

const inter = Inter({
    subsets: ['latin'],
});

export const metadata: Metadata = {
    metadataBase: new URL(siteUrl),
};

export default function Layout({ children }: LayoutProps<'/'>) {
    return (
        <html lang="en" className={inter.className} suppressHydrationWarning>
            <body className="flex flex-col min-h-screen">
                <RootProvider>
                    <Banner
                        variant="normal"
                        className="gap-2 border-b border-stitch-border bg-stitch-soft text-fd-foreground"
                    >
                        <Construction
                            className="size-4 shrink-0 text-stitch-strong"
                            aria-hidden
                        />
                        <span>
                            <span className="font-semibold text-stitch-strong">
                                Under heavy development
                            </span>
                            <span className="hidden text-fd-muted-foreground sm:inline">
                                {' '}
                                — APIs, packages, and docs are changing fast and
                                may break without notice.
                            </span>
                        </span>
                    </Banner>
                    {children}
                </RootProvider>
            </body>
        </html>
    );
}

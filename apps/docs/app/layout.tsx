import './global.css';

import { siteUrl } from '@/lib/shared';

import 'fumadocs-twoslash/twoslash.css';
import { Banner } from 'fumadocs-ui/components/banner';
import { RootProvider } from 'fumadocs-ui/provider/next';
import { Construction } from 'lucide-react';
import type { Metadata } from 'next';
import {
    Hanken_Grotesk,
    IBM_Plex_Mono,
    Schibsted_Grotesk,
} from 'next/font/google';

/* Signal type system — display / body / mono (Brand & Color System). */
const fontDisplay = Schibsted_Grotesk({
    subsets: ['latin'],
    weight: ['400', '500', '600', '700', '800', '900'],
    variable: '--font-schibsted',
    display: 'swap',
});
const fontSans = Hanken_Grotesk({
    subsets: ['latin'],
    weight: ['400', '500', '600', '700'],
    variable: '--font-hanken',
    display: 'swap',
});
const fontMono = IBM_Plex_Mono({
    subsets: ['latin'],
    weight: ['400', '500', '600', '700'],
    variable: '--font-ibm-plex-mono',
    display: 'swap',
});

const fontVariables = `${fontDisplay.variable} ${fontSans.variable} ${fontMono.variable}`;

export const metadata: Metadata = {
    metadataBase: new URL(siteUrl),
};

export default function Layout({ children }: LayoutProps<'/'>) {
    return (
        <html lang="en" className={fontVariables} suppressHydrationWarning>
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
                                Release candidate — 1.0.0-rc.1
                            </span>
                            <span className="hidden text-fd-muted-foreground sm:inline">
                                {' '}
                                · feature-complete and in real use; APIs are
                                stabilizing ahead of stable 1.0 — pin exact
                                versions.
                            </span>
                        </span>
                    </Banner>
                    {children}
                </RootProvider>
            </body>
        </html>
    );
}

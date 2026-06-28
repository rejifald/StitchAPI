import './global.css';

import { jsonLdHtml } from '@/lib/json-ld';
import { appName, gitConfig, siteUrl } from '@/lib/shared';

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

const defaultTitle =
    'StitchAPI — turn any API into a typed, resilient function';
const defaultDescription =
    'Turn any API into a typed, resilient function. Declare an endpoint once — its types, auth, retries, throttling, validation, and drift detection — and call it like a local function from your code, the CLI, an HTTP route, or as an MCP tool. No server, no codegen, zero dependencies.';

export const metadata: Metadata = {
    metadataBase: new URL(siteUrl),
    title: {
        default: defaultTitle,
        template: '%s — StitchAPI',
    },
    description: defaultDescription,
    applicationName: appName,
    keywords: [
        'StitchAPI',
        'API client',
        'typed API client',
        'TypeScript API client',
        'HTTP client',
        'REST client',
        'GraphQL client',
        'fetch wrapper',
        'API integration',
        'resilient API',
        'retry',
        'rate limiting',
        'circuit breaker',
        'schema validation',
        'drift detection',
        'Zod',
        'Standard Schema',
        'agent-native',
        'AI agent tools',
        'MCP',
        'Model Context Protocol',
        'LLM tools',
        'OpenAPI alternative',
    ],
    authors: [{ name: 'Oleksandr Zhuravlov', url: siteUrl }],
    creator: 'Oleksandr Zhuravlov',
    publisher: appName,
    category: 'technology',
    openGraph: {
        type: 'website',
        url: siteUrl,
        siteName: appName,
        locale: 'en_US',
        title: defaultTitle,
        description: defaultDescription,
        images: '/og/home',
    },
    twitter: {
        card: 'summary_large_image',
        title: defaultTitle,
        description: defaultDescription,
        images: '/og/home',
    },
    robots: {
        index: true,
        follow: true,
        googleBot: {
            index: true,
            follow: true,
            'max-image-preview': 'large',
            'max-snippet': -1,
            'max-video-preview': -1,
        },
    },
};

/* Structured data — lets search engines model StitchAPI as a developer tool
   (rich results / knowledge panel) rather than an anonymous docs page. */
const jsonLd = [
    {
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        name: appName,
        url: siteUrl,
        description: defaultDescription,
    },
    {
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: appName,
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Node.js, Deno, Bun, browsers, edge runtimes',
        description: defaultDescription,
        url: siteUrl,
        downloadUrl: 'https://www.npmjs.com/package/stitchapi',
        codeRepository: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
        license: 'https://www.apache.org/licenses/LICENSE-2.0',
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        author: { '@type': 'Person', name: 'Oleksandr Zhuravlov' },
    },
];

export default function Layout({ children }: LayoutProps<'/'>) {
    return (
        <html lang="en" className={fontVariables} suppressHydrationWarning>
            <body className="flex flex-col min-h-screen">
                <script
                    type="application/ld+json"
                    dangerouslySetInnerHTML={{ __html: jsonLdHtml(jsonLd) }}
                />
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

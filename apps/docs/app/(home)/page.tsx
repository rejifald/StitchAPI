import { AgentNative } from './components/agent-native';
import { Cta, Footer } from './components/cta';
import { Differentiator } from './components/differentiator';
import { Features } from './components/features';
import { Hero } from './components/hero';
import { Metrics } from './components/metrics';
import { NotThis } from './components/not-this';
import { Problem } from './components/problem';
import { Surfaces } from './components/surfaces';

import { appName } from '@/lib/shared';

import type { Metadata } from 'next';

const title = 'StitchAPI — turn any API into a typed, resilient function';
const description =
    'API stitching: declare an endpoint once — its types, auth, and resilience — and call it like a local function. No server, no codegen, no config files. The same definition runs from code, the CLI, an HTTP route, or as an MCP tool.';

export const metadata: Metadata = {
    // `absolute` opts out of the root `%s — StitchAPI` template — the home
    // title already leads with the brand, so templating would double it.
    title: { absolute: title },
    description,
    alternates: { canonical: '/' },
    openGraph: {
        type: 'website',
        url: '/',
        siteName: appName,
        title,
        description,
        images: '/og/home',
    },
    twitter: {
        card: 'summary_large_image',
        title,
        description,
        images: '/og/home',
    },
};

export default function HomePage() {
    return (
        <main className="flex flex-1 flex-col">
            <Hero />
            <AgentNative />
            <Metrics />
            <Problem />
            <Surfaces />
            <Features />
            <NotThis />
            <Differentiator />
            <Cta />
            <Footer />
        </main>
    );
}
